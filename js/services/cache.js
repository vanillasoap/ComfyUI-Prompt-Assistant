/**
 * Local Cache Service Module
 * Unified management of local caching for history records and tags
 */

import { logger } from '../utils/logger.js';
import { PromptFormatter } from "../utils/promptFormatter.js";

// ---Cache Configuration---
const CACHE_CONFIG = {
    // Unified prefix
    GLOBAL_PREFIX: "PromptAssistant_",

    // History cache configuration
    HISTORY_CACHE_KEY: "PromptAssistant_history_cache_all",
    MAX_HISTORY_PER_NODE: 20,  // Maximum history entries per node
    MAX_HISTORY_GLOBAL: 100,   // Maximum global history entries
    MAX_CONTENT_LENGTH: 5000,  // Maximum length per history entry

    // Tag cache configuration
    TAG_CACHE_KEY: "PromptAssistant_tag_cache_all",
    MAX_TAGS_PER_INPUT: 100,    // Maximum tags per input field
    MAX_TAGS_GLOBAL: 500,      // Maximum global tags

    // Translation cache configuration
    TRANSLATE_CACHE_KEY: "PromptAssistant_translate_cache",
    MAX_TRANSLATE_CACHE: 200,  // Maximum translation cache entries
};

/**
 * General Cache Service
 * Provides basic cache operation methods
 */
class CacheService {
    /**
     * Get data from localStorage
     */
    static get(key) {
        try {
            const data = localStorage.getItem(key);
            return data ? JSON.parse(data) : null;
        } catch (error) {
            logger.error(`Cache Service | Read failed | Key:${key} | Error:${error.message}`);
            return null;
        }
    }

    /**
     * Store data to localStorage
     */
    static set(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (error) {
            logger.error(`Cache Service | Write failed | Key:${key} | Error:${error.message}`);
            return false;
        }
    }

    /**
     * Delete data from localStorage
     */
    static remove(key) {
        try {
            localStorage.removeItem(key);
        } catch (error) {
            logger.error(`Cache Service | Delete failed | Key:${key} | Error:${error.message}`);
        }
    }

    /**
     * Clear all caches with a specified prefix
     */
    static clearByPrefix(prefix) {
        try {
            const keysToRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith(prefix)) {
                    keysToRemove.push(key);
                }
            }
            keysToRemove.forEach(key => this.remove(key));
            // logger.debug(`Cache Service | Clear prefix cache | Prefix:${prefix} | Count:${keysToRemove.length}`);
        } catch (error) {
            logger.error(`Cache Service | Clear prefix cache failed | Prefix:${prefix} | Error:${error.message}`);
        }
    }
}

/**
 * History Cache Service
 * Manages cache operations for history records
 */
class HistoryCacheService {
    // Undo/redo state tracking
    static undoStates = new Map(); // Format: { "nodeId_inputId": { currentIndex: number, records: array } }

    /**
     * Get all history records
     */
    static getAllHistory() {
        const key = CACHE_CONFIG.HISTORY_CACHE_KEY;
        return CacheService.get(key) || [];
    }

    /**
     * Save all history records
     */
    static saveAllHistory(history) {
        const key = CACHE_CONFIG.HISTORY_CACHE_KEY;
        CacheService.set(key, history);
    }

    /**
     * Get history record list
     */
    static getHistoryList({ nodeId = null, limit = 50, workflowId = null } = {}) {
        try {
            const allHistory = this.getAllHistory();

            let filteredHistory = allHistory;
            if (workflowId) {
                filteredHistory = allHistory.filter(item => item.workflow_id === workflowId);
            }

            // Ensure each history record has required fields
            const validHistory = filteredHistory.filter(item => {
                const isValid = item && item.node_id && item.input_id &&
                    item.content && item.timestamp && item.operation_type;
                if (!isValid) {
                    logger.debug(`History Cache | Skipping invalid record | Node:${item?.node_id}`);
                }
                return isValid;
            });

            if (!nodeId) {
                return validHistory
                    .sort((a, b) => b.timestamp - a.timestamp)
                    .slice(0, limit);
            }

            const currentNodeHistory = [];
            const otherNodesHistory = [];

            validHistory.forEach(item => {
                if (item.node_id === nodeId) {
                    currentNodeHistory.push(item);
                } else {
                    otherNodesHistory.push(item);
                }
            });

            currentNodeHistory.sort((a, b) => b.timestamp - a.timestamp);
            otherNodesHistory.sort((a, b) => b.timestamp - a.timestamp);

            return [...currentNodeHistory, ...otherNodesHistory].slice(0, limit);
        } catch (error) {
            logger.error(`History Cache | Get history failed | Error:${error.message}`);
            return [];
        }
    }

