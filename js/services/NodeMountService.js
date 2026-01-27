/**
 * Node Mount Service (NodeMountService)
 * Unified management of assistant creation and mounting across different render modes
 *
 * Supports two render modes:
 * - litegraph.js: Traditional Canvas rendering + DOM Widget overlay
 * - Vue node2.0: Pure Vue component rendering
 */

import { app } from "../../../../scripts/app.js";
import { logger } from '../utils/logger.js';
import { EventManager } from '../utils/eventManager.js';

// ---Render Mode Enum---
export const RENDER_MODE = {
    LITEGRAPH: 'litegraph',
    VUE_NODES: 'vue_nodes',
    UNKNOWN: 'unknown'
};

/**
 * Node Mount Service Class
 * Provides render mode detection, container lookup, and mount management features
 */
class NodeMountService {
    constructor() {
        // Current render mode
        this.currentMode = RENDER_MODE.UNKNOWN;
        // Mode change callback list
        this._modeChangeCallbacks = [];
        // Whether initialized
        this._initialized = false;
        // Setup listener cleanup functions
        this._cleanupFunctions = [];
        // Mode detection cache to avoid frequent detection
        this._modeCache = null;
        this._modeCacheTime = 0;
        this._modeCacheTTL = 1000; // Cache TTL: 1 second

        // Mount observer mapping { nodeId: observer }
        this._observers = new Map();

        // ---Mode switch mutex lock---
        this._modeSwitching = false;
        // Pending mode switch request
        this._pendingModeChange = null;
    }

    // ---Initialization and Lifecycle---

    /**
     * Initialize service and set up mode monitoring
     */
    initialize() {
        if (this._initialized) {
            logger.debug('[NodeMountService] Already initialized, skipping');
            return;
        }

        // Detect initial render mode
        this.currentMode = this.detectRenderMode();

        // Set up mode change monitoring
        this._setupModeWatcher();

        this._initialized = true;
        logger.log(`[NodeMountService] Initialization complete | Render mode: ${this.currentMode}`);
    }

    /**
     * Clean up service resources
     */
    cleanup() {
        // Clean up all observers
        this._observers.forEach(observer => observer.disconnect());
        this._observers.clear();

        // Execute all cleanup functions
        this._cleanupFunctions.forEach(fn => {
            try {
                if (typeof fn === 'function') fn();
            } catch (e) {
                logger.debug(`[NodeMountService] Cleanup function execution failed: ${e.message}`);
            }
        });
        this._cleanupFunctions = [];
        this._modeChangeCallbacks = [];
        this._initialized = false;
        this._modeCache = null;
        logger.debug('[NodeMountService] Resource cleanup complete');
    }

    // ---Node Type Detection Utilities---

    /**
     * Check if a node uses comfy-markdown
     * Includes Note, MarkdownNote, PreviewTextNode, etc.
     * @param {object} node - Node object
     * @returns {boolean}
     */
    _isMarkdownNode(node) {
        if (!node || !node.type) return false;

        // Known node types using comfy-markdown
        const markdownNodeTypes = ['Note', 'MarkdownNote', 'PreviewAny', 'PreviewTextNode'];
        if (markdownNodeTypes.includes(node.type)) {
            return true;
        }

        // Check if node type name contains relevant keywords
        const typeLower = node.type.toLowerCase();
        return typeLower.includes('markdown') ||
            (typeLower.includes('preview') && typeLower.includes('text'));
    }

    /**
     * Check if a node is a Subgraph node
     * Subgraph node types are in UUID format
     * @param {object} node - Node object
     * @returns {boolean}
     */
    _isSubgraphNode(node) {
        if (!node || !node.type) return false;
        // UUID format: 8-4-4-4-12 characters
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(node.type);
    }

    // ---Render Mode Detection---

