/**
 * Prompt Assistant core class
 * Unified management of assistant lifecycle, instance creation, UI interaction, etc.
 */

import { app } from "../../../../scripts/app.js";
import { logger } from '../utils/logger.js';
import { FEATURES } from "../services/features.js";
import { HistoryManager } from "./history.js";
import { TagManager } from "./tag.js";
import { HistoryCacheService, TagCacheService, TranslateCacheService, CACHE_CONFIG, CacheService } from "../services/cache.js";
import { EventManager } from "../utils/eventManager.js";
import { ResourceManager } from "../utils/resourceManager.js";
import { UIToolkit } from "../utils/UIToolkit.js";
import { PromptFormatter } from "../utils/promptFormatter.js";
import { APIService } from "../services/api.js";

import { buttonMenu } from "../services/btnMenu.js";
import { rulesConfigManager } from "./rulesConfigManager.js";
import { nodeMountService, RENDER_MODE } from "../services/NodeMountService.js";
import { AssistantContainer, ANCHOR_POSITION } from "./AssistantContainer.js";
import { PopupManager } from "../utils/popupManager.js";
import { MarkdownNoteTranslate } from "../utils/markdownNoteTranslate.js";



// ====================== Utility Functions ======================

/**
 * Calculate the preset width of the assistant UI
 * Returns the corresponding fixed width value based on the number of currently enabled features
 * @returns {number} Width value (pixels)
 */
function calculateAssistantWidth() {
    // Count enabled features
    const hasHistory = window.FEATURES.history;
    const hasTag = window.FEATURES.tag;
    const hasExpand = window.FEATURES.expand;
    const hasTranslate = window.FEATURES.translate;

    // Count the number of non-history features
    const otherFeaturesCount = [hasTag, hasExpand, hasTranslate].filter(Boolean).length;

    // Return preset constant width based on feature combination
    if (hasHistory && otherFeaturesCount === 3) {
        return 143; // All features enabled (history 3 + divider 1 + others 3)
    } else if (hasHistory && otherFeaturesCount === 2) {
        return 121; // History + two others
    } else if (hasHistory && otherFeaturesCount === 1) {
        return 99;  // History + one other
    } else if (hasHistory && otherFeaturesCount === 0) {
        return 77;  // History only
    } else if (!hasHistory && otherFeaturesCount === 3) {
        return 72;  // Three features without history
    } else if (!hasHistory && otherFeaturesCount === 2) {
        return 50;  // Two buttons only
    } else if (!hasHistory && otherFeaturesCount === 1) {
        return 28;  // One button only
    }

    return 28; // Default
}



/**
 * Debounce function
 * Limits function call frequency to avoid performance issues from frequent triggering
 */
function debounce(func, wait = 100) {
    return EventManager.debounce(func, wait);
}

/**
 * Get the content of an input element
 * Supports standard textarea, Tiptap editor, ProseMirror editor, etc.
 * @param {object} widget - Assistant widget object
 * @returns {string} Input content
 */
function getInputValue(widget, options = {}) {
    if (!widget || !widget.inputEl) {
        return '';
    }

    const inputEl = widget.inputEl;
    const returnHtml = options.html === true;

    // Standard textarea
    if (inputEl.tagName === 'TEXTAREA' && inputEl.value !== undefined) {
        return inputEl.value;
    }

    // Tiptap/ProseMirror/comfy-markdown editor
    if (inputEl.classList.contains('tiptap') ||
        inputEl.classList.contains('ProseMirror') ||
        inputEl.classList.contains('comfy-markdown')) {

        let targetEl = inputEl;
        // For comfy-markdown, find inner editor element
        if (inputEl.classList.contains('comfy-markdown')) {
            const editorEl = inputEl.querySelector('.tiptap, .ProseMirror');
            if (editorEl) {
                targetEl = editorEl;
            }
        }

        if (returnHtml) {
            return targetEl.innerHTML || '';
        }

        const textContent = targetEl.textContent || targetEl.innerText || '';
        if (textContent.trim()) {
            return textContent;
        }

        // Get from widget.value
        if (widget.value !== undefined) {
            return widget.value;
        }

        // Find matching widget.value from node.widgets
        if (widget.node && widget.node.widgets) {
            const matchingWidget = widget.node.widgets.find(w =>
                w.name === widget.inputId || w.name === 'text'
            );
            if (matchingWidget && matchingWidget.value !== undefined) {
                return matchingWidget.value;
            }
        }
    }

    // contenteditable element
    if (inputEl.isContentEditable || inputEl.getAttribute('contenteditable') === 'true') {
        if (returnHtml) {
            return inputEl.innerHTML || '';
        }
        return inputEl.textContent || inputEl.innerText || '';
    }

    // widget.value
    if (widget.value !== undefined && typeof widget.value === 'string') {
        return widget.value;
    }

    // inputWidget.value
    if (widget.inputWidget && widget.inputWidget.value !== undefined) {
        return widget.inputWidget.value;
    }

    return '';
}

/**
 * Set the content of an input element
 * Supports standard textarea, Tiptap editor, ProseMirror editor, etc.
 * @param {object} widget - Assistant widget object
 * @param {string} content - Content to set
 * @param {object} options - Configuration options
 * @param {boolean} options.html - Whether to set as HTML content
 * @param {boolean} options.silent - Whether to update silently (without triggering events, for streaming output)
 * @returns {boolean} Whether the operation was successful
 */