    /**
     * Get history records for a specific node and input field
     */
    static getInputHistory(nodeId, inputId, oldToNew = false) {
        try {
            const allHistory = this.getAllHistory();
            const workflowId = app.graph?._workflow_id;

            const filtered = allHistory.filter(item =>
                item.node_id === nodeId &&
                item.input_id === inputId &&
                (!workflowId || item.workflow_id === workflowId) // Match workflowId if available
            );
            // Sort based on parameter direction
            return filtered.sort((a, b) =>
                oldToNew ? a.timestamp - b.timestamp : b.timestamp - a.timestamp
            );
        } catch (error) {
            logger.error(`History Cache | Get input history failed | Node:${nodeId} | Input:${inputId} | Error:${error.message}`);
            return [];
        }
    }

    /**
     * Check if this is a repeated translation record
     */
    static isRepeatedTranslation(nodeId, inputId, content, operationType) {
        try {
            if (operationType !== 'translate') {
                return false;
            }

            // Get history records for this node and input field
            const history = this.getInputHistory(nodeId, inputId, false);
            if (!history || history.length === 0) {
                return false;
            }

            // Get the most recent record
            const lastRecord = history[0];
            if (!lastRecord || lastRecord.operation_type !== 'translate') {
                return false;
            }

            // Check if content matches
            const currentContent = content.trim();
            const lastContent = lastRecord.content.trim();

            // Query translation cache
            const cacheResult = TranslateCacheService.queryTranslateCache(currentContent);
            if (!cacheResult) {
                return false;
            }

            // Check if this is a source-translation or translation-source toggle
            if (cacheResult.type === 'source' && cacheResult.translatedText === lastContent) {
                return true;
            }
            if (cacheResult.type === 'translated' && cacheResult.sourceText === lastContent) {
                return true;
            }

            return false;
        } catch (error) {
            logger.error(`History Cache | Check repeated translation failed | Node:${nodeId} | Input:${inputId} | Error:${error.message}`);
            return false;
        }
    }

    /**
     * Add history record
     */
    static addHistory(historyItem) {
        try {
            // Validate required fields
            if (!historyItem.node_id || !historyItem.input_id || historyItem.content === undefined) {
                logger.error("History Cache | Add history failed | Missing required fields");
                return false;
            }

            // Skip recording if content is empty or whitespace only
            if (!historyItem.content || historyItem.content.trim() === '') {
                logger.debug(`History Cache | Skip adding | Node:${historyItem.node_id} | Reason:empty content`);
                return false;
            }

            // Content length limit
            let content = historyItem.content;
            if (content.length > CACHE_CONFIG.MAX_CONTENT_LENGTH) {
                content = content.substring(0, CACHE_CONFIG.MAX_CONTENT_LENGTH) + "...";
            }

            // Check if this is a repeated translation record
            if (this.isRepeatedTranslation(historyItem.node_id, historyItem.input_id, content, historyItem.operation_type)) {
                logger.debug(`History Cache | Skip adding | Node:${historyItem.node_id} | Reason:repeated translation record`);
                return false;
            }

            const allHistory = this.getAllHistory();

            // Get history records for the current node and input field
            const nodeHistory = allHistory.filter(item =>
                item.node_id === historyItem.node_id &&
                item.input_id === historyItem.input_id
            );

            // Check if content matches the most recent record
            if (nodeHistory.length > 0) {
                // Sort by timestamp descending, get the latest record
                const latestHistory = nodeHistory.sort((a, b) => b.timestamp - a.timestamp)[0];
                if (latestHistory.content === content) {
                    logger.debug(`History Cache | Skip adding | Node:${historyItem.node_id} | Reason:same as previous record`);
                    return false;
                }
            }

            // Create new history record
            const newItem = {
                workflow_id: app.graph?._workflow_id || 'unknown',
                node_id: historyItem.node_id,
                input_id: historyItem.input_id,
                content: content,
                operation_type: historyItem.operation_type || null,
                timestamp: Date.now() + 1, // Ensure unique timestamp
                request_id: historyItem.request_id || null
            };

            // Append to history records
            allHistory.push(newItem);

            // Limit history records per node
            const currentNodeHistory = allHistory.filter(item => item.node_id === historyItem.node_id);
            if (currentNodeHistory.length > CACHE_CONFIG.MAX_HISTORY_PER_NODE) {
                // Sort by timestamp
                currentNodeHistory.sort((a, b) => b.timestamp - a.timestamp);
                // Get the cutoff timestamp for records to keep
                const cutoffTimestamp = currentNodeHistory[CACHE_CONFIG.MAX_HISTORY_PER_NODE - 1].timestamp;
                // Remove old records
                const filteredHistory = allHistory.filter(item =>
                    item.node_id !== historyItem.node_id ||
                    item.timestamp >= cutoffTimestamp
                );
                allHistory.length = 0;
                allHistory.push(...filteredHistory);
            }

            // Limit global history record count
            if (allHistory.length > CACHE_CONFIG.MAX_HISTORY_GLOBAL) {
                // Sort by timestamp
                allHistory.sort((a, b) => b.timestamp - a.timestamp);
                allHistory.length = CACHE_CONFIG.MAX_HISTORY_GLOBAL;
            }

            this.saveAllHistory(allHistory);
            // logger.debug(`History Cache | Added history | Node:${historyItem.node_id} | Content length:${content.length}`);
            return true;
        } catch (error) {
            logger.error(`History Cache | Add history failed | Error:${error.message}`);
            return false;
        }
    }