    /**
     * Detect current render mode
     * [Optimized] Only uses the most reliable LiteGraph.vueNodesMode global flag
     * @param {boolean} forceRefresh - Whether to force refresh cache
     * @returns {string} Render mode enum value
     */
    detectRenderMode(forceRefresh = false) {
        // Check cache
        const now = Date.now();
        if (!forceRefresh && this._modeCache && (now - this._modeCacheTime) < this._modeCacheTTL) {
            return this._modeCache;
        }

        // [Simplified] Only use the most reliable global flag
        const mode = (typeof LiteGraph !== 'undefined' && LiteGraph.vueNodesMode === true)
            ? RENDER_MODE.VUE_NODES
            : RENDER_MODE.LITEGRAPH;

        // Update cache
        this._modeCache = mode;
        this._modeCacheTime = now;

        return mode;
    }

    /**
     * Check if in Vue node2.0 mode
     * @returns {boolean}
     */
    isVueNodesMode() {
        return this.detectRenderMode() === RENDER_MODE.VUE_NODES;
    }

    /**
     * Check if in litegraph.js mode
     * @returns {boolean}
     */
    isLitegraphMode() {
        return this.detectRenderMode() === RENDER_MODE.LITEGRAPH;
    }

    // ---Mode Switch Monitoring---

    /**
     * Register mode change callback
     * @param {Function} callback - Callback function, receives (newMode, oldMode) parameters
     */
    onModeChange(callback) {
        if (typeof callback === 'function') {
            this._modeChangeCallbacks.push(callback);
        }
    }

    /**
     * Remove mode change callback
     * @param {Function} callback - Callback function to remove
     */
    offModeChange(callback) {
        const index = this._modeChangeCallbacks.indexOf(callback);
        if (index > -1) {
            this._modeChangeCallbacks.splice(index, 1);
        }
    }

    /**
     * Check if mode switching is in progress
     * @returns {boolean}
     */
    isModeSwitching() {
        return this._modeSwitching;
    }

    /**
     * Trigger mode switch event (with lock protection)
     * @param {string} newMode - New mode
     * @param {string} oldMode - Old mode
     */
    _triggerModeChange(newMode, oldMode) {
        // If already switching, record pending request and return
        if (this._modeSwitching) {
            this._pendingModeChange = { newMode, oldMode };
            logger.debug('[NodeMountService] Mode switch locked, request queued');
            return;
        }

        this._modeSwitching = true;
        logger.log(`[NodeMountService] Render mode switch | ${oldMode} -> ${newMode}`);

        // Clear cache
        this._modeCache = null;

        // Execute all callbacks, wait for async callbacks to complete
        Promise.all(this._modeChangeCallbacks.map(async callback => {
            try {
                await callback(newMode, oldMode);
            } catch (e) {
                logger.error(`[NodeMountService] Mode switch callback execution failed: ${e.message}`);
            }
        })).finally(() => {
            this._modeSwitching = false;
            // Process pending request
            if (this._pendingModeChange) {
                const pending = this._pendingModeChange;
                this._pendingModeChange = null;
                this._triggerModeChange(pending.newMode, pending.oldMode);
            }
        });
    }

    /**
     * Set up mode change watcher
     * Uses ComfyUI official events to monitor render mode switching
     */
    _setupModeWatcher() {
        // Record state for comparison
        let lastMode = this.currentMode;

        // Unified state change check function
        const checkModeChange = () => {
            const currentMode = this.detectRenderMode(true);
            if (currentMode !== lastMode) {
                const oldMode = lastMode;
                lastMode = currentMode;
                this.currentMode = currentMode;
                this._triggerModeChange(currentMode, oldMode);
            }
        };

        try {
            if (app.ui?.settings) {
                // Listen to ComfyUI official CustomEvent
                const eventName = 'Comfy.VueNodes.Enabled.change';
                const handleEvent = () => {
                    // Delay 50ms to ensure LiteGraph.vueNodesMode has completed global sync
                    setTimeout(checkModeChange, 50);
                };

                app.ui.settings.addEventListener(eventName, handleEvent);
                this._cleanupFunctions.push(() => {
                    app.ui.settings.removeEventListener(eventName, handleEvent);
                });

                logger.debug('[NodeMountService] Render mode watcher ready (event listener mode)');
            } else {
                // Fallback strategy: If app.ui.settings is not ready, use low-frequency polling
                const intervalId = setInterval(checkModeChange, 2000);
                this._cleanupFunctions.push(() => clearInterval(intervalId));
                logger.debug('[NodeMountService] app.ui.settings not ready, starting low-frequency polling fallback (2s)');
            }
        } catch (e) {
            logger.debug(`[NodeMountService] Mode watcher setup failed: ${e.message}`);
        }
    }

