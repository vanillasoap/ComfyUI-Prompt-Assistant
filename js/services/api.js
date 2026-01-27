/**
 * API Service
 * Calls third-party services through backend API proxy to protect API key security
 */

import { logger } from '../utils/logger.js';

// AbortController storage for in-progress requests
const runningRequests = new Map();

// ---Base route inference logic---
// Automatically obtain the current plugin's mount point, eliminating hardcoded paths
// Parse the current script's URL to extract the directory name after extensions/
let apiBaseUrl = null;

function getDynamicApiBase() {
    if (apiBaseUrl) return apiBaseUrl;

    try {
        const scriptUrl = import.meta.url;
        const url = new URL(scriptUrl);
        const pathParts = url.pathname.split('/');

        // Strategy 1: Find the /js/ directory segment and use its preceding segment as the plugin name (most universal)
        const jsIdx = pathParts.indexOf('js');
        if (jsIdx > 0) {
            const nodeDir = pathParts[jsIdx - 1];
            apiBaseUrl = `/${nodeDir}/api`;
        }
        // Strategy 2: Fallback to searching for the extensions keyword (ComfyUI standard structure)
        else {
            const extIdx = pathParts.indexOf('extensions');
            if (extIdx !== -1 && pathParts.length > extIdx + 1) {
                const nodeDir = pathParts[extIdx + 1];
                apiBaseUrl = `/${nodeDir}/api`;
            } else {
                // Strategy 3: Hardcoded fallback
                apiBaseUrl = '/prompt-assistant/api';
            }
        }
    } catch (e) {
        apiBaseUrl = '/prompt-assistant/api';
    }
    return apiBaseUrl;
}

class APIService {
    /**
     * Get dynamic API base path
     * Exposes the module-level getDynamicApiBase function for external use
     */
    static getDynamicApiBase() {
        return getDynamicApiBase();
    }

    /**
     * Build the full API URL
     */
    static getApiUrl(path) {
        // Get the dynamic base route (e.g., /comfyui_prompt_assistant/api)
        const baseApi = getDynamicApiBase();

        // Ensure path does not contain duplicate prefixes and is properly formatted
        let subPath = path.startsWith('/') ? path : `/${path}`;

        // If path already contains baseApi, do not add it again
        const fullPath = subPath.startsWith(baseApi) ? subPath : `${baseApi}${subPath}`;

        const url = `${window.location.origin}${fullPath}`;
        // logger.debug(`Build API URL: ${url}`);
        return url;
    }

    /**
     * Parse a JSON array in the form [{"id":0,"text":"..."}, ...]
     * Returns Map<id, text>
     */
    static _extractIndexedTranslations(text) {
        const arr = APIService._extractJsonArray(text);
        if (!Array.isArray(arr)) return null;
        const map = new Map();
        for (const item of arr) {
            if (!item || typeof item !== 'object') return null;
            if (!('id' in item) || !('text' in item)) return null;
            map.set(Number(item.id), String(item.text ?? ''));
        }
        return map;
    }