    /**
     * Initialize undo state
     */
    static initUndoState(nodeId, inputId, currentContent) {
        try {
            const key = `${nodeId}_${inputId}`;

            // Get history records for this input field (old to new)
            const inputHistory = this.getInputHistory(nodeId, inputId, true);

            // Create undo state, pointing to the latest record
            const undoState = {
                currentIndex: inputHistory.length - 1, // Point to the last record
                currentContent: currentContent,    // Save current content
                lastHistoryTimestamp: inputHistory.length > 0 ? inputHistory[inputHistory.length - 1].timestamp : 0
            };

            // Update undo state
            this.undoStates.set(key, undoState);

            // logger.debug(`History Cache | Init undo state | Node:${nodeId} | Input:${inputId} | History count:${inputHistory.length} | Current position:${undoState.currentIndex}`);
        } catch (error) {
            logger.error(`History Cache | Init undo state failed | Node:${nodeId} | Input:${inputId} | Error:${error.message}`);
        }
    }

    /**
     * Perform undo operation
     */
    static undo(nodeId, inputId) {
        try {
            const key = `${nodeId}_${inputId}`;
            const state = this.undoStates.get(key);

            if (!state) {
                return null;
            }

            // Get history records (old to new)
            const history = this.getInputHistory(nodeId, inputId, true);

            // If no history records, return null
            if (history.length === 0) {
                return null;
            }

            // If already at the first record, cannot undo further
            if (state.currentIndex <= 0) {
                return null;
            }

            // Update current position
            state.currentIndex--;

            // Get content from history records
            const content = history[state.currentIndex]?.content || '';

            // Update state
            this.undoStates.set(key, state);

            // logger.debug(`History Cache | Undo operation | Node:${nodeId} | Input:${inputId} | Position:${state.currentIndex}/${history.length - 1} | Content:${content}`);
            return content;
        } catch (error) {
            logger.error(`History Cache | Undo operation failed | Node:${nodeId} | Input:${inputId} | Error:${error.message}`);
            return null;
        }
    }

    /**
     * Perform redo operation
     */
    static redo(nodeId, inputId) {
        try {
            const key = `${nodeId}_${inputId}`;
            const state = this.undoStates.get(key);

            if (!state) {
                return null;
            }

            // Get history records (old to new)
            const history = this.getInputHistory(nodeId, inputId, true);

            // If no history records, return null
            if (history.length === 0) {
                return null;
            }

            // If already at the last record, cannot redo
            if (state.currentIndex >= history.length - 1) {
                return null;
            }

            // Update current position
            state.currentIndex++;

            // Get content from history records
            const content = history[state.currentIndex]?.content || '';

            // Update state
            this.undoStates.set(key, state);

            logger.debug(`History Cache | Redo operation | Node:${nodeId} | Input:${inputId} | Position:${state.currentIndex}/${history.length - 1} | Content:${content}`);
            return content;
        } catch (error) {
            logger.error(`History Cache | Redo operation failed | Node:${nodeId} | Input:${inputId} | Error:${error.message}`);
            return null;
        }
    }

    /**
     * Check if undo is available
     */
    static canUndo(nodeId, inputId) {
        try {
            const key = `${nodeId}_${inputId}`;
            const state = this.undoStates.get(key);
            return state && state.currentIndex > 0;
        } catch (error) {
            logger.error(`History Cache | Check undo state failed | Node:${nodeId} | Input:${inputId} | Error:${error.message}`);
            return false;
        }
    }

    /**
     * Check if redo is available
     */
    static canRedo(nodeId, inputId) {
        try {
            const key = `${nodeId}_${inputId}`;
            const state = this.undoStates.get(key);
            if (!state) return false;

            const history = this.getInputHistory(nodeId, inputId, true);
            return state.currentIndex < history.length - 1;
        } catch (error) {
            logger.error(`History Cache | Check redo state failed | Node:${nodeId} | Input:${inputId} | Error:${error.message}`);
            return false;
        }
    }