    // ---Container Lookup---

    /**
     * Find mount container for a node's input widget
     * @param {object} node - LiteGraph node object
     * @param {object} widget - Input widget object
     * @returns {object|null} Container info object or null
     */
    findMountContainer(node, widget) {
        if (!node || !widget) {
            logger.debug('[NodeMountService] findMountContainer: Invalid parameters');
            return null;
        }

        const mode = this.detectRenderMode();

        if (mode === RENDER_MODE.VUE_NODES) {
            return this._findVueNodeContainer(node, widget);
        } else {
            return this._findDomWidgetContainer(node, widget);
        }
    }

    /**
     * Find container in Vue node2.0 mode
     * @param {object} node - LiteGraph node object
     * @param {object} widget - Input widget object
     * @returns {object|null} Container info
     */
    /**
     * Determine if a widget should be rendered as a Textarea
     * @param {object} widget
     */
    _isTextareaWidget(widget) {
        if (!widget) return false;
        // 1. Explicit customtext type
        if (widget.type === 'customtext') return true;
        // 2. STRING type with multiline: true
        if (widget.type === 'STRING' && widget.options?.multiline) return true;
        // 3. Already bound to a textarea element
        if (widget.element && widget.element.tagName === 'TEXTAREA') return true;

        return false;
    }