    /**
     * Structured batch translation (pure frontend wrapper, single LLM request)
     * Requires the model to strictly return a JSON array in one-to-one correspondence with the input texts
     */
    static async llmBatchTranslate(texts, from = 'auto', to = 'zh', request_id = null) {
        try {
            if (!Array.isArray(texts) || texts.length === 0) {
                throw new Error('Translation text array cannot be empty');
            }

            // Build structured instructions using indices, requiring strict JSON object array output
            const indexed = texts.map((t, i) => ({ id: i, text: t }));
            // Enhanced prompt: explicitly forbid Markdown table format and '|' prefix in translations
            const sysHint = `You are a professional translation API. Please translate the text fields in the input JSON array from ${from} to ${to}.
            Rules:
            1. Keep the JSON structure unchanged, return an array containing id and text.
            2. Do not use Markdown table format, do not add '|' symbols before translations.
            3. For parameter names and variable names (e.g., snake_case format), translate them into their meaning in the target language (e.g., pose_images -> pose images), unless they are proper nouns (e.g., CLIP, VAE).
            4. Keep the array length consistent with the input.
            5. Output JSON directly, do not include Markdown code block markers (e.g., \`\`\`json).`;

            const payload = { segments: indexed };
            const prompt = [
                sysHint,
                'Input: ' + JSON.stringify(payload)
            ].join('\n');

            // Reuse single-text interface
            const res = await this.llmTranslate(prompt, from, to, request_id);
            if (!res || !res.success) {
                return { success: false, error: res?.error || 'Batch translation failed' };
            }

            const content = (res.data && (res.data.translated || res.data.expanded || res.data.content)) || res.translated || res.content || '';
            // Parse into index mapping
            let mapped = APIService._extractIndexedTranslations(content);
            if (!mapped) {
                // Fallback: try parsing as a plain string array and align by order
                const arr = APIService._extractJsonArray(content);
                if (Array.isArray(arr) && arr.length === texts.length) {
                    mapped = new Map(arr.map((v, i) => [i, v]));
                }
            }

            if (!mapped) {
                return { success: false, error: 'Failed to parse batch translation: no valid JSON detected' };
            }

            // If items are missing, make individual recovery calls for missing indices to avoid total failure
            const translations = new Array(texts.length).fill("");
            const missingIdx = [];
            for (let i = 0; i < texts.length; i++) {
                if (mapped.has(i)) {
                    translations[i] = mapped.get(i);
                } else {
                    missingIdx.push(i);
                }
            }

            if (missingIdx.length > 0) {
                for (const i of missingIdx) {
                    const single = await this.llmTranslate(texts[i], from, to, request_id);
                    if (single && single.success) {
                        translations[i] = (single.data && single.data.translated) || '';
                    } else {
                        translations[i] = '';
                    }
                }
            }

            return { success: true, data: { translations } };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Parallel chunked batch translation (optimized version)
     * Splits text array into chunks and sends multiple translation requests in parallel, significantly improving speed
     *
     * @param {string[]} texts - Array of texts to translate
     * @param {string} from - Source language
     * @param {string} to - Target language
     * @param {Object} options - Configuration options
     * @param {number} options.chunkSize - Number of texts per chunk (default 5)
     * @param {number} options.concurrency - Maximum concurrency (default 3)
     * @param {Function} options.onProgress - Progress callback (completedChunks, totalChunks)
     * @returns {Promise<{success: boolean, data?: {translations: string[]}, error?: string}>}
     */
    static async llmParallelBatchTranslate(texts, from = 'auto', to = 'zh', options = {}) {
        const { chunkSize = 5, concurrency = 3, onProgress = null } = options;

        try {
            if (!Array.isArray(texts) || texts.length === 0) {
                throw new Error('Translation text array cannot be empty');
            }

            // 1. Split into chunks
            const chunks = [];
            for (let i = 0; i < texts.length; i += chunkSize) {
                chunks.push({
                    startIndex: i,
                    texts: texts.slice(i, i + chunkSize)
                });
            }

            logger.log(`[APIService] Parallel chunked translation | Total texts:${texts.length} | Chunks:${chunks.length} | Per chunk:${chunkSize} | Concurrency:${concurrency}`);

            // 2. Create result array
            const allTranslations = new Array(texts.length).fill('');
            let completedChunks = 0;
            let hasError = false;
            let lastError = null;

            // 3. Concurrency control function
            const translateChunk = async (chunk) => {
                try {
                    const result = await this.llmBatchTranslate(chunk.texts, from, to);

                    if (result.success && result.data && result.data.translations) {
                        // Fill translation results into corresponding positions
                        result.data.translations.forEach((translation, idx) => {
                            allTranslations[chunk.startIndex + idx] = translation || '';
                        });
                    } else {
                        // Single chunk failed, log but do not interrupt
                        hasError = true;
                        lastError = result.error || 'Translation failed';
                        logger.warn(`[APIService] Chunk translation failed | Start index:${chunk.startIndex} | Error:${lastError}`);
                    }
                } catch (err) {
                    hasError = true;
                    lastError = err.message;
                    logger.error(`[APIService] Chunk translation error | Start index:${chunk.startIndex} | Error:${err.message}`);
                } finally {
                    completedChunks++;
                    if (onProgress) {
                        onProgress(completedChunks, chunks.length);
                    }
                }
            };

            // 4. Execute batches in parallel (control max concurrency)
            for (let i = 0; i < chunks.length; i += concurrency) {
                const batch = chunks.slice(i, i + concurrency);
                await Promise.all(batch.map(chunk => translateChunk(chunk)));
            }

            // 5. Check results
            const successCount = allTranslations.filter(t => t && t.trim()).length;
            logger.log(`[APIService] Parallel translation complete | Success:${successCount}/${texts.length}`);

            // Return success even if some failed (as long as there are translation results)
            if (successCount === 0 && texts.length > 0) {
                return { success: false, error: lastError || 'All text translations failed' };
            }

            return { success: true, data: { translations: allTranslations } };

        } catch (error) {
            logger.error(`[APIService] Parallel batch translation failed: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * Extract and parse the first JSON array from a string
     */
    static _extractJsonArray(text) {
        if (!text) return null;
        try {
            // Fast path: the entire string is a JSON array
            if (text.trim().startsWith('[')) {
                return JSON.parse(text.trim());
            }
        } catch (_) { /* ignore */ }

        // Handle model-added prefix/suffix: find the first '[' and its matching ']'
        const first = text.indexOf('[');
        const last = text.lastIndexOf(']');
        if (first === -1 || last === -1 || last <= first) return null;
        const candidate = text.slice(first, last + 1);
        try {
            return JSON.parse(candidate);
        } catch (e) {
            // Try fixing full-width quotation marks
            const normalized = candidate.replace(/[“”]/g, '"');
            try { return JSON.parse(normalized); } catch { return null; }
        }
    }

    /**
     * Generate unique request ID
     */
    /**
     * Generate unique request ID
     * Format: requestType_serviceType(optional)_NodeID_fourDigitTimestamp
     */
    static generateRequestId(type, serviceType = null, nodeId = '0') {
        const timestamp = Math.floor(Date.now() / 1000).toString().slice(-4);
        const parts = [type];
        if (serviceType) {
            parts.push(serviceType);
        }
        parts.push(nodeId);
        parts.push(timestamp);
        return parts.join('_');
    }

    /**
     * Cancel an in-progress request
     */
    static async cancelRequest(requestId) {
        if (!requestId) return { success: false, error: "Missing requestId" };

        const controller = runningRequests.get(requestId);

        if (controller) {
            // 1. Abort the frontend fetch request
            controller.abort();
            runningRequests.delete(requestId);
            logger.debug(`Frontend request aborted | ID: ${requestId}`);
        }

        // 2. Notify backend to cancel the task
        try {
            const apiUrl = this.getApiUrl('request/cancel');
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ request_id: requestId })
            });
            const result = await response.json();
            logger.debug(`Backend task cancel request sent | ID: ${requestId} | Result: ${JSON.stringify(result)}`);
            return result;
        } catch (error) {
            logger.error(`Backend task cancel request failed | ID: ${requestId} | Error: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * Baidu Translate API
     */
    static async baiduTranslate(text, from = 'auto', to = 'zh', request_id = null, is_auto = false) {
        // Generate request ID
        // Generate request ID
        if (!request_id) {
            request_id = this.generateRequestId('trans', 'baidu');
        }

        const controller = new AbortController();
        const signal = controller.signal;
        runningRequests.set(request_id, controller);

        try {
            if (!text || text.trim() === '') {
                throw new Error('Translation text cannot be empty');
            }

            // Get API URL
            const apiUrl = this.getApiUrl('baidu/translate');

            // Call backend API
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    text,
                    from,
                    to,
                    request_id,
                    is_auto
                }),
                signal // Pass signal
            });

            const result = await response.json();
            return result;
        } catch (error) {
            if (error.name === 'AbortError') {
                logger.debug(`Baidu translate request aborted by user | ID: ${request_id}`);
                return { success: false, error: 'Request cancelled', cancelled: true };
            }
            return {
                success: false,
                error: error.message
            };
        } finally {
            // Remove from Map after request completes
            if (runningRequests.has(request_id)) {
                runningRequests.delete(request_id);
            }
        }
    }

    /**
     * Batch translation
     */
    static async batchBaiduTranslate(texts, from = 'auto', to = 'zh') {
        try {
            if (!Array.isArray(texts) || texts.length === 0) {
                throw new Error('Translation text array cannot be empty');
            }

            // Process each text translation sequentially
            const results = [];
            for (const text of texts) {
                const result = await this.baiduTranslate(text, from, to);
                results.push(result);
            }

            return results;
        } catch (error) {
            logger.error(`Batch translation | Result:failed | Error:${error.message}`);
            return [];
        }
    }

    /**
     * LLM prompt expansion
     */
    static async llmExpandPrompt(prompt, request_id = null) {
        // Generate request ID
        // Generate request ID
        if (!request_id) {
            request_id = this.generateRequestId('exp');
        }

        const controller = new AbortController();
        const signal = controller.signal;
        runningRequests.set(request_id, controller);

        try {
            if (!prompt || prompt.trim() === '') {
                throw new Error('Please enter a prompt to optimize');
            }

            logger.debug(`Initiating LLM prompt optimization request | Request ID:${request_id} | Original:${prompt}`);

            // Call backend API
            const apiUrl = this.getApiUrl('llm/expand');
            logger.debug('LLM prompt optimization API URL:', apiUrl);

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    prompt,
                    request_id
                }),
                signal // Pass signal
            });

            const result = await response.json();
            logger.debug(`LLM prompt optimization request succeeded | Request ID:${request_id} | Result:${JSON.stringify(result)}`);

            return result;
        } catch (error) {
            if (error.name === 'AbortError') {
                logger.debug(`LLM prompt optimization request aborted by user | ID: ${request_id}`);
                return { success: false, error: 'Request cancelled', cancelled: true };
            }
            logger.error(`LLM prompt optimization request failed | Request ID:${request_id || 'unknown'} | Error:${error.message}`);
            return {
                success: false,
                error: error.message
            };
        } finally {
            // Remove from Map after request completes
            if (runningRequests.has(request_id)) {
                runningRequests.delete(request_id);
            }
        }
    }

    /**
     * LLM text translation
     */
    static async llmTranslate(text, from = 'auto', to = 'zh', request_id = null, is_auto = false) {
        // Generate request ID
        // Generate request ID
        if (!request_id) {
            request_id = this.generateRequestId('trans', 'llm');
        }

        const controller = new AbortController();
        const signal = controller.signal;
        runningRequests.set(request_id, controller);

        try {
            if (!text || text.trim() === '') {
                throw new Error('Please enter content to translate');
            }

            // Call backend API
            const apiUrl = this.getApiUrl('llm/translate');

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    text,
                    from,
                    to,
                    request_id,
                    is_auto
                }),
                signal // Pass signal
            });

            const result = await response.json();
            return result;
        } catch (error) {
            if (error.name === 'AbortError') {
                logger.debug(`LLM translation request aborted by user | ID: ${request_id}`);
                return { success: false, error: 'Request cancelled', cancelled: true };
            }
            return {
                success: false,
                error: error.message
            };
        } finally {
            // Remove from Map after request completes
            if (runningRequests.has(request_id)) {
                runningRequests.delete(request_id);
            }
        }
    }

    /**
     * Call vision model to analyze image
     */
    static async llmAnalyzeImage(imageData, prompt, request_id = null) {
        // Generate request ID
        // Generate request ID
        if (!request_id) {
            request_id = this.generateRequestId('icap');
        }

        const controller = new AbortController();
        const signal = controller.signal;
        runningRequests.set(request_id, controller);

        try {
            if (!imageData) {
                throw new Error('No valid image found');
            }

            logger.debug(`Initiating vision analysis request | Request ID:${request_id}`);

            // Build API URL
            const apiUrl = this.getApiUrl('vlm/analyze');
            logger.debug('Vision analysis API URL:', apiUrl);

            // Build request data
            const requestData = {
                image: imageData,
                prompt: prompt, // Add prompt
                request_id: request_id
            };

            // Send request
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestData),
                signal // Pass signal
            });

            // Parse response
            const result = await response.json();
            logger.debug(`Vision analysis request complete | Request ID:${request_id}`);

            return result;
        } catch (error) {
            if (error.name === 'AbortError') {
                logger.debug(`Vision analysis request aborted by user | ID: ${request_id}`);
                return { success: false, error: 'Request cancelled', cancelled: true };
            }
            logger.error(`Vision analysis request failed | Request ID:${request_id || 'unknown'} | Error:${error.message}`);
            return {
                success: false,
                error: error.message || 'Request failed'
            };
        } finally {
            // Remove from Map after request completes
            if (runningRequests.has(request_id)) {
                runningRequests.delete(request_id);
            }
        }
    }

    // ---Streaming API methods (SSE)---

    /**
     * Streaming vision image analysis
     * Receive analysis results token by token via SSE
     * @param {string} imageData - Base64 encoded image data
     * @param {string} prompt - Analysis prompt
     * @param {string} request_id - Request ID
     * @param {Function} onChunk - Callback function to receive each chunk
     * @returns {Promise<Object>} - Complete analysis result
     */
    static async llmAnalyzeImageStream(imageData, prompt, request_id = null, onChunk = null) {
        if (!request_id) {
            request_id = this.generateRequestId('icap');
        }

        const controller = new AbortController();
        const signal = controller.signal;
        runningRequests.set(request_id, controller);

        try {
            if (!imageData) {
                throw new Error('No valid image found');
            }

            logger.debug(`Initiating streaming vision analysis request | Request ID:${request_id}`);

            const apiUrl = this.getApiUrl('vlm/analyze/stream');
            const requestData = {
                image: imageData,
                prompt: prompt,
                request_id: request_id
            };

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestData),
                signal
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let finalResult = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.chunk && onChunk) {
                                onChunk(data.chunk);
                            }
                            if (data.done) {
                                finalResult = data.result;
                            }
                            if (data.error) {
                                throw new Error(data.error);
                            }
                        } catch (parseError) {
                            if (parseError.message !== 'Unexpected end of JSON input') {
                                logger.warn(`Failed to parse SSE data: ${parseError.message}`);
                            }
                        }
                    }
                }
            }

            logger.debug(`Streaming vision analysis request complete | Request ID:${request_id}`);
            return finalResult;

        } catch (error) {
            if (error.name === 'AbortError') {
                logger.debug(`Streaming vision analysis request aborted by user | ID: ${request_id}`);
                return { success: false, error: 'Request cancelled', cancelled: true };
            }
            logger.error(`Streaming vision analysis request failed | Request ID:${request_id || 'unknown'} | Error:${error.message}`);
            return { success: false, error: error.message || 'Request failed' };
        } finally {
            if (runningRequests.has(request_id)) {
                runningRequests.delete(request_id);
            }
        }
    }

    /**
     * Streaming LLM prompt expansion
     * Receive expansion results token by token via SSE
     * @param {string} prompt - The prompt to expand
     * @param {string} request_id - Request ID
     * @param {Function} onChunk - Callback function to receive each chunk
     * @returns {Promise<Object>} - Complete expansion result
     */
    static async llmExpandPromptStream(prompt, request_id = null, onChunk = null) {
        if (!request_id) {
            request_id = this.generateRequestId('exp');
        }

        const controller = new AbortController();
        const signal = controller.signal;
        runningRequests.set(request_id, controller);

        try {
            if (!prompt || prompt.trim() === '') {
                throw new Error('Please enter a prompt to optimize');
            }

            logger.debug(`Initiating streaming LLM prompt optimization request | Request ID:${request_id}`);

            const apiUrl = this.getApiUrl('llm/expand/stream');

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, request_id }),
                signal
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let finalResult = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.chunk && onChunk) {
                                onChunk(data.chunk);
                            }
                            if (data.done) {
                                finalResult = data.result;
                            }
                            if (data.error) {
                                throw new Error(data.error);
                            }
                        } catch (parseError) {
                            if (parseError.message !== 'Unexpected end of JSON input') {
                                logger.warn(`Failed to parse SSE data: ${parseError.message}`);
                            }
                        }
                    }
                }
            }

            logger.debug(`Streaming LLM prompt optimization request complete | Request ID:${request_id}`);
            return finalResult;

        } catch (error) {
            if (error.name === 'AbortError') {
                logger.debug(`Streaming LLM prompt optimization request aborted by user | ID: ${request_id}`);
                return { success: false, error: 'Request cancelled', cancelled: true };
            }
            logger.error(`Streaming LLM prompt optimization request failed | Request ID:${request_id || 'unknown'} | Error:${error.message}`);
            return { success: false, error: error.message };
        } finally {
            if (runningRequests.has(request_id)) {
                runningRequests.delete(request_id);
            }
        }
    }

    /**
     * Streaming LLM translation
     * Receive translation results token by token via SSE
     * Note: Only supports LLM translation service; Baidu Translate does not support streaming
     * @param {string} text - Text to translate
     * @param {string} fromLang - Source language
     * @param {string} toLang - Target language
     * @param {string} request_id - Request ID
     * @param {Function} onChunk - Callback function to receive each chunk
     * @returns {Promise<Object>} - Complete translation result
     */
    static async llmTranslateStream(text, fromLang, toLang, request_id = null, onChunk = null) {
        if (!request_id) {
            request_id = this.generateRequestId('trans');
        }

        const controller = new AbortController();
        const signal = controller.signal;
        runningRequests.set(request_id, controller);

        try {
            if (!text || text.trim() === '') {
                throw new Error('Please enter content to translate');
            }

            logger.debug(`Initiating streaming LLM translation request | Request ID:${request_id} | ${fromLang}->${toLang}`);

            const apiUrl = this.getApiUrl('llm/translate/stream');

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text,
                    from: fromLang,
                    to: toLang,
                    request_id
                }),
                signal
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let finalResult = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.chunk && onChunk) {
                                onChunk(data.chunk);
                            }
                            if (data.done) {
                                finalResult = data.result;
                            }
                            if (data.error) {
                                throw new Error(data.error);
                            }
                        } catch (parseError) {
                            if (parseError.message !== 'Unexpected end of JSON input') {
                                logger.warn(`Failed to parse SSE data: ${parseError.message}`);
                            }
                        }
                    }
                }
            }

            logger.debug(`Streaming LLM translation request complete | Request ID:${request_id}`);
            return finalResult;

        } catch (error) {
            if (error.name === 'AbortError') {
                logger.debug(`Streaming LLM translation request aborted by user | ID: ${request_id}`);
                return { success: false, error: 'Request cancelled', cancelled: true };
            }
            logger.error(`Streaming LLM translation request failed | Request ID:${request_id || 'unknown'} | Error:${error.message}`);
            return { success: false, error: error.message };
        } finally {
            if (runningRequests.has(request_id)) {
                runningRequests.delete(request_id);
            }
        }
    }

    /**
     * Convert image to Base64
     */
    static async imageToBase64(img) {
        return new Promise((resolve, reject) => {
            try {
                if (!img) {
                    reject('Invalid image');
                    return;
                }

                // If already a base64 string, return directly
                if (typeof img === 'string' && img.startsWith('data:image')) {
                    resolve(img);
                    return;
                }

                // If it's a Blob object
                if (img instanceof Blob) {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(img);
                    return;
                }

                // If it's a URL
                if (typeof img === 'string' && (img.startsWith('http') || img.startsWith('/'))) {
                    const image = new Image();
                    image.crossOrigin = 'Anonymous';
                    image.onload = () => {
                        const canvas = document.createElement('canvas');
                        canvas.width = image.width;
                        canvas.height = image.height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(image, 0, 0);
                        resolve(canvas.toDataURL('image/jpeg'));
                    };
                    image.onerror = () => reject('Image loading failed');
                    image.src = img;
                    return;
                }

                // Handle ComfyUI image object
                if (img && typeof img === 'object' && img.src) {
                    // If the image object has a src property, use it
                    const image = new Image();
                    image.crossOrigin = 'Anonymous';
                    image.onload = () => {
                        const canvas = document.createElement('canvas');
                        canvas.width = image.width;
                        canvas.height = image.height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(image, 0, 0);
                        resolve(canvas.toDataURL('image/jpeg'));
                    };
                    image.onerror = (e) => {
                        console.error('Image loading failed:', e);
                        reject('Image loading failed');
                    };
                    image.src = img.src;
                    return;
                }

                // Handle HTMLImageElement or similar objects
                if (img && (img instanceof HTMLImageElement || (img.width && img.height && img.complete))) {
                    try {
                        const canvas = document.createElement('canvas');
                        canvas.width = img.width;
                        canvas.height = img.height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0);
                        resolve(canvas.toDataURL('image/jpeg'));
                        return;
                    } catch (e) {
                        console.warn('Failed to convert image using canvas:', e);
                        // Continue trying other methods
                    }
                }

                // Handle ComfyUI special format (dataURL cached in node)
                if (img && img.dataURL) {
                    resolve(img.dataURL);
                    return;
                }

                // Handle ComfyUI special image data format
                if (img && img.data && img.width && img.height) {
                    try {
                        const canvas = document.createElement('canvas');
                        canvas.width = img.width;
                        canvas.height = img.height;
                        const ctx = canvas.getContext('2d');
                        const imageData = new ImageData(
                            new Uint8ClampedArray(img.data.buffer || img.data),
                            img.width,
                            img.height
                        );
                        ctx.putImageData(imageData, 0, 0);
                        resolve(canvas.toDataURL('image/jpeg'));
                        return;
                    } catch (e) {
                        console.error('Failed to process image data:', e);
                    }
                }

                console.error('Unsupported image format', img);
                reject('Unsupported image format');
            } catch (error) {
                console.error('Error converting image:', error);
                reject(error);
            }
        });
    }
}

export { APIService }; 