    /**
     * Clear all history records
     */
    static clearAllHistory() {
        try {
            // Clear all history records
            this.saveAllHistory([]);
            // Clear all undo states
            this.undoStates.clear();
            // logger.debug("History Cache | Cleared all history");
        } catch (error) {
            logger.error(`History Cache | Clear all history failed | Error:${error.message}`);
        }
    }

    /**
     * Clear history records for a specific node
     */
    static clearNodeHistory(nodeId) {
        try {
            // Get all history records
            const allHistory = this.getAllHistory();

            // Filter out records not belonging to this node
            const filteredHistory = allHistory.filter(item => item.node_id !== nodeId);

            // Save filtered history records
            this.saveAllHistory(filteredHistory);

            // Clear undo states for this node
            for (const [key] of this.undoStates) {
                if (key.startsWith(nodeId + "_")) {
                    this.undoStates.delete(key);
                }
            }

            // logger.debug(`History Cache | Clear node history | Node:${nodeId}`);
        } catch (error) {
            logger.error(`History Cache | Clear node history failed | Node:${nodeId} | Error:${error.message}`);
        }
    }

    /**
     * Clear all history records for a specific workflow
     */
    static clearWorkflowHistory(workflowId) {
        if (!workflowId) return;
        try {
            const allHistory = this.getAllHistory();
            const filteredHistory = allHistory.filter(item => item.workflow_id !== workflowId);
            this.saveAllHistory(filteredHistory);
            // logger.debug(`History Cache | Clear workflow history | Workflow ID:${workflowId}`);
        } catch (error) {
            logger.error(`History Cache | Clear workflow history failed | Workflow ID:${workflowId} | Error:${error.message}`);
        }
    }

    /**
     * Add history record and update undo state
     */
    static addHistoryAndUpdateUndoState(nodeId, inputId, content, operationType = 'input') {
        // First attempt to add history record
        const success = this.addHistory({
            node_id: nodeId,
            input_id: inputId,
            content: content,
            operation_type: operationType,
            timestamp: Date.now()
        });

        if (success) {
            // Update undo state
            const key = `${nodeId}_${inputId}`;
            const state = this.undoStates.get(key) || {
                currentIndex: 0,
                currentContent: content,
                lastHistoryTimestamp: 0
            };

            // Get the latest history records
            const history = this.getInputHistory(nodeId, inputId, true);

            // Update state
            state.currentIndex = history.length - 1;
            state.currentContent = content;
            state.lastHistoryTimestamp = Date.now();

            // Save state
            this.undoStates.set(key, state);

            // logger.debug(`History Cache | Update undo state | Node:${nodeId} | Input:${inputId} | Position:${state.currentIndex}`);
        }

        return success;
    }

    /**
     * Get history record statistics
     */
    static getHistoryStats() {
        try {
            const allHistory = this.getAllHistory();
            const stats = {
                total: allHistory.length,
                byNode: {}
            };

            // Count by node
            allHistory.forEach(item => {
                if (!stats.byNode[item.node_id]) {
                    stats.byNode[item.node_id] = 0;
                }
                stats.byNode[item.node_id]++;
            });

            // logger.debug(`History Cache | Get stats | Total:${stats.total} | Node count:${Object.keys(stats.byNode).length}`);
            return stats;
        } catch (error) {
            logger.error(`History Cache | Get stats failed | Error:${error.message}`);
            return { total: 0, byNode: {} };
        }
    }

    /**
     * Update the operation type of a history record item
     */
    static updateHistoryItemType(nodeId, inputId, timestamp, newType) {
        try {
            // Get all history records
            const allHistory = this.getAllHistory();

            // Find the matching history record
            const itemIndex = allHistory.findIndex(item =>
                item.node_id === nodeId &&
                item.input_id === inputId &&
                item.timestamp === timestamp
            );

            // If a matching record is found, update its operation type
            if (itemIndex !== -1) {
                allHistory[itemIndex].operation_type = newType;

                // Save the updated history records
                this.saveAllHistory(allHistory);

                // logger.debug(`History Cache | Update operation type | Node:${nodeId} | Input:${inputId} | Type:${newType}`);
                return true;
            } else {
                // logger.debug(`History Cache | Update operation type failed | No matching record | Node:${nodeId} | Input:${inputId}`);
                return false;
            }
        } catch (error) {
            logger.error(`History Cache | Update operation type failed | Error:${error.message}`);
            return false;
        }
    }