    /**
     * Find container in Vue node2.0 mode
     * @param {object} node - LiteGraph node object
     * @param {object} widget - Input widget object
     * @returns {object|null} Container info
     */
    _findVueNodeContainer(node, widget) {
        try {
            // Find Vue node container with data-node-id
            const nodeContainer = document.querySelector(`[data-node-id="${node.id}"]`);
            if (!nodeContainer) {

                return null;
            }

            // Get widget name for finding the corresponding textarea
            const widgetName = widget.name || widget.id;
            let textarea = null;

            // Identify node type
            const isSubgraph = this._isSubgraphNode(node);
            const isMarkdown = this._isMarkdownNode(node);

            // --- Strategy 1: Prefer using widget.inputEl (if bound and is PrimeVue component) ---
            if (widget.inputEl && widget.inputEl.tagName === 'TEXTAREA') {
                if (nodeContainer.contains(widget.inputEl)) {
                    textarea = widget.inputEl;

                }
            }

            // --- Strategy 2: Calculate index position matching (required for subgraph nodes with multiple inputs) ---
            // Applicable for multiple same-type input fields (e.g., Subgraph, CLIPTextEncodeSDXL, etc.)
            if (!textarea && node.widgets) {
                // 1. Calculate the index of current widget among all Textarea-type widgets
                let targetIndex = -1;
                let currentIndex = 0;

                for (const w of node.widgets) {
                    if (this._isTextareaWidget(w)) {
                        if (w === widget || w.name === widget.name) { // Compatible with object reference or name matching
                            targetIndex = currentIndex;
                            break;
                        }
                        currentIndex++;
                    }
                }

                if (targetIndex !== -1) {
                    // 2. Get all PrimeVue textareas (preferred) or regular textareas in the DOM
                    const primeTextareas = Array.from(nodeContainer.querySelectorAll('textarea.p-textarea'));
                    const textareas = primeTextareas.length > 0
                        ? primeTextareas
                        : Array.from(nodeContainer.querySelectorAll('textarea'));

                    // 3. Match by index
                    if (targetIndex < textareas.length) {
                        textarea = textareas[targetIndex];
                        logger.debugSample(() => `[NodeMountService] Vue mode: Index match success [${targetIndex}] | Widget: ${widgetName} | Subgraph: ${isSubgraph}`);
                    } else {

                    }
                }
            }

            // --- Strategy 3: Label/Placeholder fuzzy matching (fallback for legacy logic) ---
            if (!textarea) {
                const textareas = nodeContainer.querySelectorAll('textarea');
                const searchName = widgetName.toLowerCase().replace(/_/g, ' '); // snake_case -> space separated

                for (const ta of textareas) {
                    // Check placeholder
                    const placeholder = (ta.getAttribute('placeholder') || '').toLowerCase();
                    // Check aria-label
                    const ariaLabel = (ta.getAttribute('aria-label') || '').toLowerCase();
                    // Check parent label
                    const label = ta.closest('label')?.textContent?.toLowerCase() || '';
                    // Check preceding label (Vue floating label structure)
                    const floatLabel = ta.parentElement?.querySelector('label')?.textContent?.toLowerCase() || '';

                    if (placeholder.includes(searchName) ||
                        ariaLabel.includes(searchName) ||
                        label.includes(searchName) ||
                        floatLabel.includes(searchName)) {
                        textarea = ta;
                        // logger.debug(`[NodeMountService] Vue mode: Fuzzy match success | Widget: ${widgetName}`);
                        break;
                    }
                }
            }

            // --- Strategy 4: Last resort fallback (only safe when there's exactly one textarea) ---
            if (!textarea) {
                const textareas = nodeContainer.querySelectorAll('textarea');
                if (textareas.length === 1) {
                    textarea = textareas[0];

                }
            }

            if (!textarea) {

                // For nodes using comfy-markdown (Note/MarkdownNote/PreviewTextNode etc.), return nodeContainer as container but textarea as null
                if (this._isMarkdownNode(node)) {
                    return {
                        container: nodeContainer,
                        textarea: null, // Marked for further lookup
                        nodeContainer: nodeContainer,
                        mode: RENDER_MODE.VUE_NODES,
                        widgetName: widgetName,
                        isNoteNode: true
                    };
                }
                return null;
            }

            // Find the parent container of textarea as mount point
            // Prefer floatlabel container, otherwise use parent element
            const mountContainer = textarea.closest('.p-floatlabel, [class*="float"]') || textarea.parentElement;

            return {
                container: mountContainer,
                textarea: textarea,
                nodeContainer: nodeContainer,
                mode: RENDER_MODE.VUE_NODES,
                widgetName: widgetName,
                isSubgraph: isSubgraph,  // Mark whether it's a subgraph node
                isNoteNode: isMarkdown   // Mark whether it's a Markdown-type node
            };
        } catch (e) {
            logger.error(`[NodeMountService] Vue container lookup failed: ${e.message}`);
            return null;
        }
    }

    /**
     * Find container in litegraph.js mode
     * @param {object} node - LiteGraph node object
     * @param {object} widget - Input widget object
     * @returns {object|null} Container info
     */
    _findDomWidgetContainer(node, widget) {
        try {
            const inputEl = widget.inputEl || widget.element;
            if (!inputEl) {
                logger.debug('[NodeMountService] Litegraph mode: Input element not found');
                return null;
            }

            // Traverse up to find dom-widget container
            let parent = inputEl.parentElement;
            let domWidgetContainer = null;

            while (parent) {
                if (parent.classList?.contains('dom-widget')) {
                    domWidgetContainer = parent;
                    break;
                }
                parent = parent.parentElement;
            }

            if (!domWidgetContainer) {
                logger.debug(`[NodeMountService] Litegraph mode: dom-widget container not found | Node ID: ${node.id}`);
                return null;
            }

            return {
                container: domWidgetContainer,
                textarea: inputEl,
                mode: RENDER_MODE.LITEGRAPH,
                widgetName: widget.name || widget.id
            };
        } catch (e) {
            logger.error(`[NodeMountService] dom-widget container lookup failed: ${e.message}`);
            return null;
        }
    }