function setInputValue(widget, content, options = {}) {
    if (!widget || !widget.inputEl) {
        return false;
    }

    const inputEl = widget.inputEl;
    const useHtml = options.html === true;
    const silent = options.silent === true;  // Don't trigger events during streaming updates

    try {
        // Standard textarea
        if (inputEl.tagName === 'TEXTAREA' && inputEl.value !== undefined) {
            inputEl.value = content;

            // Critical fix: Even in silent mode, widget.value and node.widgets[].value need to be synced
            // Otherwise subsequent getInputValue calls will read stale values
            if (widget.value !== undefined) {
                widget.value = content;
            }
            if (widget.node && widget.node.widgets) {
                const matchingWidget = widget.node.widgets.find(w =>
                    w.name === widget.inputId || w.name === 'text'
                );
                if (matchingWidget) {
                    matchingWidget.value = content;
                }
            }

            if (!silent) {
                inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                inputEl.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return true;
        }

        // comfy-markdown or Tiptap/ProseMirror editor
        if (inputEl.classList.contains('comfy-markdown') ||
            inputEl.classList.contains('tiptap') ||
            inputEl.classList.contains('ProseMirror')) {

            // For comfy-markdown, find inner editor
            let targetEl = inputEl;
            if (inputEl.classList.contains('comfy-markdown')) {
                const editorEl = inputEl.querySelector('.tiptap, .ProseMirror');
                if (editorEl) {
                    targetEl = editorEl;
                }
            }

            // Set textContent/innerHTML
            if (targetEl.isContentEditable || targetEl.getAttribute('contenteditable') === 'true') {
                if (useHtml) {
                    targetEl.innerHTML = content;
                } else {
                    targetEl.textContent = content;
                }
            } else {
                targetEl.innerHTML = content;
            }

            // Trigger input event (skip in silent mode)
            if (!silent) {
                targetEl.dispatchEvent(new Event('input', { bubbles: true }));
                targetEl.dispatchEvent(new Event('change', { bubbles: true }));
            }

            // Also update widget.value (needs sync regardless of silent mode)
            if (widget.value !== undefined) {
                widget.value = content;
            }

            // Also update node.widgets[].value (needs sync regardless of silent mode)
            if (widget.node && widget.node.widgets) {
                const matchingWidget = widget.node.widgets.find(w =>
                    w.name === widget.inputId || w.name === 'text'
                );
                if (matchingWidget) {
                    matchingWidget.value = content;
                }
            }

            return true;
        }

        // contenteditable element
        if (inputEl.isContentEditable || inputEl.getAttribute('contenteditable') === 'true') {
            if (useHtml) {
                inputEl.innerHTML = content;
            } else {
                inputEl.textContent = content;
            }

            // Critical fix: sync widget.value and node.widgets[].value
            if (widget.value !== undefined) {
                widget.value = content;
            }
            if (widget.node && widget.node.widgets) {
                const matchingWidget = widget.node.widgets.find(w =>
                    w.name === widget.inputId || w.name === 'text'
                );
                if (matchingWidget) {
                    matchingWidget.value = content;
                }
            }

            if (!silent) {
                inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                inputEl.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return true;
        }

        // widget.value
        if (widget.value !== undefined) {
            widget.value = content;
            return true;
        }

        return false;
    } catch (error) {
        logger.error(`[setInputValue] Set failed | Error: ${error.message}`);
        return false;
    }
}

// ====================== Main Class Implementation ======================

/**
 * Prompt Assistant main class
 * Unified management of assistant lifecycle, instances, and resources
 */
class PromptAssistant {
    /** Map collection storing all assistant instances */
    static instances = new Map();

    constructor() {
        this.initialized = false;
    }

    // ---Lifecycle Management---
    /**
     * Check if features are disabled
     */
    areAllFeaturesDisabled() {
        return !window.FEATURES.enabled;
    }

    /**
     * Initialize Prompt Assistant
     */
    initialize() {
        if (this.initialized) return;

        try {
            // Check version number
            if (!window.PromptAssistant_Version) {
                logger.error("Version number not found during initialization! This may cause UI display issues");
            } else {
                logger.debug(`Version number detected during initialization: ${window.PromptAssistant_Version}`);
            }

            // Initialize event manager
            EventManager.init();

            // Load all feature toggle states from config
            FEATURES.loadSettings();
            // Sync to window.FEATURES for backward compatibility
            window.FEATURES.enabled = FEATURES.enabled;

            // Log master switch state (changed to debug level)
            logger.debug(`Master switch state detected during initialization | Status: ${FEATURES.enabled ? "Enabled" : "Disabled"}`);

            // Initialize resource manager
            ResourceManager.init();

            // Only perform full initialization when master switch is on
            if (window.FEATURES.enabled) {

            }

            this.initialized = true;
            logger.log("Initialization complete | Assistant fully started");
        } catch (error) {
            logger.error(`Initialization failed | Error: ${error.message}`);
            // Reset state
            this.initialized = false;
            window.FEATURES.enabled = false;
            // Ensure cleanup
            this.cleanup();
        }
    }

    /**
     * Unified control of the master switch feature
     * Centrally manage all service features controlled by the master switch
     */
    async toggleGlobalFeature(enable, force = false) {
        // Update state
        const oldValue = window.FEATURES.enabled;
        window.FEATURES.enabled = enable;

        // Don't execute when state unchanged, unless force is true
        if (!force && oldValue === enable) {
            return;
        }

        // Only log when state actually changes or force is true
        if (oldValue !== enable || force === true) {
            logger.log(`Master switch | Action: ${enable ? "Enable" : "Disable"}`);
        }

        try {
            if (enable) {
                // === Enable all services ===
                // Ensure managers are initialized
                if (!EventManager.initialized) {
                    EventManager.init();
                }

                if (!ResourceManager.isInitialized()) {
                    ResourceManager.init();
                }

                // 1. Reset node initialization flags, prepare for re-detection
                if (app.canvas && app.canvas.graph) {
                    const nodes = app.canvas.graph._nodes || [];
                    nodes.forEach(node => {
                        if (node) {
                            node._promptAssistantInitialized = false;
                        }
                    });
                }

                // 2. Set up or restore node selection event listener
                if (app.canvas) {
                    // Avoid setting up duplicate listeners
                    if (!app.canvas._promptAssistantSelectionHandler) {
                        app.canvas._promptAssistantSelectionHandler = function (selected_nodes) {
                            // Skip all node processing when master switch is off
                            if (!window.FEATURES.enabled) {
                                return;
                            }

                            if (selected_nodes && Object.keys(selected_nodes).length > 0) {
                                Object.keys(selected_nodes).forEach(nodeId => {
                                    const node = app.canvas.graph.getNodeById(nodeId);
                                    if (!node) return;

                                    // Initialize uninitialized nodes
                                    if (!node._promptAssistantInitialized) {
                                        node._promptAssistantInitialized = true;
                                        this.checkAndSetupNode(node);
                                    }
                                });
                            }
                        }.bind(this);
                    }

                    // Save current listener and set up new one
                    if (app.canvas.onSelectionChange && app.canvas.onSelectionChange !== app.canvas._promptAssistantSelectionHandler) {
                        app.canvas._originalSelectionChange = app.canvas.onSelectionChange;
                    }

                    app.canvas.onSelectionChange = app.canvas._promptAssistantSelectionHandler;

                    // 3. If auto-creation is enabled, immediately scan all valid nodes
                    const creationMode = app.ui.settings.getSettingValue("PromptAssistant.Settings.CreationMode") || "auto";
                    if (creationMode === "auto") {
                        const nodes = app.canvas.graph._nodes || [];
                        nodes.forEach(node => {
                            if (node && !node._promptAssistantInitialized) {
                                // Avoid duplicate processing during scan
                                node._promptAssistantInitialized = true;
                                this.checkAndSetupNode(node);
                            }
                        });
                    }
                }
            } else {
                // === Disable all services ===

                // 1. Count and clean up all instances
                const instanceCount = PromptAssistant.instances.size;
                this.cleanup(null, true);

                // 2. Restore original node selection event listener
                if (app.canvas) {
                    if (app.canvas._originalSelectionChange) {
                        app.canvas.onSelectionChange = app.canvas._originalSelectionChange;
                    } else {
                        app.canvas.onSelectionChange = null;
                    }
                }
            }

            // Button visibility updates are handled separately in features
            window.FEATURES.updateButtonsVisibility();


        } catch (error) {
            logger.error(`Master switch operation failed | Error: ${error.message}`);
            // Restore original state
            window.FEATURES.enabled = oldValue;
        }
    }

    // ---Resource Management---
    /**
     * Clean up all resources
     */
    cleanup(nodeId = null, silent = false) {
        // If workflow is switching, only clean up UI instances, don't delete cache
        if (window.PROMPT_ASSISTANT_WORKFLOW_SWITCHING) {
            // Simplified logging: Don't print node cleanup logs one by one during workflow switching to avoid log flooding
            // For debugging, change the line below back to debug single output
            // if (nodeId !== null) { logger.debug(`[Cleanup skipped] Workflow switching, only cleaning up Prompt Assistant UI, Node ID: ${nodeId}`); }

            const keysToDelete = Array.from(PromptAssistant.instances.keys())
                .filter(key => nodeId === null || key.startsWith(`${String(nodeId)}_`));

            keysToDelete.forEach(key => {
                const instance = PromptAssistant.getInstance(key);
                if (instance) {
                    this._cleanupInstance(instance, key, false); // false means remove from instance collection
                }
            });

            // If global cleanup, clear instance collection
            if (nodeId === null) {
                PromptAssistant.instances.clear();
            }
            return;
        }

        // Check if nodeId is valid
        if (nodeId !== null && nodeId !== undefined) {
            // Ensure nodeId is string type for subsequent comparison
            const nodeIdStr = String(nodeId);

            // Get all instance keys for the current node
            const keysToDelete = Array.from(PromptAssistant.instances.keys())
                .filter(key => key === nodeIdStr || key.startsWith(`${nodeIdStr}_`));

            // If there are instances to clean up
            if (keysToDelete.length > 0) {
                let historyCount = 0;
                let tagCount = 0;
                let instanceNames = [];

                try {
                    // Count and clean up history records
                    const allHistory = HistoryCacheService.getAllHistory();
                    historyCount = allHistory.filter(item => item.node_id === nodeId).length;
                    HistoryCacheService.clearNodeHistory(nodeId);

                    // Count and clean up tag cache
                    keysToDelete.forEach(key => {
                        const instance = PromptAssistant.getInstance(key);
                        if (instance && instance.inputId) {
                            const tags = TagCacheService.getAllRawTags(nodeId, instance.inputId);
                            tagCount += tags ? tags.length : 0;
                            TagCacheService.clearCache(nodeId, instance.inputId);
                            instanceNames.push(instance.inputId);
                        }
                    });

                    // Clean up instances
                    keysToDelete.forEach(key => {
                        const instance = PromptAssistant.getInstance(key);
                        if (instance) {
                            this._cleanupInstance(instance, key, true);
                            PromptAssistant.instances.delete(key);
                        }
                    });

                    if (!silent) {
                        // Get remaining statistics
                        const remainingInstances = PromptAssistant.instances.size;
                        // Get tag cache statistics
                        const tagStats = TagCacheService.getTagStats();
                        const remainingTags = tagStats.total;
                        const remainingHistory = HistoryCacheService.getAllHistory().length;

                        logger.log(`[Cleanup summary] Node ID: ${nodeId} | Cleaned instances: ${instanceNames.join(', ')} | History records cleaned: ${historyCount} | Tag cache cleaned: ${tagCount}`);
                    }
                } catch (error) {
                    logger.error(`[Node cleanup] Failed | Node ID: ${nodeId} | Error: ${error.message}`);
                }
            }
            return;
        }

        // Clean up all instances and history
        const beforeCleanupSize = PromptAssistant.instances.size;
        if (beforeCleanupSize > 0) {
            let totalHistoryCount = 0;
            let totalTagCount = 0;
            let allInstanceNames = [];

            try {
                // Count and clean up all history records
                const allHistory = HistoryCacheService.getAllHistory();
                totalHistoryCount = allHistory.length;
                HistoryCacheService.clearAllHistory();

                // Count tag cache
                const tagStats = TagCacheService.getTagStats();
                totalTagCount = tagStats.total;

                // Clean up all tag cache
                TagCacheService.clearAllTagCache();

                // Clean up all instances
                for (const [key, instance] of PromptAssistant.instances) {
                    if (instance) {
                        allInstanceNames.push(instance.inputId || key);
                        this._cleanupInstance(instance, key, true);
                    }
                }

                // Clear instance collection
                PromptAssistant.instances.clear();

                if (!silent) {
                    logger.log(`[Global cleanup] Instances: ${allInstanceNames.join(', ')} | History: ${totalHistoryCount} | Tags: ${totalTagCount}`);
                    logger.log(`[Remaining stats] Assistant instances: 0 | Tag cache: 0 | Node history cache: 0`);
                }
            } catch (error) {
                logger.error(`[Global cleanup] Failed | Error: ${error.message}`);
            }
        }
    }

    // ---Node Type Detection Tools---

    /**
     * Check if a node uses comfy-markdown
     * Including Note, MarkdownNote, PreviewTextNode, etc.
     * @param {object} node - Node object
     * @returns {boolean}
     */
    _isMarkdownNode(node) {
        if (!node || !node.type) return false;
        const markdownNodeTypes = ['Note', 'MarkdownNote', 'PreviewAny', 'PreviewTextNode'];
        if (markdownNodeTypes.includes(node.type)) {
            return true;
        }
        const typeLower = node.type.toLowerCase();
        return typeLower.includes('markdown') ||
            (typeLower.includes('preview') && typeLower.includes('text')) ||
            typeLower.includes('subgraph'); // Added basic subgraph detection support
    }

    /**
     * Check if a node is a subgraph node (Subgraph)
     * Subgraph node type names are in UUID format
     * @param {object} node - Node object
     * @returns {boolean}
     */
    _isSubgraphNode(node) {
        if (!node || !node.type) return false;
        // UUID format: 8-4-4-4-12 characters
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(node.type);
    }

    // ---Instance Management---
    /**
     * Check if a node is valid
     * Note/MarkdownNote/Subgraph nodes need special handling in Vue mode
     */
    static isValidNode(node) {
        if (!node || typeof node.id === 'undefined' || node.id === -1) {
            return false;
        }

        if (typeof node.type !== 'string') {
            return false;
        }

        // Special node types in Vue mode (may not have standard widgets property)
        const isVueMode = typeof LiteGraph !== 'undefined' && LiteGraph.vueNodesMode === true;
        const vueSpecialNodeTypes = ['Note', 'MarkdownNote', 'PreviewAny', 'PreviewTextNode'];

        // Check if it's a markdown type node
        const isMarkdownNode = vueSpecialNodeTypes.includes(node.type) ||
            (node.type && node.type.toLowerCase().includes('markdown')) ||
            (node.type && node.type.toLowerCase().includes('preview') && node.type.toLowerCase().includes('text'));

        // Check if it's a subgraph node
        // 1. UUID format type name (Node 2.0 dynamically created)
        const isUUIDType = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(node.type);
        // 2. Native Subgraph keyword or workflow/ prefix
        const isSubgraphType = node.type === 'Subgraph' ||
            node.type.startsWith('workflow/') ||
            (node.constructor && node.constructor.name === 'Subgraph');

        if (isVueMode && (isMarkdownNode || isUUIDType || isSubgraphType)) {
            // These node types are considered valid directly in Vue mode
            return true;
        }

        // Standard check: must have widgets property
        return !!node.widgets;
    }

    /**
     * Add instance to manager
     */
    static addInstance(nodeId, widget) {
        if (nodeId != null && widget != null) {
            this.instances.set(String(nodeId), widget);
            return true;
        }
        return false;
    }

    /**
     * Get instance
     */
    static getInstance(nodeId) {
        if (nodeId == null) return null;
        return this.instances.get(String(nodeId));
    }

    /**
     * Check if instance exists
     */
    static hasInstance(nodeId) {
        if (nodeId == null) return false;
        return this.instances.has(String(nodeId));
    }

    /**
     * Check node and set up assistant
     * Find valid input widgets in node and create assistant
     */
    checkAndSetupNode(node) {
        // Quick check
        if (!window.FEATURES.enabled || !node) return;

        const isVueMode = LiteGraph.vueNodesMode === true;



        // In Vue mode, special nodes (Note/Markdown/Subgraph) are valid even without LiteGraph widgets
        if (!node.widgets) {

            if (isVueMode && PromptAssistant.isValidNode(node)) {
                this._handleVueDomScanNode(node);
            }
            return;
        }

        // Follow-up check: if node has widgets but is not recognized as valid, also fall back
        const isValid = PromptAssistant.isValidNode(node);
        if (!isValid) {

            return;
        }

        // Get all valid input widgets
        const validInputs = node.widgets.filter(widget => {
            if (!widget.node) widget.node = node;
            const isValidInput = UIToolkit.isValidInput(widget, { debug: false, node: node });

            return isValidInput;
        });



        if (validInputs.length === 0) {
            // Non-target node types (e.g. LoadImage) having no text widgets is normal, use debug level
            logger.debug(`[checkAndSetupNode] Node has no valid widgets | ID: ${node.id} | Type: ${node.type}`);

            // In Vue mode, node may temporarily not have recognized LiteGraph widgets, force fallback to DOM scan mode
            if (isVueMode && isValid) {
                this._handleVueDomScanNode(node);
            }
            return;
        }

        // Create assistant for each valid widget
        validInputs.forEach((inputWidget, widgetIndex) => {
            const inputId = inputWidget.name || inputWidget.id;

            // Generate unique assistantKey
            // For multiple inputs with the same name (e.g. Show Any node list inputs), use index to distinguish
            let assistantKey = `${node.id}_${inputId}`;

            // Check if same-name inputs exist, if so use index or DOM element unique ID
            const sameNameWidgets = validInputs.filter(w => (w.name || w.id) === inputId);
            if (sameNameWidgets.length > 1) {
                // Multiple same-name inputs, use index or input element memory address as unique ID
                const inputEl = inputWidget.inputEl || inputWidget.element;
                if (inputEl) {
                    // Add unique identifier to input element
                    if (!inputEl.dataset.promptAssistantUniqueId) {
                        inputEl.dataset.promptAssistantUniqueId = `${node.id}_${inputId}_${widgetIndex}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                    }
                    assistantKey = inputEl.dataset.promptAssistantUniqueId;
                } else {
                    // Fallback: use index
                    assistantKey = `${node.id}_${inputId}_${widgetIndex}`;
                }
            }

            // Check if instance already exists
            if (PromptAssistant.hasInstance(assistantKey)) {
                // If instance exists, check if input widget has been updated
                const instance = PromptAssistant.getInstance(assistantKey);
                const currentInputEl = inputWidget.inputEl;
                const instanceInputEl = instance?.text_element;

                // Only clean up and rebuild when:
                // 1. Both elements exist
                // 2. They are different elements
                // 3. Not due to temporary DOM state change (e.g. opening popup)
                if (instanceInputEl && currentInputEl && instanceInputEl !== currentInputEl) {
                    // Further check: ensure rebuild is actually needed (avoid false positives)
                    // Only clean up if current element has been removed from DOM
                    if (!document.body.contains(instanceInputEl)) {
                        logger.debug(() => `[checkAndSetupNode] Input element invalidated, cleaning up instance | Node ID: ${node.id}`);
                        this.cleanup(node.id);
                    } else {
                        // Element still in DOM, may just be reference change, no cleanup needed
                        // logger.debug(() => `[checkAndSetupNode] Input element reference changed but still valid, skipping cleanup | Node ID: ${node.id}`);
                        return;
                    }
                } else if (!currentInputEl && instanceInputEl) {
                    // In Vue mode, inputEl may temporarily be null, should not trigger cleanup
                    logger.debug(() => `[checkAndSetupNode] Current inputEl is null, skipping cleanup (may be temporarily null in Vue mode) | Node ID: ${node.id}`);
                    return;
                } else {
                    // Instance exists and not updated, skip
                    return;
                }
            }

            // Re-check master switch state to ensure not disabled during creation
            if (!window.FEATURES.enabled) {
                return;
            }

            // [Duplicate mount check] Check if inputEl is already mounted by another instance before creation
            const inputEl = inputWidget.inputEl || inputWidget.element;
            if (inputEl && inputEl._promptAssistantMounted) {
                return;
            }

            // Create assistant instance
            const assistant = this.setupNodeAssistant(node, inputWidget, assistantKey);
            if (assistant) {
                logger.debugSample(() => `[Assistant] Instance created | Node:${node.id} | Widget:${inputId} | Index:${widgetIndex}`);
            }
        });
    }

    /**
 * Vue mode DOM scan handling for special or dynamic nodes (Note/Subgraph etc.)
 * When LiteGraph widgets are not yet ready, scan textarea directly from DOM and mount
 */
    _handleVueDomScanNode(node) {
        if (!node) return;

        const isMarkdown = this._isMarkdownNode(node);
        const isSubgraph = this._isSubgraphNode(node);

        // Only process nodes we recognize as valid
        if (!isMarkdown && !isSubgraph) return;

        const nodeId = node.id;

        // Use NodeMountService logic to find all potential input fields in the DOM container
        const nodeContainer = document.querySelector(`[data-node-id="${nodeId}"]`);
        if (!nodeContainer) {
            // If container is not rendered yet, start a single mount attempt with retry (for main input)
            if (isMarkdown) {
                this._retryDomScan(node, 'text');
            }
            return;
        }

        // Find all textareas (prefer PrimeVue .p-textarea)
        const primeTextareas = Array.from(nodeContainer.querySelectorAll('textarea.p-textarea'));
        const textareas = primeTextareas.length > 0 ? primeTextareas : Array.from(nodeContainer.querySelectorAll('textarea'));

        if (textareas.length === 0) {
            // May be TipTap editor (for Note nodes)
            const editor = nodeContainer.querySelector('.tiptap') || nodeContainer.querySelector('.ProseMirror');
            if (editor) {
                this._mountDomAssistant(node, editor, 'text', 0);
            }
            return;
        }

        // Iterate all found textareas and attempt to mount
        textareas.forEach((el, index) => {
            // Generate Key: Note nodes usually have one, subgraphs have multiple
            const inputId = textareas.length === 1 ? 'text' : `input_${index}`;
            this._mountDomAssistant(node, el, inputId, index);
        });
    }

    /**
     * Execute actual DOM mounting
     */
    _mountDomAssistant(node, element, inputId, index) {
        const assistantKey = `${node.id}_${inputId}`;
        if (PromptAssistant.hasInstance(assistantKey)) return;

        // Check if element is already mounted
        if (element._promptAssistantMounted) return;

        // Create virtual widget
        const virtualWidget = {
            name: inputId, id: inputId, type: 'textarea',
            inputEl: element, element: element, node: node,
            _domIndex: index // Record DOM index
        };

        const nodeInfo = {
            workflow_id: app.graph?._workflow_id || 'unknown',
            nodeType: node.type, inputType: 'text',
            isNoteNode: this._isMarkdownNode(node),
            isSubgraph: this._isSubgraphNode(node),
            isVueMode: true,
            domIndex: index
        };

        const assistant = this.createAssistant(node, inputId, virtualWidget, nodeInfo, assistantKey);
        if (assistant) {
            this.showAssistantUI(assistant);
            logger.debugSample(() => `[DOM Scan] ${node.type} node mounted successfully | ID: ${node.id} | Key: ${assistantKey}`);
        }
    }

    /**
     * Perform a scan with retry for cases where initial DOM is not ready
     */
    _retryDomScan(node, inputId) {
        const widgetStub = { name: inputId, node: node };
        nodeMountService.findMountContainerWithRetry(node, widgetStub, { timeout: 2000 })
            .then(result => {
                if (result && result.textarea) {
                    this._mountDomAssistant(node, result.textarea, inputId, 0);
                }
            });
    }

    /**
     * Set up assistant for node
     * Create assistant instance and initialize display state
     */
    setupNodeAssistant(node, inputWidget, assistantKey = null) {


        // Simplified parameter check
        if (!node || !inputWidget) {
            logger.error(`[setupNodeAssistant] Invalid parameters | node: ${!!node} | inputWidget: ${!!inputWidget}`);
            return null;
        }

        try {
            const nodeId = node.id;
            const inputId = inputWidget.name || inputWidget.id || Math.random().toString(36).substring(2, 10);
            const isNoteNode = this._isMarkdownNode(node);
            const isVueMode = typeof LiteGraph !== 'undefined' && LiteGraph.vueNodesMode === true;



            // Simplified node info
            const nodeInfo = {
                workflow_id: app.graph?._workflow_id || 'unknown',
                nodeType: node.type,
                inputType: inputId,
                isNoteNode: isNoteNode,
                isVueMode: isVueMode
            };

            // Handle inputWidget's inputEl reference
            let processedWidget = inputWidget;
            if (isNoteNode) {
                const inputEl = inputWidget.element || inputWidget.inputEl;
                processedWidget = {
                    ...inputWidget,
                    inputEl: inputEl,
                    _needsDelayedTextareaLookup: isVueMode && !inputEl
                };

            } else {

            }

            // Create assistant instance

            const assistant = this.createAssistant(
                node,
                inputId,
                processedWidget,
                nodeInfo,
                assistantKey
            );

            if (assistant) {

                // Initialize display state
                // Initialize display state
                this.showAssistantUI(assistant);
                return assistant;
            } else {
                console.warn(`[setupNodeAssistant] createAssistant returned null`);
            }

            return null;
        } catch (error) {
            logger.error(`[setupNodeAssistant] Exception | Node: ${node.id} | Error:`, error);
            logger.error(`Assistant creation failed | Node ID: ${node.id} | Reason: ${error.message}`);
            return null;
        }
    }

    /**
     * Create assistant instance
     * Build assistant object from node and input widget and initialize UI
     */
    createAssistant(node, inputId, inputWidget, nodeInfo = {}, assistantKey = null) {


        // Simplified pre-check
        if (!window.FEATURES.enabled || !node || !inputId || !inputWidget) {
            logger.error(`[createAssistant] Pre-check failed | enabled: ${window.FEATURES.enabled} | node: ${!!node} | inputId: ${inputId} | inputWidget: ${!!inputWidget}`);
            return null;
        }


        // Ensure widget has node reference set
        if (!inputWidget.node) {
            inputWidget.node = node;
        }

        // Validate if input is valid

        if (!UIToolkit.isValidInput(inputWidget, { node: node })) {
            console.warn(`[createAssistant] Invalid input | Node: ${node?.id} | Widget: ${inputId}`);
            return null;
        }


        // Get input element
        let inputEl = inputWidget.inputEl || inputWidget.element;
        const isVueMode = typeof LiteGraph !== 'undefined' && LiteGraph.vueNodesMode === true;



        // In non-Vue mode, inputEl must exist
        if (!inputEl && !isVueMode) {
            logger.error(`[createAssistant] inputEl does not exist in non-Vue mode | Node: ${node?.id}`);
            return null;
        }

        const nodeId = node.id;
        const widgetKey = assistantKey || `${nodeId}_${inputId}`;



        // Check if instance already exists
        if (PromptAssistant.hasInstance(widgetKey)) {

            return PromptAssistant.getInstance(widgetKey);
        }



        // Create assistant object
        const widget = {
            type: "prompt_assistant",
            name: inputId,
            nodeId,
            inputId,
            widgetKey,
            buttons: {},
            text_element: inputEl,
            inputEl: inputEl,
            isDestroyed: false,
            nodeInfo: {
                ...nodeInfo,
                nodeId: nodeId,
                nodeType: node.type,
                isVueMode: isVueMode
            },
            isTransitioning: false,
            // Save initial node reference as fallback (Vue Node 2.0 subgraph switching scenario)
            _initialNode: node
        };

        // Dynamic getter for node, avoid holding reference to deleted node
        // [Fix] Prefer getting from graph, fall back to initial reference on failure (fixes canvas not synced during subgraph switching)
        Object.defineProperty(widget, 'node', {
            get() {
                if (this.isDestroyed) return null;
                // Prefer dynamically getting from current canvas graph
                const graphNode = app.canvas?.graph?._nodes_by_id?.[this.nodeId];
                if (graphNode) return graphNode;
                // Fallback: use initial node reference (if still valid)
                if (this._initialNode && this._initialNode.id === this.nodeId) {
                    return this._initialNode;
                }
                return null;
            },
            configurable: true
        });



        // Create global input field mapping
        if (!window.PromptAssistantInputWidgetMap) {
            window.PromptAssistantInputWidgetMap = {};
        }

        window.PromptAssistantInputWidgetMap[widgetKey] = {
            inputEl: inputEl,
            widget: widget
        };



        // Create UI and add to instance collection
        this.createAssistantUI(widget, inputWidget);

        PromptAssistant.addInstance(widgetKey, widget);



        // Initialize bindings
        if (inputEl) {
            this._initializeInputElBindings(widget, inputWidget, node, inputId, nodeInfo);
        } else {

        }


        return widget;
    }

    /**
     * Initialize inputEl-related event bindings
     * Called immediately in traditional mode, called after finding textarea in Vue mode
     */
    _initializeInputElBindings(widget, inputWidget, node, inputId, nodeInfo) {
        const inputEl = inputWidget.inputEl || widget.inputEl;
        if (!inputEl) {
            logger.warn(`[_initializeInputElBindings] inputEl does not exist | Node ID: ${node?.id}`);
            return;
        }

        const nodeId = node.id;

        // Initialize undo state (only once, using widget-level flag)
        if (!widget._undoStateInitialized) {
            const initialValue = inputEl.value || '';
            // If initial value is not empty, add to history directly to ensure undo can restore to initial state
            if (initialValue.trim()) {
                HistoryCacheService.addHistoryAndUpdateUndoState(nodeId, inputId, initialValue, 'input');
            } else {
                HistoryCacheService.initUndoState(nodeId, inputId, initialValue);
            }
            widget._undoStateInitialized = true;
        }
        // Immediately update undo/redo button state on initialization
        UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);

        // Check if events already bound (avoid duplicate bindings)
        // [Key fix] Use widget-level flag to precisely control binding state
        // Ensure no false positive from _eventCleanupFunctions containing other cleanup functions (e.g. button menu)
        if (widget._inputEventsBound) {
            logger.debug(`[_initializeInputElBindings] Skipping binding | Node ID: ${nodeId} | Reason: Already bound`);
            return;
        }

        // If legacy flag detected, handle silently

        inputEl._promptAssistantBound = true;
        widget._inputEventsBound = true;
        widget._eventCleanupFunctions = widget._eventCleanupFunctions || [];

        // Bind input blur event, write to history
        // Use event manager to add DOM event listener
        const removeBlurListener = EventManager.addDOMListener(inputEl, 'blur', async () => {
            // logger.debug(`History write preparation | Reason: blur event triggered node_id=${node.id} input_id=${inputId}`);
            HistoryCacheService.addHistory({
                workflow_id: nodeInfo?.workflow_id || '',
                node_id: node.id,
                input_id: inputId,
                content: inputEl.value,
                operation_type: 'input',
                timestamp: Date.now()
            });
            // Reset undo state
            HistoryCacheService.initUndoState(node.id, inputId, inputEl.value);
            // Update button state
            UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);
            // logger.debug(`History write complete | Reason: input blur node_id=${node.id} input_id=${inputId}`);
        });

        // Save cleanup function reference for later cleanup
        widget._eventCleanupFunctions = widget._eventCleanupFunctions || [];
        widget._eventCleanupFunctions.push(removeBlurListener);

        // Add input event listener for real-time undo/redo button state and position adjustment
        const removeInputListener = EventManager.addDOMListener(inputEl, 'input', () => {
            UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);
            // Detect scrollbar state and adjust position
            this._adjustPositionForScrollbar(widget, inputEl);
        });
        widget._eventCleanupFunctions.push(removeInputListener);

        // Add ResizeObserver to monitor input field size changes
        if (window.ResizeObserver) {
            const resizeObserver = new ResizeObserver(() => {
                // Delay execution to ensure browser completes layout update
                setTimeout(() => {
                    this._adjustPositionForScrollbar(widget, inputEl);
                }, 10);
            });

            resizeObserver.observe(inputEl);

            // Add cleanup function
            widget._eventCleanupFunctions.push(() => {
                resizeObserver.disconnect();
            });
        } else {
            // Fallback: listen to window resize event
            const removeResizeListener = EventManager.addDOMListener(window, 'resize',
                EventManager.debounce(() => {
                    this._adjustPositionForScrollbar(widget, inputEl);
                }, 100)
            );
            widget._eventCleanupFunctions.push(removeResizeListener);
        }
    }

    // ---UI Management---
    /**
     * Create assistant UI
     * Build DOM elements and set up event listeners and initial styles
     */
    createAssistantUI(widget, inputWidget) {
        const nodeId = widget.nodeId;
        const inputId = widget.inputId;



        try {

            // Get location setting
            const locationSetting = app.ui.settings.getSettingValue(
                "PromptAssistant.Location"
            );



            // Create AssistantContainer instance
            const container = new AssistantContainer({
                nodeId: nodeId,
                type: 'prompt',
                anchorPosition: locationSetting,
                enableDragSort: true,
                onButtonOrderChange: (order) => {
                    logger.debug(`[Sort update] Node:${nodeId} | New order: ${order.join(',')}`);
                },
                shouldCollapse: () => {
                    return !this._checkAssistantActiveState(widget);
                }
            });



            // Render container
            const containerEl = container.render();



            // Set Icon
            const mainIcon = ResourceManager.getIcon('icon-main.svg');
            if (mainIcon) {
                if (container.indicator) {
                    container.indicator.innerHTML = '';
                    container.indicator.appendChild(mainIcon);
                }
            }



            // Save references
            widget.container = container;
            widget.element = containerEl;
            widget.innerContent = container.content;
            widget.hoverArea = container.hoverArea;
            widget.indicator = container.indicator;
            widget.buttons = {};

            Object.defineProperty(widget, 'isCollapsed', {
                get: () => container.isCollapsed,
                set: (val) => {
                    if (val) container.collapse(); else container.expand();
                }
            });
            Object.defineProperty(widget, 'isTransitioning', {
                get: () => container.isTransitioning,
                set: (val) => { container.isTransitioning = val; }
            });



            // Initialize buttons
            this.addFunctionButtons(widget);



            // Restore button order
            container.restoreOrder();



            // Setup Positioning
            const inputEl = inputWidget.inputEl || widget.inputEl;
            const graphCanvasContainer = document.querySelector('.graphcanvas');
            const canvasContainerRect = graphCanvasContainer?.getBoundingClientRect();




            this._setupUIPosition(widget, inputEl, containerEl, canvasContainerRect, (success) => {

                if (!success) {
                    logger.debugSample(() => `[小助手] 创建暂缓 | 节点ID: ${nodeId} | 原因: 定位容器未就绪 (等待DOM渲染)`);
                    container.destroy();
                    const widgetKey = widget.widgetKey;
                    if (widgetKey && PromptAssistant.instances.has(widgetKey)) {
                        PromptAssistant.instances.delete(widgetKey);
                    }
                    if (window.PromptAssistantInputWidgetMap && widgetKey) {
                        delete window.PromptAssistantInputWidgetMap[widgetKey];
                    }
                    return;
                }

                // 定位成功后更新尺寸
                container.updateDimensions();
            });

            return containerEl;
        } catch (error) {
            console.error(`[createAssistantUI] ❌ 异常 | 节点: ${nodeId} | 错误:`, error);
            logger.error(`创建小助手失败 | 节点ID: ${nodeId} | 原因: ${error.message}`);
            return null;
        }
    }

    /**
     * 显示小助手UI
     * 控制UI显示动画和状态，创建时直接以折叠状态显示
     */
    showAssistantUI(widget, forceAnimation = false) {
        if (!widget?.element) return;

        // 避免重复显示
        if (widget.element.classList.contains('assistant-show')) {
            // 确保元素可见
            widget.element.style.display = 'flex';
            widget.element.style.opacity = '1';
            return;
        }

        // 直接显示，无动画过渡
        widget.element.style.opacity = '1';
        widget.element.style.display = 'flex';
        widget.element.classList.add('assistant-show');

        // 确保悬停区域可见（用于折叠状态下的交互）
        if (widget.isCollapsed && widget.hoverArea) {
            widget.hoverArea.style.display = 'block';
        }

        // 重置过渡状态
        widget.isTransitioning = false;

        // 只有当明确不是折叠状态时才触发自动折叠
        if (!widget.isCollapsed) {
            this.triggerAutoCollapse(widget);
        }
    }

    /**
     * 检查并触发自动折叠（如果需要）
     */
    _triggerAutoCollapseIfNeeded(widget) {
        if (widget && widget.container) {
            widget.container.collapse();
        }
    }




    /**
     * 展开小助手
     */
    _expandAssistant(widget) {
        if (widget && widget.container) {
            widget.container.expand();
        }
    }



    /**
     * 公开方法：触发小助手自动折叠
     * 供外部模块调用，用于在操作完成后折叠小助手UI
     */
    triggerAutoCollapse(widget) {
        return this._triggerAutoCollapseIfNeeded(widget);
    }

    /**
     * 更新小助手可见性
     * 始终显示小助手，不再根据鼠标悬停状态来决定
     */
    updateAssistantVisibility(widget) {
        if (!widget) return;

        // 总开关关闭时不处理可见性更新
        if (!window.FEATURES || !window.FEATURES.enabled) {
            return;
        }

        // 检查是否有按钮处于激活或处理中状态
        const hasActiveButtons = this._checkAssistantActiveState(widget);

        // 如果有激活的按钮，强制显示小助手（带动画）并取消自动折叠
        if (hasActiveButtons) {
            this.showAssistantUI(widget, true);

            // 取消可能的自动折叠定时器
            if (widget._autoCollapseTimer) {
                clearTimeout(widget._autoCollapseTimer);
                widget._autoCollapseTimer = null;
            }

            // 如果当前是折叠状态，则展开 - 使用requestAnimationFrame
            if (widget.isCollapsed) {
                requestAnimationFrame(() => {
                    this._expandAssistant(widget);
                });
            }

            return;
        }

        // 始终显示小助手，不再检查鼠标状态
        const isCurrentlyShown = widget.element?.classList.contains('assistant-show');
        if (!isCurrentlyShown) {
            this.showAssistantUI(widget, false);
            logger.debug(`UI显示 | 节点:${widget.nodeId} | 原因:始终显示`);
        } else {
            // 已经显示，检查是否需要自动折叠
            this.triggerAutoCollapse(widget);
        }
    }

    /**
     * 检查小助手是否有按钮处于激活状态
     */
    _checkAssistantActiveState(widget) {
        if (!widget || !widget.buttons) return false;

        // 0. 检查是否正在切换弹窗（切换期间不允许折叠）
        if (PopupManager._isTransitioning) {
            return true;
        }

        // 1. 检查右键菜单是否可见（并且属于当前 widget）
        if (buttonMenu.isMenuVisible && buttonMenu.menuContext?.widget === widget) {
            return true;
        }

        // 2. 检查中央按钮状态管理器是否有该widget的激活按钮
        const activeButtonInfo = UIToolkit.getActiveButtonInfo();
        if (activeButtonInfo && activeButtonInfo.widget === widget) {
            return true;
        }

        // 3. 检查 PopupManager 的活动弹窗是否属于当前 widget
        if (PopupManager.activePopupInfo?.buttonInfo?.widget === widget) {
            return true;
        }

        // 4. 检查按钮的 active/processing 状态
        for (const buttonId in widget.buttons) {
            const button = widget.buttons[buttonId];
            if (button.classList.contains('button-active') ||
                button.classList.contains('button-processing')) {
                return true;
            }
        }

        return false;
    }

    /**
     * 更新所有实例的可见性
     * 在按钮状态变化时调用
     */
    updateAllInstancesVisibility() {
        PromptAssistant.instances.forEach(widget => {
            this.updateAssistantVisibility(widget);
        });
    }

    /**
     * 更新所有实例的预设宽度
     * 在功能开关变更时调用，重新计算并设置宽度
     */
    updateAllInstancesWidth() {
        // 优化：不再手动计算宽度并注入，而是触发每个容器自身的常量布局逻辑
        logger.debug(`[布局更新] 触发所有实例尺寸重算 | 实例数量:${PromptAssistant.instances.size}`);

        PromptAssistant.instances.forEach((widget) => {
            if (widget && widget.container && typeof widget.container.updateDimensions === 'function') {
                widget.container.updateDimensions();
            }
        });
    }

    /**
     * 显示状态提示
     * 创建临时提示信息气泡
     */
    showStatusTip(anchorElement, type, message, position = null) {
        return UIToolkit.showStatusTip(anchorElement, type, message, position);
    }

    // ---事件处理功能---
    /**
     * 设置UI事件处理
     * 配置按钮事件监听 - 简化版本
     */
    _setupUIEventHandling(widget, inputEl, containerDiv) {
        // 事件处理已委托给 AssistantContainer
        // 我们保留此方法是为了兼容外部调用，但现在它不执行任何操作。
    }



    // ---辅助功能---
    /**
     * 更新输入框内容并添加高亮效果
     */
    updateInputWithHighlight(widget, content, options = {}) {
        if (!widget?.inputEl) return;

        try {
            // 更新输入框内容 - 使用统一的setInputValue函数
            const success = setInputValue(widget, content, options);

            if (!success) {
                logger.warn(`输入框更新 | 结果:失败 | setInputValue返回false`);
                return;
            }

            // 使用统一的高亮工具方法 (处理了定时器管理和重绘)
            UIToolkit._highlightInput(widget.inputEl);
        } catch (error) {
            logger.error(`输入框更新 | 结果:异常 | 错误:${error.message}`);
        }
    }

    // ---按钮管理功能---
    /**
     * 添加功能按钮
     */
    addFunctionButtons(widget) {
        if (!widget?.element) {
            logger.error('添加按钮 | 结果:失败 | 原因: 容器不存在');
            return;
        }

        // 检查总开关状态
        if (!FEATURES.enabled) {
            logger.debug('添加按钮 | 结果:跳过 | 原因: 总功能已禁用');
            return;
        }

        // 检查是否有至少一个功能启用
        const hasEnabledFeatures = FEATURES.history || FEATURES.tag || FEATURES.expand || FEATURES.translate;
        if (!hasEnabledFeatures) {
            logger.debug('添加按钮 | 结果:跳过 | 原因: 没有启用任何功能');
            return;
        }

        // 检查是否是Note/MarkdownNote节点
        const isNoteNode = widget.nodeInfo && (widget.nodeInfo.isNoteNode === true || widget.nodeInfo.nodeType === 'MarkdownNote');

        // 获取历史状态（用于初始化撤销/重做按钮状态）
        const canUndo = HistoryCacheService.canUndo(widget.nodeId, widget.inputId);
        const canRedo = HistoryCacheService.canRedo(widget.nodeId, widget.inputId);

        // 按钮配置
        const buttonConfigs = [
            {
                id: 'history',
                title: 'History',
                icon: 'icon-history',
                onClick: (e, widget) => {
                    UIToolkit.handlePopupButtonClick(
                        e,
                        widget,
                        'history',
                        HistoryManager.showHistoryPopup.bind(HistoryManager),
                        HistoryManager.hideHistoryPopup.bind(HistoryManager)
                    );
                },
                visible: !isNoteNode && FEATURES.history, // Note节点不显示此按钮
                initialState: { disabled: false }
            },
            {
                id: 'undo',
                title: 'Undo',
                icon: 'icon-undo',
                onClick: (e, widget) => {
                    e.preventDefault();
                    e.stopPropagation();
                    logger.debug('按钮点击 | 动作: 撤销');

                    // 执行撤销操作
                    const undoContent = HistoryCacheService.undo(widget.nodeId, widget.inputId);
                    if (undoContent !== null) {
                        // 更新输入框内容并添加高亮效果
                        this.updateInputWithHighlight(widget, undoContent);

                        // 更新按钮状态
                        UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);

                        logger.debug(`撤销操作 | 结果:成功 | 节点:${widget.nodeId}`);
                    } else {
                        logger.debug(`撤销操作 | 结果:失败 | 节点:${widget.nodeId} | 原因:无可用内容`);
                    }
                },
                visible: !isNoteNode && FEATURES.history,
                initialState: { disabled: !canUndo }
            },
            {
                id: 'redo',
                title: 'Redo',
                icon: 'icon-redo',
                onClick: (e, widget) => {
                    e.preventDefault();
                    e.stopPropagation();
                    logger.debug('按钮点击 | 动作: 重做');

                    // 执行重做操作
                    const redoContent = HistoryCacheService.redo(widget.nodeId, widget.inputId);
                    if (redoContent !== null) {
                        // 更新输入框内容并添加高亮效果
                        this.updateInputWithHighlight(widget, redoContent);

                        // 更新按钮状态
                        UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);

                        logger.debug(`重做操作 | 结果:成功 | 节点:${widget.nodeId}`);
                    } else {
                        logger.debug(`重做操作 | 结果:失败 | 节点:${widget.nodeId} | 原因:无可用内容`);
                    }
                },
                visible: !isNoteNode && FEATURES.history,
                initialState: { disabled: !canRedo }
            },
            {
                id: 'divider1',
                type: 'divider',
                visible: !isNoteNode && FEATURES.history // Note节点不显示，且跟随历史功能开关
            },
            {
                id: 'tag',
                title: 'Tags',
                icon: 'icon-tag',
                onClick: (e, widget) => {
                    // 创建一个带有标签选择功能的显示函数
                    const showTagPopup = (options) => {
                        // 处理标签选择功能
                        const enhancedOptions = {
                            ...options,
                            onTagSelect: (tag) => {
                                // 获取当前输入框的值和光标位置
                                const currentValue = widget.inputEl.value;
                                const cursorPos = widget.inputEl.selectionStart;
                                const beforeText = currentValue.substring(0, cursorPos);
                                const afterText = currentValue.substring(widget.inputEl.selectionEnd);

                                // 添加标签（英文值）
                                const newValue = beforeText + tag.en + afterText;

                                // 更新输入框内容并添加高亮效果
                                this.updateInputWithHighlight(widget, newValue);

                                // 更新光标位置
                                const newPos = cursorPos + tag.en.length;
                                widget.inputEl.setSelectionRange(newPos, newPos);

                                // 保持焦点在输入框
                                widget.inputEl.focus();
                            }
                        };

                        // 调用标签管理器显示弹窗
                        TagManager.showTagPopup(enhancedOptions);
                    };

                    // 使用统一的弹窗按钮点击处理
                    UIToolkit.handlePopupButtonClick(
                        e,
                        widget,
                        'tag',
                        showTagPopup,
                        TagManager.hideTagPopup.bind(TagManager)
                    );
                },
                visible: !isNoteNode && FEATURES.tag // Note节点不显示此按钮
            },
            {
                id: 'expand',
                title: 'Enhance',
                icon: 'icon-expand',
                onClick: async (e, widget) => {
                    logger.debug('按钮点击 | 动作: 提示词优化');

                    // 如果按钮处于 processing 状态且被点击，直接返回，
                    // 让UIToolkit中的取消逻辑接管
                    if (e.currentTarget.classList.contains('button-processing')) {
                        return;
                    }

                    await UIToolkit.handleAsyncButtonOperation(
                        widget,
                        'expand',
                        e.currentTarget,
                        async (notifyCancelReady) => {
                            try {
                                // 获取输入值 - 使用统一的getInputValue函数
                                const inputValue = getInputValue(widget);
                                logger.debug(`[提示词优化] 获取到的输入值长度: ${inputValue?.length || 0}`);

                                if (!inputValue || inputValue.trim() === '') {
                                    throw new Error('Please enter a prompt to enhance');
                                }

                                // 生成唯一request_id
                                const request_id = APIService.generateRequestId('exp', null, widget.nodeId);

                                // 通知UI可以准备取消操作了
                                notifyCancelReady(request_id);

                                // 根据开关选择流式或阻塞式 API
                                let result;
                                let streamContent = '';

                                if (FEATURES.enableStreaming !== false) {
                                    // 显示流式优化中提示
                                    const btnRect = e.currentTarget.getBoundingClientRect();
                                    UIToolkit.showStatusTip(
                                        e.currentTarget,
                                        'loading',
                                        '提示词优化中',
                                        { x: btnRect.left + btnRect.width / 2, y: btnRect.top }
                                    );

                                    result = await APIService.llmExpandPromptStream(
                                        inputValue,
                                        request_id,
                                        (chunk) => {
                                            // 流式回调：实时更新输入框内容
                                            streamContent += chunk;
                                            // 使用 setInputValue 更新输入框（不触发事件，避免频繁抖动）
                                            setInputValue(widget, streamContent, { silent: true });
                                        }
                                    );
                                } else {
                                    // 显示阻塞式优化中提示
                                    const btnRect = e.currentTarget.getBoundingClientRect();
                                    UIToolkit.showStatusTip(
                                        e.currentTarget,
                                        'loading',
                                        '提示词优化中',
                                        { x: btnRect.left + btnRect.width / 2, y: btnRect.top }
                                    );

                                    result = await APIService.llmExpandPrompt(inputValue, request_id);
                                }

                                // 流式完成后，获取最终内容
                                const finalContent = streamContent || result?.data?.expanded || '';

                                if (result && result.success && finalContent) {
                                    // 最终更新（触发事件和高亮）
                                    this.updateInputWithHighlight(widget, finalContent);

                                    // 添加扩写结果到历史记录（只记录最终结果）
                                    HistoryCacheService.addHistory({
                                        workflow_id: widget.nodeInfo?.workflow_id || '',
                                        node_id: widget.nodeId,
                                        input_id: widget.inputId,
                                        content: finalContent,
                                        operation_type: 'expand',
                                        request_id: request_id,
                                        timestamp: Date.now()
                                    });

                                    // 重置撤销状态
                                    HistoryCacheService.initUndoState(widget.nodeId, widget.inputId, finalContent);

                                    // 更新按钮状态
                                    UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);

                                    return {
                                        success: true,
                                        useCache: false,
                                        tipType: 'success',
                                        tipMessage: '提示词优化完成'
                                    };
                                } else {
                                    // 不在这里显示错误提示，直接抛出错误让 handleAsyncButtonOperation 处理
                                    throw new Error(result?.error || '扩写失败');
                                }
                            } catch (error) {
                                // 不在这里显示错误提示，直接抛出错误让 handleAsyncButtonOperation 处理
                                throw error;
                            }
                        }
                    );
                },
                visible: !isNoteNode && FEATURES.expand, // Note节点不显示此按钮
                // 添加右键菜单配置
                contextMenu: async (widget) => {
                    // 获取服务列表和当前激活状态
                    let services = [];
                    let currentLLMService = null;
                    let currentLLMModel = null;

                    // 获取扩写规则
                    let activePromptId = null;
                    let expandPrompts = [];

                    try {
                        // 获取服务列表
                        const servicesResp = await fetch(APIService.getApiUrl('/services'));
                        if (servicesResp.ok) {
                            const servicesData = await servicesResp.json();
                            if (servicesData.success) {
                                services = servicesData.services || [];
                            }
                        }

                        // 获取当前激活的LLM服务和模型
                        const llmResp = await fetch(APIService.getApiUrl('/config/llm'));
                        if (llmResp.ok) {
                            const llmConfig = await llmResp.json();
                            currentLLMService = llmConfig.provider || null;
                            currentLLMModel = llmConfig.model || null;
                        }

                        // 获取扩写规则
                        const response = await fetch(APIService.getApiUrl('/config/system_prompts'));
                        if (response.ok) {
                            const data = await response.json();
                            activePromptId = data.active_prompts?.expand || null;

                            if (data.expand_prompts) {
                                const originalOrder = Object.keys(data.expand_prompts);
                                originalOrder.forEach(key => {
                                    const prompt = data.expand_prompts[key];
                                    const showIn = prompt.showIn || ['frontend', 'node'];

                                    // 仅当配置包含 'frontend' 时才在前端菜单显示
                                    if (showIn.includes('frontend')) {
                                        expandPrompts.push({
                                            id: key,
                                            name: prompt.name || key,
                                            category: prompt.category || '',
                                            content: prompt.content,
                                            showIn: showIn,
                                            isActive: key === activePromptId
                                        });
                                    }
                                });
                                expandPrompts.sort((a, b) =>
                                    originalOrder.indexOf(a.id) - originalOrder.indexOf(b.id)
                                );
                            }
                        }
                    } catch (error) {
                        logger.error(`获取提示词优化配置失败: ${error.message}`);
                    }

                    // 创建服务菜单项(只显示有LLM模型的服务,不包括百度)
                    const serviceMenuItems = services
                        .filter(service => service.llm_models && service.llm_models.length > 0)
                        .map(service => {
                            const isCurrentService = currentLLMService === service.id;

                            // 创建模型子菜单
                            const modelChildren = (service.llm_models || []).map(model => {
                                const isCurrentModel = isCurrentService && currentLLMModel === model.name;
                                return {
                                    label: model.display_name || model.name,
                                    icon: `<span class="pi ${isCurrentModel ? 'pi-check-circle active-status' : 'pi-circle-off inactive-status'}"></span>`,
                                    onClick: async (context) => {
                                        try {
                                            const res = await fetch(APIService.getApiUrl('/services/current'), {
                                                method: 'POST',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({ service_type: 'llm', service_id: service.id, model_name: model.name })
                                            });
                                            if (!res.ok) throw new Error(`Server error: ${res.status}`);
                                            const modelLabel = model.display_name || model.name;
                                            UIToolkit.showStatusTip(context.buttonElement, 'success', `Switched to: ${service.name} - ${modelLabel}`);
                                            logger.log(`提示词优化服务切换 | 服务: ${service.name} | 模型: ${modelLabel}`);
                                        } catch (err) {
                                            logger.error(`切换提示词优化模型失败: ${err.message}`);
                                            UIToolkit.showStatusTip(context.buttonElement, 'error', `Switch failed: ${err.message}`);
                                        }
                                    }
                                };
                            });

                            return {
                                label: service.name || service.id,
                                icon: `<span class="pi ${isCurrentService ? 'pi-check-circle active-status' : 'pi-circle-off inactive-status'}"></span>`,
                                onClick: async (context) => {
                                    try {
                                        const res = await fetch(APIService.getApiUrl('/services/current'), {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ service_type: 'llm', service_id: service.id })
                                        });
                                        if (!res.ok) throw new Error(`Server error: ${res.status}`);
                                        UIToolkit.showStatusTip(context.buttonElement, 'success', `Switched to: ${service.name}`);
                                        logger.log(`提示词优化服务切换 | 服务: ${service.name}`);
                                    } catch (err) {
                                        logger.error(`切换提示词优化服务失败: ${err.message}`);
                                        UIToolkit.showStatusTip(context.buttonElement, 'error', `Switch failed: ${err.message}`);
                                    }
                                },
                                children: modelChildren.length > 0 ? modelChildren : undefined
                            };
                        });

                    // ---创建规则菜单项（支持分类分组）---
                    const ruleMenuItems = [];

                    // 辅助函数：创建单个规则菜单项
                    const createRuleMenuItem = (prompt) => ({
                        label: prompt.name,
                        icon: `<span class="pi ${prompt.isActive ? 'pi-check-circle active-status' : 'pi-circle-off inactive-status'}"></span>`,
                        onClick: async (context) => {
                            logger.log(`右键菜单 | 动作: 切换提示词优化 | ID: ${prompt.id}`);
                            try {
                                const response = await fetch(APIService.getApiUrl('/config/active_prompt'), {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ type: 'expand', prompt_id: prompt.id })
                                });
                                if (response.ok) {
                                    UIToolkit.showStatusTip(context.buttonElement, 'success', `Switched to: ${prompt.name}`);
                                } else {
                                    throw new Error(`Server error: ${response.status}`);
                                }
                            } catch (error) {
                                logger.error(`切换提示词优化失败: ${error.message}`);
                                UIToolkit.showStatusTip(context.buttonElement, 'error', `Switch failed: ${error.message}`);
                            }
                        }
                    });

                    // 按分类分组规则
                    const uncategorizedPrompts = expandPrompts.filter(p => !p.category);
                    const categorizedPrompts = expandPrompts.filter(p => p.category);

                    // 收集所有分类并排序
                    const categories = [...new Set(categorizedPrompts.map(p => p.category))].sort();

                    // 添加无分类的规则（放在顶层）
                    uncategorizedPrompts.forEach(prompt => {
                        ruleMenuItems.push(createRuleMenuItem(prompt));
                    });

                    // 添加分类分组（每个分类作为二级菜单）
                    categories.forEach(category => {
                        const promptsInCategory = categorizedPrompts.filter(p => p.category === category);
                        const hasActivePrompt = promptsInCategory.some(p => p.isActive);

                        ruleMenuItems.push({
                            label: category,
                            icon: `<span class="pi ${hasActivePrompt ? 'pi-folder-open' : 'pi-folder'}"></span>`,
                            submenuAlign: 'center',
                            children: promptsInCategory.map(prompt => createRuleMenuItem(prompt))
                        });
                    });


                    // Add rule management option
                    ruleMenuItems.push({ type: 'separator' });
                    ruleMenuItems.push({
                        label: 'Rule Manager',
                        icon: '<span class="pi pi-pen-to-square"></span>',
                        onClick: () => {
                            rulesConfigManager.showRulesConfigModal();
                        }
                    });

                    return [
                        ...ruleMenuItems,
                        // { type: 'separator' },
                        {
                            label: "选择服务",
                            icon: '<span class="pi pi-sparkles"></span>',
                            submenuAlign: 'bottom',
                            children: serviceMenuItems
                        }
                    ];
                }
            },
            {
                id: 'translate',
                title: 'Translate',
                icon: 'icon-translate',
                onClick: async (e, widget) => {
                    logger.debug('按钮点击 | 动作: 翻译');

                    // 如果按钮处于 processing 状态且被点击，直接返回，
                    // 让UIToolkit中的取消逻辑接管
                    if (e.currentTarget.classList.contains('button-processing')) {
                        return;
                    }

                    await UIToolkit.handleAsyncButtonOperation(
                        widget,
                        'translate',
                        e.currentTarget,
                        async (notifyCancelReady) => {
                            try {
                                // --- Markdown LiteGraph 模式处理 ---
                                // 增强判断逻辑：除了检查nodeType，也检查DOM类名
                                const hasMarkdownClass = widget.inputEl?.classList?.contains('comfy-markdown');
                                const isMarkdownLiteGraph = (widget.nodeInfo?.nodeType === 'MarkdownNote' || hasMarkdownClass) &&
                                    widget.nodeInfo?.isVueMode !== true;

                                logger.debug(`[翻译调试] Markdown检测: ${isMarkdownLiteGraph} (Type: ${widget.nodeInfo?.nodeType}, HasClass: ${hasMarkdownClass})`);

                                // 获取输入值 - 根据模式决定是否获取HTML
                                const inputValue = getInputValue(widget, { html: isMarkdownLiteGraph });

                                if (!inputValue || inputValue.trim() === '') {
                                    throw new Error('Please enter text to translate');
                                }

                                let contentToTranslate = inputValue;
                                let mdData = null;

                                if (isMarkdownLiteGraph) {
                                    mdData = MarkdownNoteTranslate.protectAndExtract(inputValue);
                                    if (mdData.texts && mdData.texts.length > 0) {
                                        contentToTranslate = mdData.texts.join('\n');
                                    } else {
                                        // 如果提取后没有文本（只有标签/代码），则认为空或者无需翻译
                                        if (!contentToTranslate || contentToTranslate.trim() === '') {
                                            // 保持原样或抛出错误，这里选择抛出提示
                                            throw new Error('No translatable content detected');
                                        }
                                        // 如果原内容有东西但提取为空，可能全是代码块，保留原内容作为待翻译（实际上API可能跳过）
                                        // 或者这里 contentToTranslate 为 inputValue ?
                                        // 不，protectAndExtract 没提取到，说明不该翻译。
                                        // 但为了流程继续，如果不抛错，我们假设 contentToTranslate 为空导致后续报错
                                    }
                                }

                                if (!contentToTranslate || contentToTranslate.trim() === '') {
                                    throw new Error('Please enter text to translate');
                                }

                                // 显示翻译中提示
                                const btnRect = e.currentTarget.getBoundingClientRect();
                                UIToolkit.showStatusTip(
                                    e.currentTarget,
                                    'loading',
                                    '翻译中',
                                    { x: btnRect.left + btnRect.width / 2, y: btnRect.top }
                                );

                                // 1. 查询缓存
                                let cacheResult = null;
                                if (FEATURES.useTranslateCache) {
                                    cacheResult = TranslateCacheService.queryTranslateCache(contentToTranslate);
                                }

                                if (cacheResult) {
                                    let rawResultText = '';
                                    let tipMessage = '';
                                    let useCache = true;

                                    // 根据缓存匹配类型处理
                                    if (cacheResult.type === 'source') {
                                        // 命中原文，返回译文
                                        rawResultText = cacheResult.translatedText;
                                        tipMessage = '译文';
                                    } else if (cacheResult.type === 'translated') {
                                        // 命中译文，返回原文
                                        rawResultText = cacheResult.sourceText;
                                        tipMessage = '原文';
                                    }

                                    // 处理 Markdown 格式还原
                                    let finalResultText = rawResultText;
                                    if (isMarkdownLiteGraph && mdData) {
                                        const translatedSegments = rawResultText.split('\n');
                                        finalResultText = MarkdownNoteTranslate.restoreWithTranslations(mdData.placeholderHTML, mdData.placeholders, translatedSegments);
                                    }

                                    // 更新输入框内容并添加高亮效果
                                    this.updateInputWithHighlight(widget, finalResultText, { html: isMarkdownLiteGraph });

                                    // 添加翻译结果到历史记录
                                    HistoryCacheService.addHistory({
                                        workflow_id: widget.nodeInfo?.workflow_id || '',
                                        node_id: widget.nodeId,
                                        input_id: widget.inputId,
                                        content: finalResultText,
                                        operation_type: 'translate',
                                        timestamp: Date.now()
                                    });

                                    // 重置撤销状态
                                    HistoryCacheService.initUndoState(widget.nodeId, widget.inputId, finalResultText);

                                    // 更新按钮状态
                                    UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);

                                    return {
                                        success: true,
                                        useCache: useCache,
                                        tipType: 'info',
                                        tipMessage: tipMessage,
                                        buttonElement: e.currentTarget // 传递按钮元素
                                    };
                                }

                                // 缓存未命中，使用API翻译

                                // 生成唯一request_id
                                const request_id = APIService.generateRequestId('trans', null, widget.nodeId);

                                // 通知UI可以准备取消操作了
                                notifyCancelReady(request_id);

                                // 检测语言 (使用提取后的文本)
                                const langResult = PromptFormatter.detectLanguage(contentToTranslate);

                                // 获取翻译服务配置
                                let result;
                                let streamContent = '';  // 用于流式收集内容
                                try {
                                    // 获取翻译配置
                                    const configResp = await fetch(APIService.getApiUrl('/config/translate'));
                                    let isBaidu = false;

                                    if (configResp.ok) {
                                        const config = await configResp.json();
                                        // 检查provider是否为'baidu'
                                        if (config.provider === 'baidu') {
                                            isBaidu = true;
                                        }
                                    }

                                    if (isBaidu) {
                                        // 百度翻译不支持流式，使用原有接口（自动降级）
                                        result = await APIService.baiduTranslate(
                                            contentToTranslate,
                                            langResult.from,
                                            langResult.to,
                                            request_id
                                        );
                                    } else if (FEATURES.enableStreaming !== false) {
                                        // ---流式输出：LLM翻译使用流式 API---
                                        result = await APIService.llmTranslateStream(
                                            contentToTranslate,
                                            langResult.from,
                                            langResult.to,
                                            request_id,
                                            (chunk) => {
                                                // 流式回调：实时更新输入框内容
                                                streamContent += chunk;
                                                // 使用 silent 模式更新，避免频繁触发事件
                                                setInputValue(widget, streamContent, { silent: true, html: isMarkdownLiteGraph });
                                            }
                                        );
                                    } else {
                                        // ---阻塞输出：LLM翻译使用普通 API---
                                        result = await APIService.llmTranslate(
                                            contentToTranslate,
                                            langResult.from,
                                            langResult.to,
                                            request_id
                                        );
                                    }

                                    if (!result) {
                                        throw new Error('Translation service returned empty result');
                                    }
                                } catch (error) {
                                    logger.error(`翻译失败 | 错误:${error.message}`);
                                    throw new Error(`翻译失败: ${error.message}`);
                                }

                                if (result.success) {
                                    // 格式化翻译结果（优先使用流式收集的内容，否则使用API返回的内容）
                                    const rawTranslated = streamContent || result.data?.translated || '';
                                    const formattedText = PromptFormatter.formatTranslatedText(rawTranslated);

                                    // 处理 Markdown 格式还原
                                    let finalResultText = formattedText;
                                    if (isMarkdownLiteGraph && mdData) {
                                        const translatedSegments = formattedText.split('\n');
                                        finalResultText = MarkdownNoteTranslate.restoreWithTranslations(mdData.placeholderHTML, mdData.placeholders, translatedSegments);
                                    }

                                    // 添加翻译结果到历史记录
                                    HistoryCacheService.addHistory({
                                        workflow_id: widget.nodeInfo?.workflow_id || '',
                                        node_id: widget.nodeId,
                                        input_id: widget.inputId,
                                        content: finalResultText,
                                        operation_type: 'translate',
                                        request_id: request_id,
                                        timestamp: Date.now()
                                    });

                                    // 更新输入框内容并添加高亮效果
                                    this.updateInputWithHighlight(widget, finalResultText, { html: isMarkdownLiteGraph });

                                    // 重置撤销状态
                                    HistoryCacheService.initUndoState(widget.nodeId, widget.inputId, finalResultText);

                                    // 更新按钮状态
                                    UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);

                                    // 只有开启缓存时才写入缓存 (使用提取文本和翻译后的片段文本，以便下次能复用)
                                    if (FEATURES.useTranslateCache) {
                                        // 检查是否是混合语言
                                        const isMixedLang = PromptFormatter.isMixedChineseEnglish(contentToTranslate);

                                        // 只有当不是混合语言，或者用户允许缓存混合语言时才写入缓存
                                        if (!isMixedLang || FEATURES.cacheMixedLangTranslation) {
                                            TranslateCacheService.addTranslateCache(contentToTranslate, formattedText);
                                        } else {
                                            logger.debug(`翻译缓存 | 跳过:混合语言内容`);
                                        }
                                    }

                                    return {
                                        success: true,
                                        useCache: false,
                                        tipType: 'success',
                                        tipMessage: '翻译完成'
                                    };
                                } else {
                                    // 不在这里显示错误提示，直接抛出错误让 handleAsyncButtonOperation 处理
                                    throw new Error(result.error);
                                }
                            } catch (error) {
                                // 不在这里显示错误提示，直接抛出错误让 handleAsyncButtonOperation 处理
                                throw error;
                            }
                        }
                    );
                },
                visible: FEATURES.translate, // Note节点只显示此按钮
                // 添加右键菜单配置
                contextMenu: async (widget) => {
                    const useTranslateCache = app.ui.settings.getSettingValue("PromptAssistant.Features.UseTranslateCache");

                    // 获取所有服务列表和当前激活状态
                    let services = [];
                    let currentTranslateService = null;
                    let currentTranslateModel = null;

                    try {
                        // 获取服务列表
                        const servicesResp = await fetch(APIService.getApiUrl('/services'));
                        if (servicesResp.ok) {
                            const servicesData = await servicesResp.json();
                            if (servicesData.success) {
                                services = servicesData.services || [];
                            }
                        }

                        // 获取当前激活的翻译服务和模型
                        const translateResp = await fetch(APIService.getApiUrl('/config/translate'));
                        if (translateResp.ok) {
                            const translateConfig = await translateResp.json();
                            currentTranslateService = translateConfig.provider || null;
                            currentTranslateModel = translateConfig.model || null;
                        }
                    } catch (e) {
                        logger.error(`获取服务列表失败: ${e.message}`);
                    }

                    // 创建服务菜单项
                    const serviceMenuItems = [];

                    // 百度翻译项（永远显示在第一位）
                    const isBaiduCurrent = currentTranslateService === 'baidu';
                    serviceMenuItems.push({
                        label: '百度翻译',
                        icon: `<span class="pi ${isBaiduCurrent ? 'pi-check-circle active-status' : 'pi-circle-off inactive-status'}"></span>`,
                        onClick: async (context) => {
                            try {
                                const res = await fetch(APIService.getApiUrl('/services/current'), {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ service_type: 'translate', service_id: 'baidu' })
                                });
                                if (!res.ok) throw new Error(`Server error: ${res.status}`);
                                UIToolkit.showStatusTip(context.buttonElement, 'success', `Switched to: Baidu Translate`);
                                logger.log(`翻译服务切换 | 服务: 百度翻译`);

                                // 派发全局事件通知其他组件同步
                                window.dispatchEvent(new CustomEvent('pa-service-changed', {
                                    detail: { service_type: 'translate', service_id: 'baidu' }
                                }));
                            } catch (err) {
                                logger.error(`切换翻译服务失败: ${err.message}`);
                                UIToolkit.showStatusTip(context.buttonElement, 'error', `Switch failed: ${err.message}`);
                            }
                        }
                    });

                    // 动态添加其他LLM服务
                    const otherServiceMenuItems = services
                        .filter(service => service.llm_models && service.llm_models.length > 0)
                        .map(service => {
                            const isCurrentService = currentTranslateService === service.id;

                            // 创建模型子菜单
                            const modelChildren = (service.llm_models || []).map(model => {
                                const isCurrentModel = isCurrentService && currentTranslateModel === model.name;
                                return {
                                    label: model.display_name || model.name,
                                    icon: `<span class="pi ${isCurrentModel ? 'pi-check-circle active-status' : 'pi-circle-off inactive-status'}"></span>`,
                                    onClick: async (context) => {
                                        try {
                                            const res = await fetch(APIService.getApiUrl('/services/current'), {
                                                method: 'POST',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({ service_type: 'translate', service_id: service.id, model_name: model.name })
                                            });
                                            if (!res.ok) throw new Error(`Server error: ${res.status}`);
                                            const modelLabel = model.display_name || model.name;
                                            UIToolkit.showStatusTip(context.buttonElement, 'success', `Switched to: ${service.name} - ${modelLabel}`);
                                            logger.log(`翻译服务切换 | 服务: ${service.name} | 模型: ${modelLabel}`);

                                            // 派发全局事件通知其他组件同步
                                            window.dispatchEvent(new CustomEvent('pa-service-changed', {
                                                detail: { service_type: 'translate', service_id: service.id, model_name: model.name }
                                            }));
                                        } catch (err) {
                                            logger.error(`切换翻译模型失败: ${err.message}`);
                                            UIToolkit.showStatusTip(context.buttonElement, 'error', `Switch failed: ${err.message}`);
                                        }
                                    }
                                };
                            });

                            return {
                                label: service.name || service.id,
                                icon: `<span class="pi ${isCurrentService ? 'pi-check-circle active-status' : 'pi-circle-off inactive-status'}"></span>`,
                                onClick: async (context) => {
                                    try {
                                        const res = await fetch(APIService.getApiUrl('/services/current'), {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ service_type: 'translate', service_id: service.id })
                                        });
                                        if (!res.ok) throw new Error(`Server error: ${res.status}`);
                                        UIToolkit.showStatusTip(context.buttonElement, 'success', `Switched to: ${service.name}`);
                                        logger.log(`翻译服务切换 | 服务: ${service.name}`);

                                        // 派发全局事件通知其他组件同步
                                        window.dispatchEvent(new CustomEvent('pa-service-changed', {
                                            detail: { service_type: 'translate', service_id: service.id }
                                        }));
                                    } catch (err) {
                                        logger.error(`切换翻译服务失败: ${err.message}`);
                                        UIToolkit.showStatusTip(context.buttonElement, 'error', `Switch failed: ${err.message}`);
                                    }
                                },
                                children: modelChildren.length > 0 ? modelChildren : undefined
                            };
                        });

                    // 将其他服务添加到serviceMenuItems
                    serviceMenuItems.push(...otherServiceMenuItems);

                    return [
                        {
                            label: "选择服务",
                            icon: '<span class="pi pi-sparkles"></span>',
                            children: serviceMenuItems
                        },
                        { type: 'separator' },
                        {
                            label: "翻译缓存",
                            icon: `<span class="pi ${useTranslateCache ? 'pi-check-circle active-status' : 'pi-circle-off inactive-status'}"></span>`,
                            onClick: (context) => {
                                const newStatus = !useTranslateCache;
                                app.ui.settings.setSettingValue("PromptAssistant.Features.UseTranslateCache", newStatus);
                                const statusText = newStatus ? '已开启' : '已关闭';
                                logger.log(`右键菜单 | 动作: 切换翻译缓存 | 状态: ${statusText}`);
                                UIToolkit.showStatusTip(context.buttonElement, 'success', `翻译缓存${statusText}`);
                            }
                        }
                    ];
                }
            },
        ];

        // 记录添加的按钮
        let historyButtons = [];
        let otherButtons = [];
        let divider = null;

        // ---Add buttons to AssistantContainer---
        for (const config of buttonConfigs) {
            if (config.type === 'divider') {
                // Check visibility for divider
                if (config.visible === false) continue;

                const divider = document.createElement('div');
                divider.className = 'prompt-assistant-divider';
                // Add divider to container
                widget.container.addButton(divider, config.id || `divider_${Date.now()}`);
                // Save reference if needed
                if (config.id) widget.buttons[config.id] = divider;
                continue;
            }

            // Check visibility
            if (config.visible === false) continue;

            // Create button using existing helper
            // Note: addButtonWithIcon returns the button element and saves it to widget.buttons
            const button = this.addButtonWithIcon(widget, config);
            if (!button) continue;

            // Set initial state
            if (config.initialState) {
                Object.entries(config.initialState).forEach(([stateType, value]) => {
                    UIToolkit.setButtonState(widget, config.id, stateType, value);
                });
            }

            // Add to container
            widget.container.addButton(button, config.id);
        }


    }

    /**
     * 添加带图标的按钮
     */
    addButtonWithIcon(widget, config) {
        if (!widget?.element || !widget?.innerContent) return null;

        const { id, title, icon, onClick, contextMenu } = config;

        // 创建按钮
        const button = document.createElement('button');
        button.className = 'prompt-assistant-button';
        button.title = title || '';
        button.dataset.id = id || `btn_${Date.now()}`;

        // 添加图标 - 使用UIToolkit的SVG图标方法
        if (icon) {
            UIToolkit.addIconToButton(button, icon, title || '');
        }

        // 添加事件
        if (typeof onClick === 'function') {
            button.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                // 如果按钮被禁用，不执行操作
                if (button.classList.contains('button-disabled')) {
                    return;
                }

                // 执行点击回调
                onClick(e, widget);
            });
        }

        // 添加右键菜单（如果有）
        if (contextMenu && typeof contextMenu === 'function') {
            this._setupButtonContextMenu(button, contextMenu, widget);
        }

        // 保存引用
        if (id) {
            widget.buttons[id] = button;
        }

        return button;
    }

    /**
     * 检测输入框是否有滚动条
     * @param {HTMLElement} inputEl - 输入框元素
     * @returns {boolean} 是否有垂直滚动条
     */
    _detectScrollbar(inputEl) {
        if (!inputEl || inputEl.tagName !== 'TEXTAREA') {
            return false;
        }

        try {
            // 检查垂直滚动条：scrollHeight > clientHeight
            const hasVerticalScrollbar = inputEl.scrollHeight > inputEl.clientHeight;
            // 日志简化：详细滚动条检测日志移至 _adjustPositionForScrollbar，并仅在状态变更时输出
            return hasVerticalScrollbar;
        } catch (error) {
            logger.error(`[滚动条检测] 检测失败 | 错误: ${error.message}`);
            return false;
        }
    }

    /**
     * 根据滚动条状态调整小助手位置
     * @param {Object} widget - 小助手实例
     * @param {HTMLElement} inputEl - 输入框元素
     * @param {Boolean} forceUpdate - 是否强制更新（用于初始化）
     */
    _adjustPositionForScrollbar(widget, inputEl, forceUpdate = false) {
        if (!widget?.element || !inputEl) return;

        const hasScrollbar = this._detectScrollbar(inputEl);
        const containerDiv = widget.element;

        // 仅在滚动条状态发生变化时更新位置（除非强制更新）
        const prevState = containerDiv.dataset.hasScrollbar === 'true';
        if (!forceUpdate && prevState === hasScrollbar) {
            return; // 状态未变，不做任何操作
        }

        // 【关键修复】在位置/布局调整前，显式移除输入框的高亮状态
        // 防止浏览器在重排（Relayout）过程中产生动画残留
        UIToolkit.removeHighlight(inputEl);

        containerDiv.dataset.hasScrollbar = String(hasScrollbar);

        // 有滚动条时向左偏移，避开滚动条
        const rightOffset = hasScrollbar ? '16px' : '4px';
        containerDiv.style.right = rightOffset;
    }

    /**
     * 设置UI位置
     * 支持 Vue node2.0 和 litegraph.js 两种渲染模式
     * @param {Function} onComplete - 定位完成回调，接收boolean参数，true表示成功，false表示失败
     */
    _setupUIPosition(widget, inputEl, containerDiv, canvasContainerRect, onComplete) {


        // 清理函数列表
        widget._eventCleanupFunctions = widget._eventCleanupFunctions || [];

        // 【关键修复】直接使用 widget.node 而不是通过 app.graph.getNodeById 查找
        // 因为进入子图后 app.graph 已经切换到子图的 graph，无法找到主画布节点
        const node = widget.node;
        if (!node) {
            logger.debug(`[定位] widget.node 不存在 | ID: ${widget.nodeId}`);
            if (onComplete) onComplete(false);
            return;
        }


        // 创建widget对象用于容器查找
        const widgetObj = {
            inputEl: inputEl,
            element: inputEl,
            name: widget.inputId,
            id: widget.inputId
        };

        // 使用 NodeMountService 进行带重试的容器查找
        // Vue mode下需要更多重试次数和更长间隔
        const isVueMode = typeof LiteGraph !== 'undefined' && LiteGraph.vueNodesMode === true;
        nodeMountService.findMountContainerWithRetry(node, widgetObj, {
            maxRetries: isVueMode ? 5 : 3,
            retryInterval: isVueMode ? 800 : 500
        }).then(containerInfo => {
            if (!containerInfo) {
                // logger.debug(`[定位] 容器查找失败 | 节点ID: ${widget.nodeId}`);
                if (onComplete) onComplete(false);
                return;
            }

            // 根据渲染模式应用不同的定位策略
            if (containerInfo.mode === RENDER_MODE.VUE_NODES) {
                this._applyVueNodesPositioning(widget, containerDiv, containerInfo);
            } else {
                this._applyLitegraphPositioning(widget, containerDiv, containerInfo);
            }

            // 保存渲染模式到widget，用于后续调整
            widget._renderMode = containerInfo.mode;

            // 触发回流确保样式生效
            void containerDiv.offsetWidth;

            // 最终成功日志保持精简
            logger.debug(`[定位] 成功 | ID: ${widget.nodeId} | 模式: ${containerInfo.mode} | 锚点: ${widget.container?.anchorPosition}`);
            if (onComplete) onComplete(true);

        }).catch(error => {
            logger.error(`[定位] 异常 | 节点ID: ${widget.nodeId} | 错误: ${error.message}`);
            if (onComplete) onComplete(false);
        });
    }

    /**
     * Vue node2.0 模式下的定位逻辑
     */
    _applyVueNodesPositioning(widget, containerDiv, containerInfo) {
        let { container, textarea, nodeContainer, isNoteNode } = containerInfo;

        // 【特殊处理】Note节点在Vue mode下可能需要二次查找textarea
        if (!textarea && isNoteNode && nodeContainer) {
            const textareas = nodeContainer.querySelectorAll('textarea');
            if (textareas.length > 0) {
                textarea = textareas[0];
                container = textarea.parentElement;
            } else {
                logger.warn(`[Vue定位] Note节点仍未找到textarea | 节点ID: ${widget.nodeId}`);
            }
        }

        // 定期更新输入框引用及事件绑定
        if (textarea && textarea !== widget.inputEl) {
            widget.inputEl = textarea;
            widget.text_element = textarea;
            if (window.PromptAssistantInputWidgetMap && window.PromptAssistantInputWidgetMap[widget.widgetKey]) {
                window.PromptAssistantInputWidgetMap[widget.widgetKey].inputEl = textarea;
            }

            if (!textarea._promptAssistantBound) {
                textarea._promptAssistantBound = true;
                widget._eventCleanupFunctions = widget._eventCleanupFunctions || [];

                widget._eventCleanupFunctions.push(EventManager.addDOMListener(textarea, 'blur', async () => {
                    HistoryCacheService.addHistory({
                        workflow_id: widget.nodeInfo?.workflow_id || '',
                        node_id: widget.nodeId,
                        input_id: widget.inputId,
                        content: textarea.value,
                        operation_type: 'input',
                        timestamp: Date.now()
                    });
                    HistoryCacheService.initUndoState(widget.nodeId, widget.inputId, textarea.value);
                    UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);
                }));

                widget._eventCleanupFunctions.push(EventManager.addDOMListener(textarea, 'input', () => {
                    UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);
                    this._adjustPositionForScrollbar(widget, textarea);
                }));

                if (window.ResizeObserver) {
                    const resizeObserver = new ResizeObserver(() => {
                        setTimeout(() => this._adjustPositionForScrollbar(widget, textarea), 10);
                    });
                    resizeObserver.observe(textarea);
                    widget._eventCleanupFunctions.push(() => resizeObserver.disconnect());
                }

                if (!widget._undoStateInitialized) {
                    HistoryCacheService.initUndoState(widget.nodeId, widget.inputId, textarea.value);
                    widget._undoStateInitialized = true;
                }
            }
            UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);
        }

        // 防重复挂载检查
        if (textarea && textarea._promptAssistantMounted && textarea._promptAssistantWidgetKey !== widget.widgetKey) {
            this._cleanupRedundantWidget(widget);
            return;
        }

        const existingAssistant = container.querySelector('.assistant-container-common');
        if (existingAssistant && !container.contains(containerDiv)) {
            this._cleanupRedundantWidget(widget);
            return;
        }

        if (textarea) {
            textarea._promptAssistantMounted = true;
            textarea._promptAssistantWidgetKey = widget.widgetKey;
        }

        containerDiv.style.position = 'absolute';
        containerDiv.style.zIndex = '10';
        if (window.getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }

        containerDiv.classList.add('vue-node-mode');
        if (!container.contains(containerDiv)) {
            container.appendChild(containerDiv);
        }

        if (textarea) {
            requestAnimationFrame(() => this._adjustPositionForScrollbar(widget, textarea, true));
            setTimeout(() => this._adjustPositionForScrollbar(widget, textarea, true), 150);
        }
    }

    /**
     * 清理冗余的 Widget 实例（当由于并发原因导致重复创建时）
     * @private
     */
    _cleanupRedundantWidget(widget) {
        if (widget.widgetKey && PromptAssistant.instances.has(widget.widgetKey)) {
            PromptAssistant.instances.delete(widget.widgetKey);
        }
        if (widget.container) {
            widget.container.destroy();
        }
    }

    /**
     * litegraph.js 模式下的定位逻辑
     * 【修复】添加后备事件绑定逻辑，与 Vue mode 保持一致
     */
    _applyLitegraphPositioning(widget, containerDiv, containerInfo) {
        const { container: domWidgetContainer, textarea } = containerInfo;

        // 【关键修复】确保 inputEl 引用正确
        if (textarea && textarea !== widget.inputEl) {
            widget.inputEl = textarea;
            widget.text_element = textarea;

            // 更新全局输入框映射
            if (window.PromptAssistantInputWidgetMap && window.PromptAssistantInputWidgetMap[widget.widgetKey]) {
                window.PromptAssistantInputWidgetMap[widget.widgetKey].inputEl = textarea;
            }

            // logger.debug(`[Litegraph定位] 更新inputEl引用 | 节点ID: ${widget.nodeId}`);
        }

        // 【关键修复】确保事件绑定（与 Vue mode 一致的后备逻辑）
        const inputEl = widget.inputEl || textarea;

        // 使用 widget 级别的 flag 判断
        const isBound = widget._inputEventsBound;

        // 精简定位开始日志
        // logger.debug(`[_setupUIPosition] 开始定位 | 节点ID: ${widget.nodeId}`);
        // logger.debug(`[Litegraph定位] 事件绑定检查 | 节点ID: ${widget.nodeId} | inputEl存在: ${!!inputEl} | isBound: ${isBound}`);

        // 如果没有绑定，则绑定事件
        if (inputEl && !isBound) {
            // 如果是遗留标记，记录日志
            if (inputEl._promptAssistantBound) {
                logger.debug(`[Litegraph定位] 检测到遗留标记，重新绑定 | 节点ID: ${widget.nodeId}`);
            }

            inputEl._promptAssistantBound = true;
            widget._inputEventsBound = true; // 设置标记
            widget._eventCleanupFunctions = widget._eventCleanupFunctions || [];
            // logger.debug(`[Litegraph定位] 开始绑定事件 | 节点ID: ${widget.nodeId}`);

            // 绑定blur事件用于历史记录
            const removeBlurListener = EventManager.addDOMListener(inputEl, 'blur', async () => {
                // logger.debug(`[Litegraph] 历史写入准备 | 原因：失焦事件触发 node_id=${widget.nodeId} input_id=${widget.inputId}`);
                HistoryCacheService.addHistory({
                    workflow_id: widget.nodeInfo?.workflow_id || '',
                    node_id: widget.nodeId,
                    input_id: widget.inputId,
                    content: inputEl.value,
                    operation_type: 'input',
                    timestamp: Date.now()
                });
                // 重置撤销状态
                HistoryCacheService.initUndoState(widget.nodeId, widget.inputId, inputEl.value);
                // 更新按钮状态
                UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);
            });
            widget._eventCleanupFunctions.push(removeBlurListener);

            // 绑定input事件用于实时更新按钮状态
            const removeInputListener = EventManager.addDOMListener(inputEl, 'input', () => {
                UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);
                this._adjustPositionForScrollbar(widget, inputEl);
            });
            widget._eventCleanupFunctions.push(removeInputListener);

            if (!widget._undoStateInitialized) {
                HistoryCacheService.initUndoState(widget.nodeId, widget.inputId, inputEl.value);
                widget._undoStateInitialized = true;
            }

            UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);
            // logger.debug(`[Litegraph定位] 事件绑定完成 | 节点ID: ${widget.nodeId}`);
        } else if (inputEl && inputEl._promptAssistantBound) {
            // 已绑定，只更新按钮状态
            UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);
        }

        // 【防重复挂载检查】检查 inputEl 是否已被小助手绑定
        if (inputEl && inputEl._promptAssistantMounted) {
            logger.debug(`[Litegraph定位] 跳过挂载 | 原因: inputEl 已被其他小助手绑定 | 节点ID: ${widget.nodeId}`);
            // 清理当前 widget 实例（因为无法正确挂载）
            if (widget.widgetKey && PromptAssistant.instances.has(widget.widgetKey)) {
                PromptAssistant.instances.delete(widget.widgetKey);
            }
            if (widget.container) {
                widget.container.destroy();
            }
            return;
        }

        // 【防重复挂载检查】检查容器内是否已存在小助手元素
        const existingAssistant = domWidgetContainer.querySelector('.assistant-container-common');
        if (existingAssistant) {
            logger.debug(`[Litegraph定位] 跳过挂载 | 原因: 容器内已存在小助手 | 节点ID: ${widget.nodeId}`);
            // 清理当前 widget 实例（因为无法正确挂载）
            if (widget.widgetKey && PromptAssistant.instances.has(widget.widgetKey)) {
                PromptAssistant.instances.delete(widget.widgetKey);
            }
            if (widget.container) {
                widget.container.destroy();
            }
            return;
        }

        // 在 inputEl 上添加挂载标记
        if (inputEl) {
            inputEl._promptAssistantMounted = true;
            inputEl._promptAssistantWidgetKey = widget.widgetKey;
        }

        // 确保 dom-widget 容器有相对定位
        const containerPosition = window.getComputedStyle(domWidgetContainer).position;
        if (containerPosition === 'static') {
            domWidgetContainer.style.position = 'relative';
        }

        // 标准模式使用绝对定位
        containerDiv.style.position = 'absolute';



        // 直接添加到dom-widget容器
        domWidgetContainer.appendChild(containerDiv);

        // 触发回流，确保样式更新
        void containerDiv.offsetWidth;

        // 挂载完成后检测并调整滚动条位置
        if (inputEl) {
            requestAnimationFrame(() => this._adjustPositionForScrollbar(widget, inputEl, true));
        }
    }

    /**
     * 清理单个实例的资源
     */
    _cleanupInstance(instance, instanceKey, skipRemove = false) {
        try {
            // 检查实例是否有效
            if (!instance) {
                logger.debug(`实例清理 | 结果:跳过 | 实例:${instanceKey || 'unknown'} | 原因:实例不存在`);
                return;
            }

            // 标记实例为已销毁
            instance.isDestroyed = true;

            // 1. 重置所有按钮状态
            if (instance.buttons) {
                Object.keys(instance.buttons).forEach(buttonId => {
                    try {
                        const button = instance.buttons[buttonId];
                        if (button) {
                            // 移除所有状态类
                            button.classList.remove('button-active', 'button-processing', 'button-disabled');
                            // 移除所有事件监听器
                            button.replaceWith(button.cloneNode(true));
                        }
                    } catch (err) {
                        logger.debug(`按钮清理 | 按钮:${buttonId} | 错误:${err.message}`);
                    }
                });
                // 清空按钮引用
                instance.buttons = {};
            }

            // 2. 清理事件监听器
            if (instance.cleanupListeners && typeof instance.cleanupListeners === 'function') {
                try {
                    instance.cleanupListeners();
                } catch (err) {
                    logger.debug(`监听器清理 | 错误:${err.message}`);
                }
            }

            // 3. 清理所有保存的事件清理函数
            if (instance._eventCleanupFunctions && Array.isArray(instance._eventCleanupFunctions)) {
                instance._eventCleanupFunctions.forEach(cleanup => {
                    if (typeof cleanup === 'function') {
                        try {
                            cleanup();
                        } catch (err) {
                            logger.debug(`事件清理 | 错误:${err.message}`);
                        }
                    }
                });
                instance._eventCleanupFunctions = [];
            }

            // 3.5【关键修复】重置 inputEl 上的事件绑定标记
            // 确保模式切换后可以重新绑定事件
            if (instance.inputEl && instance.inputEl._promptAssistantBound) {
                instance.inputEl._promptAssistantBound = false;
            }
            if (instance.text_element && instance.text_element._promptAssistantBound) {
                instance.text_element._promptAssistantBound = false;
            }

            // 3.6【防重复挂载修复】重置 textarea 上的挂载标记
            // 确保清理后可以重新挂载小助手
            if (instance.inputEl && instance.inputEl._promptAssistantMounted) {
                instance.inputEl._promptAssistantMounted = false;
                delete instance.inputEl._promptAssistantWidgetKey;
            }
            if (instance.text_element && instance.text_element._promptAssistantMounted && instance.text_element !== instance.inputEl) {
                instance.text_element._promptAssistantMounted = false;
                delete instance.text_element._promptAssistantWidgetKey;
            }

            // 同时重置 widget 级别的标记
            instance._undoStateInitialized = false;
            instance._inputEventsBound = false; // 重置输入事件绑定标记


            // 4. 从DOM中移除元素
            if (instance.element) {
                try {
                    // 确保在移除元素前清理所有子元素的事件
                    const allButtons = instance.element.querySelectorAll('button');
                    allButtons.forEach(button => {
                        button.replaceWith(button.cloneNode(true));
                    });

                    // 清理指示器元素
                    if (instance.indicator && instance.indicator.parentNode) {
                        instance.indicator.innerHTML = '';
                    }

                    if (instance.element.parentNode) {
                        instance.element.parentNode.removeChild(instance.element);
                    }
                } catch (err) {
                    logger.debug(`DOM元素清理 | 错误:${err.message}`);
                }
            }

            // 5. 清理输入框映射
            if (window.PromptAssistantInputWidgetMap && instanceKey) {
                try {
                    delete window.PromptAssistantInputWidgetMap[instanceKey];
                } catch (err) {
                    logger.debug(`输入框映射清理 | 错误:${err.message}`);
                }
            }

            // 6. 清理弹窗状态
            if (window.FEATURES && window.FEATURES.updateButtonsVisibility) {
                try {
                    window.FEATURES.updateButtonsVisibility();
                } catch (err) {
                    logger.debug(`按钮可见性更新 | 错误:${err.message}`);
                }
            }

            // 7. 从实例集合中移除（除非明确指定跳过）
            if (!skipRemove && instanceKey) {
                try {
                    PromptAssistant.instances.delete(instanceKey);
                } catch (err) {
                    logger.debug(`实例集合清理 | 错误:${err.message}`);
                }
            }

            // 8. 清理实例属性
            try {
                Object.keys(instance).forEach(key => {
                    try {
                        delete instance[key];
                    } catch (err) {
                        logger.debug(`属性清理 | 属性:${key} | 错误:${err.message}`);
                    }
                });
            } catch (err) {
                logger.debug(`属性清理 | 错误:${err.message}`);
            }

            // logger.debug(`实例清理 | 结果:成功 | 实例:${instanceKey || 'unknown'}`);
        } catch (error) {
            logger.error(`实例清理失败 | 实例:${instanceKey || 'unknown'} | 错误:${error.message}`);
        }
    }

    /**
     * 设置按钮右键菜单
     * @param {HTMLElement} button 按钮元素
     * @param {Function} getMenuItems 获取菜单项的函数
     * @param {Object} widget 小助手实例
     */
    _setupButtonContextMenu(button, getMenuItems, widget) {
        if (!button || typeof getMenuItems !== 'function') return;

        // 设置右键菜单
        const cleanup = buttonMenu.setupButtonMenu(button, () => {
            // 调用getMenuItems函数获取菜单项，传入widget作为上下文
            return getMenuItems(widget);
        }, { widget, buttonElement: button });

        // 保存清理函数到widget的事件清理函数列表中
        if (cleanup) {
            widget._eventCleanupFunctions = widget._eventCleanupFunctions || [];
            widget._eventCleanupFunctions.push(cleanup);
        }
    }
}

// 创建单例实例
const promptAssistant = new PromptAssistant();

// 导出
export { promptAssistant, PromptAssistant };