    /**
     * Update a history record item
     */
    static updateHistoryItem(nodeId, inputId, timestamp, updates) {
        try {
            // Get all history records
            const allHistory = this.getAllHistory();

            // Find the matching history record
            const itemIndex = allHistory.findIndex(item =>
                item.node_id === nodeId &&
                item.input_id === inputId &&
                item.timestamp === timestamp
            );

            // If a matching record is found, update the specified fields
            if (itemIndex !== -1) {
                // Update all provided fields
                Object.assign(allHistory[itemIndex], updates);

                // Save the updated history records
                this.saveAllHistory(allHistory);

                logger.debug(`History Cache | Update record | Node:${nodeId} | Input:${inputId} | Fields:${Object.keys(updates).join(',')}`);
                return true;
            } else {
                logger.debug(`History Cache | Update failed | No matching record | Node:${nodeId} | Input:${inputId}`);
                return false;
            }
        } catch (error) {
            logger.error(`History Cache | Update record failed | Error:${error.message}`);
            return false;
        }
    }

    /**
     * Get related history records by request ID
     */
    static getHistoryByRequestId(requestId) {
        try {
            if (!requestId) return [];

            const allHistory = this.getAllHistory();
            return allHistory.filter(item =>
                item.request_id === requestId
            ).sort((a, b) => b.timestamp - a.timestamp);
        } catch (error) {
            logger.error(`History Cache | Get request-related history failed | Request ID:${requestId} | Error:${error.message}`);
            return [];
        }
    }
}

/**
 * Tag Cache Service
 * Manages cache operations for tags
 */
class TagCacheService {
    /**
     * Get or create tag formats
     */
    static getOrCreateFormats(rawTag) {
        return PromptFormatter.formatTag(rawTag);
    }

    /**
     * Get all tag cache
     */
    static getAllTagCache() {
        try {
            const data = CacheService.get(CACHE_CONFIG.TAG_CACHE_KEY);
            return data || {};
        } catch (error) {
            logger.error(`Tag Cache | Get all cache failed | Error:${error.message}`);
            return {};
        }
    }

    /**
     * Save all tag cache
     */
    static saveAllTagCache(cache) {
        try {
            CacheService.set(CACHE_CONFIG.TAG_CACHE_KEY, cache);
        } catch (error) {
            logger.error(`Tag Cache | Save all cache failed | Error:${error.message}`);
        }
    }

    /**
     * Get tag cache
     */
    static getTagCache(nodeId, inputId) {
        try {
            const allCache = this.getAllTagCache();
            const workflowId = app.graph?._workflow_id || 'unknown';
            const key = `${workflowId}_${nodeId}_${inputId}`;
            const data = allCache[key] || {};
            return new Map(Object.entries(data));
        } catch (error) {
            logger.error(`Tag Cache | Get cache failed | Node:${nodeId} | Input:${inputId} | Error:${error.message}`);
            return new Map();
        }
    }

    /**
     * Add tag to cache
     */
    static addTag(nodeId, inputId, rawTag, formats) {
        try {
            const allCache = this.getAllTagCache();
            const workflowId = app.graph?._workflow_id || 'unknown';
            const key = `${workflowId}_${nodeId}_${inputId}`;
            const cache = this.getTagCache(nodeId, inputId);

            // Ensure formats contain all necessary formats
            const format1 = formats.format1 || ` ${rawTag}`;
            const format2 = formats.format2 || ` ${rawTag},`;
            const format3 = formats.format3 || `, ${rawTag}`;
            const format4 = formats.format4 || `, ${rawTag},`;
            const insertedFormat = formats.insertedFormat || null;

            // If tag already exists, update directly
            if (cache.has(rawTag)) {
                cache.set(rawTag, {
                    format1,
                    format2,
                    format3,
                    format4,
                    insertedFormat
                });
                allCache[key] = Object.fromEntries(cache);
                this.saveAllTagCache(allCache);
                logger.debug(`Tag Cache | Update tag | Node:${nodeId} | Input:${inputId} | Tag:${rawTag}`);
                return true;
            }

            // Check tag count limit for current input field
            if (cache.size >= CACHE_CONFIG.MAX_TAGS_PER_INPUT) {
                // Get all tags and their last used time
                const tagEntries = Array.from(cache.entries()).map(([tag, formats]) => ({
                    tag,
                    formats,
                    lastUsed: formats.lastUsed || 0
                }));

                // Sort by last used time
                tagEntries.sort((a, b) => a.lastUsed - b.lastUsed);

                // Delete the oldest tag
                const oldestTag = tagEntries[0].tag;
                cache.delete(oldestTag);
                logger.debug(`Tag Cache | Auto eviction | Node:${nodeId} | Input:${inputId} | Evicted tag:${oldestTag}`);
            }

            // Check global tag count limit
            let totalTags = 0;
            const allTags = [];
            for (const [cacheKey, inputTags] of Object.entries(allCache)) {
                const [wfId, nId, iId] = cacheKey.split('_');
                for (const [tag, tagFormats] of Object.entries(inputTags)) {
                    allTags.push({
                        workflowId: wfId,
                        nodeId: nId,
                        inputId: iId,
                        tag,
                        lastUsed: tagFormats.lastUsed || 0
                    });
                }
                totalTags += Object.keys(inputTags).length;
            }

            if (totalTags >= CACHE_CONFIG.MAX_TAGS_GLOBAL) {
                // Sort by last used time
                allTags.sort((a, b) => a.lastUsed - b.lastUsed);

                // Delete the oldest tag
                const oldest = allTags[0];
                const oldKey = `${oldest.workflowId}_${oldest.nodeId}_${oldest.inputId}`;
                const oldCache = new Map(Object.entries(allCache[oldKey] || {}));
                oldCache.delete(oldest.tag);

                if (oldCache.size > 0) {
                    allCache[oldKey] = Object.fromEntries(oldCache);
                } else {
                    delete allCache[oldKey];
                }

                logger.debug(`Tag Cache | Auto eviction | Global limit | Evicted tag:${oldest.tag} | Location:${oldKey}`);
            }

            // Add new tag
            cache.set(rawTag, {
                format1,
                format2,
                format3,
                format4,
                insertedFormat,
                lastUsed: Date.now() // Add last used time
            });

            // Update global cache
            allCache[key] = Object.fromEntries(cache);
            this.saveAllTagCache(allCache);

            logger.debug(`Tag Cache | Add tag | Node:${nodeId} | Input:${inputId} | Tag:${rawTag}`);
            return true;
        } catch (error) {
            logger.error(`Tag Cache | Add tag failed | Node:${nodeId} | Input:${inputId} | Tag:${rawTag} | Error:${error.message}`);
            return false;
        }
    }