    // ---Image Node Container Lookup---

    /**
     * Find mount container for image nodes (for ImageCaption)
     * @param {object} node - LiteGraph node object
     * @returns {object|null} Container info
     */
    findImageNodeContainer(node) {
        if (!node) return null;

        const mode = this.detectRenderMode();

        if (mode === RENDER_MODE.VUE_NODES) {
            return this._findVueImageNodeContainer(node);
        } else {
            // In litegraph mode, image assistant uses fixed positioning, no container needed
            return {
                container: document.body,
                mode: RENDER_MODE.LITEGRAPH,
                useFixedPositioning: true
            };
        }
    }

    /**
     * Find image node container in Vue node2.0 mode
     * @param {object} node - LiteGraph node object
     * @returns {object|null} Container info
     */
    _findVueImageNodeContainer(node) {
        try {
            const nodeContainer = document.querySelector(`[data-node-id="${node.id}"]`);
            if (!nodeContainer) {
                logger.debug(`[NodeMountService] Vue mode: Image node container not found | ID: ${node.id}`);
                return null;
            }

            return {
                container: nodeContainer,
                mode: RENDER_MODE.VUE_NODES,
                useFixedPositioning: false
            };
        } catch (e) {
            logger.error(`[NodeMountService] Vue image node container lookup failed: ${e.message}`);
            return null;
        }
    }

    // ---Mount Helper Methods---

    /**
     * Mount assistant element to container
     * @param {HTMLElement} assistantElement - Assistant DOM element
     * @param {object} containerInfo - Container info returned by findMountContainer
     * @param {object} options - Mount options
     * @returns {boolean} Whether mount was successful
     */
    mountAssistant(assistantElement, containerInfo, options = {}) {
        if (!assistantElement || !containerInfo?.container) {
            logger.debug('[NodeMountService] mountAssistant: Invalid parameters');
            return false;
        }

        try {
            const { container, mode } = containerInfo;
            const { position = 'bottom-right', offset = { x: 4, y: 4 } } = options;

            if (mode === RENDER_MODE.VUE_NODES) {
                // Vue node2.0 mode: Use relative positioning
                assistantElement.style.position = 'absolute';
                assistantElement.style.zIndex = '10';

                if (position === 'bottom-right') {
                    assistantElement.style.right = `${offset.x}px`;
                    assistantElement.style.bottom = `${offset.y}px`;
                    assistantElement.style.left = 'auto';
                    assistantElement.style.top = 'auto';
                } else if (position === 'bottom-left') {
                    assistantElement.style.left = `${offset.x}px`;
                    assistantElement.style.bottom = `${offset.y}px`;
                    assistantElement.style.right = 'auto';
                    assistantElement.style.top = 'auto';
                }

                // Ensure container has relative positioning
                const containerPosition = window.getComputedStyle(container).position;
                if (containerPosition === 'static') {
                    container.style.position = 'relative';
                }

                container.appendChild(assistantElement);

            } else {
                // litegraph.js mode: Use absolute positioning (within dom-widget)
                assistantElement.style.position = 'absolute';
                assistantElement.style.right = `${offset.x}px`;
                assistantElement.style.bottom = `${offset.y}px`;
                assistantElement.style.height = '20px';
                assistantElement.style.minHeight = '20px';

                container.appendChild(assistantElement);
            }

            // Trigger reflow to ensure styles take effect
            void assistantElement.offsetWidth;


            return true;

        } catch (e) {
            logger.error(`[NodeMountService] Mount failed: ${e.message}`);
            return false;
        }
    }