    /**
     * Remove tag from cache
     */
    static removeTag(nodeId, inputId, rawTag) {
        try {
            const allCache = this.getAllTagCache();
            const workflowId = app.graph?._workflow_id || 'unknown';
            const key = `${workflowId}_${nodeId}_${inputId}`;
            const cache = this.getTagCache(nodeId, inputId);

            const result = cache.delete(rawTag);
            if (result) {
                // Update global cache
                if (cache.size > 0) {
                    allCache[key] = Object.fromEntries(cache);
                } else {
                    delete allCache[key];
                }
                this.saveAllTagCache(allCache);
                logger.debug(`Tag Cache | Remove tag | Node:${nodeId} | Input:${inputId} | Tag:${rawTag}`);
            }
            return result;
        } catch (error) {
            logger.error(`Tag Cache | Remove tag failed | Node:${nodeId} | Input:${inputId} | Tag:${rawTag} | Error:${error.message}`);
            return false;
        }
    }

    /**
     * Check if tag exists in input field
     */
    static isTagInInput(nodeId, inputId, rawTag, inputValue) {
        try {
            const formats = this.getTagFormats(nodeId, inputId, rawTag);
            if (!formats) {
                return false;
            }

            // Check formats in priority order
            const checkOrder = ['insertedFormat', 'format4', 'format3', 'format2', 'format1'];

            for (const formatKey of checkOrder) {
                const format = formats[formatKey];
                if (format && inputValue.includes(format)) {
                    // logger.debug(`Tag Check | Result:exists | Node:${nodeId} | Input:${inputId} | Tag:${rawTag} | Matched format:${formatKey}`);
                    return true;
                }
            }

            return false;
        } catch (error) {
            logger.error(`Tag Check | Result:error | Node:${nodeId} | Input:${inputId} | Tag:${rawTag} | Error:${error.message}`);
            return false;
        }
    }

    /**
     * Get all formats for a tag
     */
    static getTagFormats(nodeId, inputId, rawTag) {
        try {
            const cache = this.getTagCache(nodeId, inputId);
            return cache.get(rawTag) || null;
        } catch (error) {
            logger.error(`Tag Cache | Get tag formats failed | Node:${nodeId} | Input:${inputId} | Tag:${rawTag} | Error:${error.message}`);
            return null;
        }
    }

    /**
     * Get the inserted format for a tag
     */
    static getInsertedFormat(nodeId, inputId, rawTag) {
        try {
            const formats = this.getTagFormats(nodeId, inputId, rawTag);
            return formats ? formats.insertedFormat : null;
        } catch (error) {
            logger.error(`Tag Cache | Get inserted format failed | Node:${nodeId} | Input:${inputId} | Tag:${rawTag} | Error:${error.message}`);
            return null;
        }
    }

    /**
     * Get all raw tags
     */
    static getAllRawTags(nodeId, inputId) {
        try {
            const cache = this.getTagCache(nodeId, inputId);
            return Array.from(cache.keys());
        } catch (error) {
            logger.error(`Tag Cache | Get all tags failed | Node:${nodeId} | Input:${inputId} | Error:${error.message}`);
            return [];
        }
    }

    /**
     * Clear tag cache
     */
    static clearCache(nodeId, inputId) {
        try {
            const allCache = this.getAllTagCache();
            const workflowId = app.graph?._workflow_id || 'unknown';
            const key = `${workflowId}_${nodeId}_${inputId}`;

            // Delete cache for the specified node
            if (allCache[key]) {
                delete allCache[key];
                this.saveAllTagCache(allCache);
            }

            // logger.debug(`Tag Cache | Clear cache | Node:${nodeId} | Input:${inputId}`);
        } catch (error) {
            logger.error(`Tag Cache | Clear cache failed | Node:${nodeId} | Input:${inputId} | Error:${error.message}`);
        }
    }

    /**
     * Get tag statistics
     */
    static getTagStats() {
        try {
            const allCache = this.getAllTagCache();
            let total = 0;
            const byNode = {};

            // Iterate all caches to calculate statistics
            for (const [key, tags] of Object.entries(allCache)) {
                const [workflowId, nodeId, inputId] = key.split('_');
                const count = Object.keys(tags).length;

                total += count;
                if (!byNode[nodeId]) {
                    byNode[nodeId] = {};
                }
                byNode[nodeId][inputId] = count;
            }

            const stats = { total, byNode };
            // logger.debug(`Tag Cache | Get stats | Total:${total} | Node count:${Object.keys(byNode).length}`);
            return stats;
        } catch (error) {
            logger.error(`Tag Cache | Get stats failed | Error:${error.message}`);
            return { total: 0, byNode: {} };
        }
    }

    /**
     * Update the inserted format for a tag
     */
    static updateInsertedFormat(nodeId, inputId, rawTag, insertedFormat) {
        try {
            const allCache = this.getAllTagCache();
            const workflowId = app.graph?._workflow_id || 'unknown';
            const key = `${workflowId}_${nodeId}_${inputId}`;
            const cache = this.getTagCache(nodeId, inputId);
            const formats = cache.get(rawTag);

            if (!formats) {
                logger.debug(`Tag Cache | Update inserted format failed | Reason:tag not found | Node:${nodeId} | Input:${inputId} | Tag:${rawTag}`);
                return false;
            }

            // Update inserted format
            formats.insertedFormat = insertedFormat;
            cache.set(rawTag, formats);

            // Update global cache
            allCache[key] = Object.fromEntries(cache);
            this.saveAllTagCache(allCache);

            logger.debug(`Tag Cache | Update inserted format | Node:${nodeId} | Input:${inputId} | Tag:${rawTag} | New format:${insertedFormat}`);
            return true;
        } catch (error) {
            logger.error(`Tag Cache | Update inserted format failed | Node:${nodeId} | Input:${inputId} | Tag:${rawTag} | Error:${error.message}`);
            return false;
        }
    }

    /**
     * Update the last used time for a tag
     */
    static updateTagLastUsed(nodeId, inputId, rawTag) {
        try {
            const allCache = this.getAllTagCache();
            const workflowId = app.graph?._workflow_id || 'unknown';
            const key = `${workflowId}_${nodeId}_${inputId}`;
            const cache = this.getTagCache(nodeId, inputId);

            if (cache.has(rawTag)) {
                const tagData = cache.get(rawTag);
                tagData.lastUsed = Date.now();
                cache.set(rawTag, tagData);
                allCache[key] = Object.fromEntries(cache);
                this.saveAllTagCache(allCache);
                logger.debug(`Tag Cache | Update last used time | Node:${nodeId} | Input:${inputId} | Tag:${rawTag}`);
            }
        } catch (error) {
            logger.error(`Tag Cache | Update last used time failed | Node:${nodeId} | Input:${inputId} | Tag:${rawTag} | Error:${error.message}`);
        }
    }

    /**
     * Clear all tags for a specific workflow
     */
    static clearWorkflowTags(workflowId) {
        if (!workflowId) return;
        try {
            const allCache = this.getAllTagCache();
            const newCache = {};
            for (const key in allCache) {
                // key format is `${workflowId}_${nodeId}_${inputId}`
                if (!key.startsWith(workflowId + '_')) {
                    newCache[key] = allCache[key];
                }
            }
            this.saveAllTagCache(newCache);
            logger.debug(`Tag Cache | Clear workflow tags | Workflow ID:${workflowId}`);
        } catch (error) {
            logger.error(`Tag Cache | Clear workflow tags failed | Workflow ID:${workflowId} | Error:${error.message}`);
        }
    }