    /**
     * Wait for an element to appear (using MutationObserver)
     * Replaces polling for near-zero latency response
     * @param {HTMLElement} parent - Parent element to observe
     * @param {string} selector - Target selector (or check function)
     * @param {number} timeout - Timeout in ms
     * @returns {Promise<HTMLElement|null>}
     */
    waitForElement(parent, selector, timeout = 2000) {
        return new Promise((resolve) => {
            // 1. Check immediately if element exists
            let element = null;
            if (typeof selector === 'function') {
                element = selector(parent);
            } else {
                element = parent.querySelector(selector);
            }

            if (element) {
                return resolve(element);
            }

            // 2. Set up observer
            const observer = new MutationObserver((mutations) => {
                let found = null;
                if (typeof selector === 'function') {
                    found = selector(parent);
                } else {
                    found = parent.querySelector(selector);
                }

                if (found) {
                    observer.disconnect();
                    resolve(found);
                }
            });

            observer.observe(parent, {
                childList: true,
                subtree: true,
                attributes: true // Sometimes elements may only change attributes (e.g., hidden removal)
            });

            // 3. Set timeout
            setTimeout(() => {
                observer.disconnect();
                resolve(null);
            }, timeout);
        });
    }

    /**
     * Container lookup with retry/wait
     * Optimized: Uses MutationObserver instead of pure polling
     * @param {object} node - Node object
     * @param {object} widget - Widget object
     * @param {object} options - Options
     * @returns {Promise<object|null>} Container info
     */
    async findMountContainerWithRetry(node, widget, options = {}) {
        // [Optimized] Based on testing, Vue nodes 2.0 textarea already exists when node container is added
        // So in most cases, complex waiting logic is not needed
        const { timeout = 500 } = options;

        // Try immediate lookup (should succeed in most cases)
        const immediateResult = this.findMountContainer(node, widget);
        if (immediateResult && immediateResult.textarea) {
            return immediateResult;
        }

        // If it's a Markdown/Note node and container was found but textarea wasn't
        if (immediateResult && immediateResult.isNoteNode) {
            // Continue below, wait for textarea to appear
        }

        const mode = this.detectRenderMode();

        // Vue mode: Simplified wait strategy
        if (mode === RENDER_MODE.VUE_NODES) {
            const nodeContainer = document.querySelector(`[data-node-id="${node.id}"]`);

            if (nodeContainer) {
                // Use Observer to briefly wait for textarea to appear


                await this.waitForElement(nodeContainer, () => {
                    const result = this.findMountContainer(node, widget);
                    return (result && result.textarea) ? result : null;
                }, timeout);

                // Get final result
                const finalResult = this.findMountContainer(node, widget);
                if (finalResult && finalResult.textarea) {

                    return finalResult;
                }
            }
        } else if (mode === RENDER_MODE.VUE_NODES) {
            // [Key] nodeContainer doesn't exist yet, need to wait for node container rendering
            // Watch canvas container, wait for nodeContainer to appear
            const graphCanvas = document.querySelector('.graph-canvas-container') ||
                document.querySelector('[class*="graph"]') ||
                document.body;



            // Use Observer to wait for nodeContainer to appear
            const waitResult = await this.waitForElement(graphCanvas, () => {
                const container = document.querySelector(`[data-node-id="${node.id}"]`);
                if (container) {
                    // After finding node container, look for textarea
                    const result = this.findMountContainer(node, widget);
                    return (result && result.textarea) ? result : null;
                }
                return null;
            }, timeout);

            if (waitResult) {

                return this.findMountContainer(node, widget);
            }
        }

        // Fallback strategy: Quick retry once (only for LiteGraph mode or Observer failure)
        await new Promise(r => setTimeout(r, 100));
        const retryResult = this.findMountContainer(node, widget);
        if (retryResult && retryResult.textarea) return retryResult;

        logger.debugSample(() => `[NodeMountService] Container lookup not ready | Node ID: ${node?.id}`);
        return null;
    }
}

// Create singleton instance
export const nodeMountService = new NodeMountService();

// Export class (for type checking or inheritance)
export { NodeMountService };