    /**
     * Clear all tag cache
     */
    static clearAllTagCache() {
        try {
            CacheService.remove(CACHE_CONFIG.TAG_CACHE_KEY);
            logger.debug("Tag Cache | Cleared all cache");
        } catch (error) {
            logger.error(`Tag Cache | Clear cache failed | Error:${error.message}`);
        }
    }
}

/**
 * Translation Cache Service
 * Manages cache operations for translation results
 */
class TranslateCacheService {
    /**
     * Get all translation cache
     */
    static getAllTranslateCache() {
        try {
            const data = CacheService.get(CACHE_CONFIG.TRANSLATE_CACHE_KEY);
            if (data) {
                return new Map(Object.entries(data));
            }
            return new Map();
        } catch (error) {
            logger.error(`Translation Cache | Get cache failed | Error:${error.message}`);
            return new Map();
        }
    }

    /**
     * Save all translation cache
     */
    static saveAllTranslateCache(cache) {
        try {
            // Convert Map to plain object
            const data = Object.fromEntries(cache);
            CacheService.set(CACHE_CONFIG.TRANSLATE_CACHE_KEY, data);
        } catch (error) {
            logger.error(`Translation Cache | Save cache failed | Error:${error.message}`);
        }
    }

    /**
     * Add translation cache
     */
    static addTranslateCache(sourceText, translatedText) {
        try {
            // Validate parameters
            if (!sourceText || !translatedText) {
                logger.error("Translation Cache | Add cache failed | Missing required parameters");
                return false;
            }

            // Get existing cache
            const cache = this.getAllTranslateCache();

            // Add or update cache
            cache.set(sourceText, translatedText);

            // If cache is too large, delete oldest entries
            if (cache.size > CACHE_CONFIG.MAX_TRANSLATE_CACHE) {
                // Convert Map to array for manipulation
                const entries = Array.from(cache.entries());
                // Delete oldest entries, keep the latest MAX_TRANSLATE_CACHE items
                const newEntries = entries.slice(-CACHE_CONFIG.MAX_TRANSLATE_CACHE);
                // Rebuild cache
                cache.clear();
                newEntries.forEach(([key, value]) => cache.set(key, value));
            }

            // Save cache
            this.saveAllTranslateCache(cache);
            logger.debug(`Translation Cache | Add cache | Source length:${sourceText.length} | Translation length:${translatedText.length}`);
            return true;
        } catch (error) {
            logger.error(`Translation Cache | Add cache failed | Error:${error.message}`);
            return false;
        }
    }

    /**
     * Query translation cache
     */
    static queryTranslateCache(text) {
        try {
            if (!text) return null;

            const cache = this.getAllTranslateCache();

            // Check if text is a source (key)
            if (cache.has(text)) {
                const translatedText = cache.get(text);
                // logger.debug(`Translation Cache | Query result:source hit | Source length:${text.length} | Translation length:${translatedText.length}`);
                return {
                    type: 'source',
                    text: text,
                    translatedText: translatedText
                };
            }

            // Check if text is a translation (value)
            for (const [source, translated] of cache.entries()) {
                if (translated === text) {
                    logger.debug(`Translation Cache | Query result:translation hit | Source length:${source.length} | Translation length:${text.length}`);
                    return {
                        type: 'translated',
                        text: text,
                        sourceText: source
                    };
                }
            }

            // Cache miss
            logger.debug(`Translation Cache | Query result:miss | Text length:${text.length}`);
            return null;
        } catch (error) {
            logger.error(`Translation Cache | Query cache failed | Error:${error.message}`);
            return null;
        }
    }

    /**
     * Clear all translation cache
     */
    static clearAllTranslateCache() {
        try {
            CacheService.remove(CACHE_CONFIG.TRANSLATE_CACHE_KEY);
            logger.debug("Translation Cache | Cleared all cache");
        } catch (error) {
            logger.error(`Translation Cache | Clear cache failed | Error:${error.message}`);
        }
    }

    /**
     * Get translation cache statistics
     */
    static getTranslateCacheStats() {
        try {
            const cache = this.getAllTranslateCache();
            const stats = {
                total: cache.size,
                sourceTextLengths: 0,
                translatedTextLengths: 0
            };

            // Calculate total lengths of source and translated texts
            for (const [source, translated] of cache.entries()) {
                stats.sourceTextLengths += source.length;
                stats.translatedTextLengths += translated.length;
            }

            logger.debug(`Translation Cache | Get stats | Total:${stats.total} | Source total length:${stats.sourceTextLengths} | Translation total length:${stats.translatedTextLengths}`);
            return stats;
        } catch (error) {
            logger.error(`Translation Cache | Get stats failed | Error:${error.message}`);
            return { total: 0, sourceTextLengths: 0, translatedTextLengths: 0 };
        }
    }
}

export { CacheService, HistoryCacheService, TagCacheService, TranslateCacheService, CACHE_CONFIG };
