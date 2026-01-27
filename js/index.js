/**
 * PromptAssistant Main Entry File
 * Responsible for extension initialization, node detection, and feature injection
 */

import { app } from "../../../scripts/app.js";
import { promptAssistant, PromptAssistant } from './modules/PromptAssistant.js';
import { registerSettings } from './modules/settings.js';
import { FEATURES as ASSISTANT_FEATURES, handleFeatureChange, setFeatureModuleDeps } from './services/features.js';
import { EventManager } from './utils/eventManager.js';
import { ResourceManager } from './utils/resourceManager.js';
import { UIToolkit } from "./utils/UIToolkit.js";
import { logger } from './utils/logger.js';
import { HistoryCacheService, TagCacheService } from './services/cache.js';
import { imageCaption, ImageCaption } from './modules/imageCaption.js';
import { nodeHelpTranslator } from './modules/nodeHelpTranslator.js';
import { nodeMountService, RENDER_MODE } from './services/NodeMountService.js';
import './node/captionFrame.js'; // Import video manual frame extraction feature



// ====================== Global Configuration & State ======================

// Set global objects for access by other modules
window.FEATURES = ASSISTANT_FEATURES;

// Add instances to global object
window.promptAssistant = promptAssistant;
window.imageCaption = imageCaption;

// Add instances to global app object
app.promptAssistant = promptAssistant;
app.imageCaption = imageCaption;

// ====================== Extension Registration ======================

/**
 * Register ComfyUI extension
 */
app.registerExtension({
    name: "Comfy.PromptAssistant",

    // ---Extension Lifecycle Hooks---
    /**
     * Initialize extension
     */
    async setup() {
        try {
            // Initialize node mount service (must be done before other initialization)
            nodeMountService.initialize();

            // Register render mode switch handling
            nodeMountService.onModeChange(async (newMode, oldMode) => {
                logger.log(`[index] Render mode switch detected | ${oldMode} -> ${newMode}`);
                // Re-initialize all assistants
                if (window.FEATURES.enabled) {
                    // Clean up all existing instances first
                    promptAssistant.cleanup(null, true);
                    imageCaption.cleanup(null, true);

                    // Wait one frame to ensure DOM update
                    await new Promise(resolve => requestAnimationFrame(resolve));

                    await promptAssistant.toggleGlobalFeature(true, true);
                    if (window.FEATURES.imageCaption) {
                        await imageCaption.toggleGlobalFeature(true, true);
                    }
                    logger.log(`[index] Re-initialization complete after render mode switch`);
                }
            });

            // Register settings options
            registerSettings();

            // Initialize auto-translation interceptor (independent of Prompt Assistant)


            // Initialize Prompt Assistant (internally handles version check and master switch state)
            await promptAssistant.initialize();

            // Initialize Image Assistant (only initialize once)
            if (!imageCaption.initialized) {
                await imageCaption.initialize();
            }

            // Clean up old references
            if (app.canvas) {
                app.canvas.updateNodeAssistantsVisibility = null;
                app.canvas._onNodeSelectionChange = null;
            }

            // Add managers to app object so they can be accessed via window.app
            app.EventManager = EventManager;
            app.ResourceManager = ResourceManager;
            app.UIToolkit = UIToolkit;

            // Initialize features.js dependencies first
            setFeatureModuleDeps({
                promptAssistant,
                PromptAssistant,
                UIToolkit,
                HistoryCacheService,
                TagCacheService,
                imageCaption,
                ImageCaption,
                nodeHelpTranslator
            });

            // Then auto-register service features
            if (window.FEATURES.enabled) {
                await promptAssistant.toggleGlobalFeature(true, true);
                // Avoid duplicate initialization, only enable image assistant when necessary
                if (window.FEATURES.imageCaption) {
                    await imageCaption.toggleGlobalFeature(true, false);
                }
                // Initialize node help translation module (based on feature toggle)
                if (window.FEATURES.nodeHelpTranslator) {
                    nodeHelpTranslator.initialize();
                }
            }

            logger.debug("Extension initialization complete");
        } catch (error) {
            logger.error(`Extension initialization failed: ${error.message}`);
        }

        // Delayed hook for Note/MarkdownNote/PreviewAny node types
        setTimeout(() => {
            try {
                const NoteNodeType = LiteGraph.registered_node_types['Note'];
                const MarkdownNoteNodeType = LiteGraph.registered_node_types['MarkdownNote'];
                const PreviewAnyNodeType = LiteGraph.registered_node_types['PreviewAny'];
                const PreviewTextNodeType = LiteGraph.registered_node_types['PreviewTextNode'];

                if (NoteNodeType) this._hookNoteNodeType(NoteNodeType, 'Note');
                if (MarkdownNoteNodeType) this._hookNoteNodeType(MarkdownNoteNodeType, 'MarkdownNote');
                if (PreviewAnyNodeType) this._hookNoteNodeType(PreviewAnyNodeType, 'PreviewAny');
                if (PreviewTextNodeType) this._hookNoteNodeType(PreviewTextNodeType, 'PreviewTextNode');

                // Possible alternative name variants
                const altNames = ['PreviewText', 'Preview as Text', 'Markdown Preview'];
                altNames.forEach(name => {
                    const nodeType = LiteGraph.registered_node_types[name];
                    if (nodeType) {
                        this._hookNoteNodeType(nodeType, name);
                        logger.debug(`[setup] Preview node injection successful | Type: ${name}`);
                    }
                });
            } catch (error) {
                logger.error(`[setup] Hook Note node failed: ${error.message}`);
            }
        }, 50);

        // ---Global node listeners---
        this._bindGraphHooks(app.graph);

        // ---Subgraph enter/exit listeners (Vue Node 2.0 auto-creation support)---
        this._setupGraphSwitchListener();

        // Expose _injectUniversalHooks for external use
        app.registerExtension._injectUniversalHooks = this._injectUniversalHooks.bind(this);
    },

    /**
     * Set up canvas graph switch listener
     * Detects enter/exit subgraph events, rescans nodes in auto-creation mode
     */
    _setupGraphSwitchListener() {
        if (!app.canvas) return;

        // Record previous graph reference
        let lastGraph = app.canvas.graph;
        const self = this;

        // Hook app.canvas.graph setter via Object.defineProperty
        // Triggers scanning when graph switches (entering/exiting subgraph)
        const originalDescriptor = Object.getOwnPropertyDescriptor(app.canvas, 'graph') || {
            value: app.canvas.graph,
            writable: true,
            configurable: true
        };

        // Save original value
        let _graphValue = app.canvas.graph;

        Object.defineProperty(app.canvas, 'graph', {
            get() {
                return _graphValue;
            },
            set(newGraph) {
                const oldGraph = _graphValue;
                _graphValue = newGraph;

                // If original setter exists, call it
                if (originalDescriptor.set) {
                    originalDescriptor.set.call(this, newGraph);
                }

                // Detect graph switch
                if (newGraph && newGraph !== oldGraph) {
                    logger.debug(`[graphSwitch] Canvas switch detected | Old Graph: ${oldGraph?._workflow_id || 'unknown'} -> New Graph: ${newGraph?._workflow_id || 'unknown'}`);

                    // Delay execution to ensure canvas switch completes
                    const isVueMode = typeof LiteGraph !== 'undefined' && LiteGraph.vueNodesMode === true;
                    const delay = isVueMode ? 300 : 100;

                    setTimeout(() => {
                        self._onGraphSwitch(newGraph);
                    }, delay);
                }
            },
            configurable: true,
            enumerable: true
        });

        logger.debug('[graphSwitch] Canvas switch listener set up');
    },

    /**
     * Processing logic after canvas switch
     * Reuses _bindGraphHooks scanning logic to avoid code duplication
     * @param {object} graph - New graph object
     */
    _onGraphSwitch(graph) {
        if (!graph || !window.FEATURES.enabled) return;

        // Call existing bind hooks method with resetFlags option to reset node initialization flags
        this._bindGraphHooks(graph, { resetFlags: true });
    },

    /**
     * Bind node mount hooks for specified graph
     * Supports main canvas and subgraph internals
     * @param {object} graph - Graph object
     * @param {object} options - Options { resetFlags: whether to reset node initialization flags }
     */
    _bindGraphHooks(graph, options = {}) {
        if (!graph) return;
        const { resetFlags = false } = options;

        // Bind hooks (execute only once)
        if (!graph._promptAssistantHooksInjected) {
            graph._promptAssistantHooksInjected = true;

            const origOnNodeAdded = graph.onNodeAdded;
            graph.onNodeAdded = (node) => {
                if (origOnNodeAdded) origOnNodeAdded.apply(graph, [node]);

                if (!window.FEATURES.enabled || !node) return;

                // 1. Dynamically inject Hooks (onSelected, onRemoved)
                this._injectUniversalHooks(node);

                // 2. Auto mount attempt
                this._handleNodeActive(node, { delay: true });
            };

            // logger.log(`[graphHooks] Graph hooks bound | ID: ${graph._workflow_id || graph.constructor?.name || 'unknown'}`);

            // [KEY] Handle existing nodes when entering subgraph
            // Vue mode requires longer delay to ensure DOM rendering completes
            const isVueMode = typeof LiteGraph !== 'undefined' && LiteGraph.vueNodesMode === true;
            const scanDelay = isVueMode ? 500 : 100;

            const scanExistingNodes = () => {
                if (!window.FEATURES.enabled) return;

                const creationMode = app.ui.settings.getSettingValue("PromptAssistant.Settings.CreationMode") || "auto";
                const icCreationMode = app.ui.settings.getSettingValue("PromptAssistant.Settings.ImageCaptionCreationMode") || "auto";

                // As long as any module has auto-creation enabled, scan existing nodes
                if (creationMode !== "auto" && icCreationMode !== "auto") {
                    // logger.debugSample(() => `[graphHooks] Skipping initial scan | PA mode: ${creationMode} | IC mode: ${icCreationMode}`);
                    return;
                }

                const nodes = graph._nodes || [];
                if (nodes.length === 0) return;

                nodes.forEach(node => {
                    if (!node || node.id === -1) return;

                    // 1. Inject hooks (ensure onSelected/onRemoved etc. work properly)
                    this._injectUniversalHooks(node);

                    // 2. Dispatch to unified activation handler, which internally judges based on each module's auto-creation settings
                    this._handleNodeActive(node, { delay: false });
                });
            };

            setTimeout(scanExistingNodes, scanDelay);
        }

        // [NEW] If flags need resetting (subgraph switch scenario), immediately scan existing nodes
        if (resetFlags) {
            const isVueMode = typeof LiteGraph !== 'undefined' && LiteGraph.vueNodesMode === true;
            const delay = isVueMode ? 300 : 100;

            setTimeout(() => {
                const nodes = graph._nodes || [];
                nodes.forEach(node => {
                    if (!node || node.id === -1) return;

                    // Reset initialization flags, allow re-creation
                    node._promptAssistantInitialized = false;
                    node._imageCaptionInitialized = false;

                    // Inject hooks
                    this._injectUniversalHooks(node);

                    // Trigger auto-creation
                    this._handleNodeActive(node, { delay: false });
                });

                if (nodes.length > 0) {
                    logger.debug(`[graphSwitch] Auto scan complete | Node count: ${nodes.length}`);
                }
            }, delay);
        }
    },

    /**
     * Inject universal interaction hooks for all nodes (onSelected, onRemoved)
     * Especially for dynamically created subgraph nodes, ensuring click response and resource cleanup
     * @param {object} node - LiteGraph node instance
     */
    _injectUniversalHooks(node) {
        if (!node || node._promptAssistantHooksInjected) return;

        const self = this;
        const origOnSelected = node.onSelected;
        const origOnRemoved = node.onRemoved;

        // Instance-level override (for dynamically created or special nodes)
        node.onSelected = function () {
            if (origOnSelected) origOnSelected.apply(this, arguments);
            self._handleNodeActive(this, { reset: true, delay: true });
        };

        node.onRemoved = function () {
            self._handleNodeCleanup(this);
            if (origOnRemoved) origOnRemoved.apply(this, arguments);
        };

        node._promptAssistantHooksInjected = true;
    },

    /**
     * @deprecated Replaced by _injectUniversalHooks, kept for legacy support during registration
     */
    _hookNoteNodeType(NodeType, typeName) {
        if (!NodeType || !NodeType.prototype) return;

        // We no longer override prototype methods, instead dynamically inject instance methods via onNodeAdded
        // This is more reliable for Node 2.0 dynamic creation
        // logger.debug(`[_hookNoteNodeType] Type registered: ${typeName}`);
    },

    // ---Other methods remain unchanged---
    async _setupOtherMethods() {

        // Only keep workflow ID identification functionality, do not handle workflow switch events
        try {
            const LGraph = app.graph.constructor;
            const origConfigure = LGraph.prototype.configure;
            LGraph.prototype.configure = function (data) {
                // Store workflow ID on graph object
                this._workflow_id = data.id || LiteGraph.uuidv4();

                // Execute original method
                return origConfigure.apply(this, arguments);
            };

            // Add workflow load listener, only mark switch state, no special handling
            const origLoadGraphData = app.loadGraphData;
            app.loadGraphData = async function (data) {
                // Set workflow switch flag, avoid cache deletion
                window.PROMPT_ASSISTANT_WORKFLOW_SWITCHING = true;

                // Simplified log: only print once when workflow ID changes
                const workflowId = data?.id || (data?.extra?.workflow_id) || "Unknown workflow";
                if (app.graph?._workflow_id !== workflowId) {
                    logger.log(`[Workflow] Switch: ${workflowId}`);
                }

                try {
                    // Call original load method
                    const result = await origLoadGraphData.apply(this, arguments);

                    // After workflow load completes, uniformly handle existing node activation (including auto-creation determination)
                    requestAnimationFrame(() => {
                        if (app.graph && app.graph._nodes) {
                            app.graph._nodes.forEach(node => {
                                if (node && node.id !== -1) {
                                    this._handleNodeActive(node, { delay: false });
                                }
                            });
                        }
                    });

                    return result;
                } finally {
                    // Delay resetting workflow switch flag
                    setTimeout(() => {
                        window.PROMPT_ASSISTANT_WORKFLOW_SWITCHING = false;
                    }, 500);
                }
            };
        } catch (e) {
            logger.error("[PromptAssistant] Failed to inject LGraph workflow ID setup", e);
        }
    },

    // ---Node lifecycle hooks---
    /**
     * Node creation hook
     * Initializes assistants for specific node types when nodes are created
     */
    async nodeCreated(node) {
        // nodeCreated hook is now mainly for supplementing subgraph node interactions, most logic is already injected via onNodeCreated
        if (!node || node.id === -1) return;
        this._injectUniversalHooks(node);
    },

    async nodeRemoved(node) {
        if (window.PROMPT_ASSISTANT_WORKFLOW_SWITCHING) return;
        this._handleNodeCleanup(node);
    },

    /**
     * Pre-registration hook for node definitions
     * Injects assistant-related functionality into all node types
     */


    // --- Unified lifecycle management logic (refactoring point) ---

    /**
     * Unified handler for node "enter/activate" logic
     * Covers: new node creation (onNodeCreated), global node addition (onNodeAdded), node selection (onSelected)
     * @param {object} node - Node instance
     * @param {object} options - Configuration { reset: force reset flags, delay: use raf delay }
     */
    _handleNodeActive(node, options = {}) {
        if (!node || !window.FEATURES.enabled) return;
        if (node.id === -1) return;

        const { reset = false, delay = true } = options;
        if (reset) {
            node._promptAssistantInitialized = false;
            node._imageCaptionInitialized = false;
        }

        const run = () => {
            if (!node || !node.id || node.id === -1) return;

            // 1. Prompt assistant core entry
            if (PromptAssistant.isValidNode(node)) {
                const creationMode = app.ui.settings.getSettingValue("PromptAssistant.Settings.CreationMode") || "auto";
                if ((creationMode === "auto" || reset) && !node._promptAssistantInitialized) {
                    node._promptAssistantInitialized = true;
                    promptAssistant.checkAndSetupNode(node);
                }
            }

            // 2. Image caption assistant entry
            const isSupportedICNode = imageCaption.isSupportedNode && imageCaption.isSupportedNode(node);
            if (window.FEATURES.imageCaption && isSupportedICNode) {
                const icCreationMode = app.ui.settings.getSettingValue("PromptAssistant.Settings.ImageCaptionCreationMode") || "auto";
                if (reset && app.canvas?._imageCaptionSelectionHandler) {
                    node._imageCaptionInitialized = false;
                    app.canvas._imageCaptionSelectionHandler({ [node.id]: node });
                } else if (icCreationMode === "auto" && !node._imageCaptionInitialized) {
                    node._imageCaptionInitialized = true;
                    imageCaption.checkAndSetupNode(node);
                }
            }
        };

        if (delay) {
            requestAnimationFrame(() => requestAnimationFrame(run));
        } else {
            run();
        }
    },

    /**
     * Unified handler for node "destroy/cleanup" logic
     * @param {object} node - Node instance
     */
    _handleNodeCleanup(node) {
        if (!node || node.id === undefined || node.id === -1) return;
        const nodeId = node.id;

        // Execute cleanup and mark state
        if (node._promptAssistantInitialized || !node._promptAssistantCleaned) {
            promptAssistant.cleanup(nodeId, false);
            node._promptAssistantCleaned = true;
        }
        if (node._imageCaptionInitialized || !node._imageCaptionCleaned) {
            imageCaption.cleanup(nodeId, false);
            node._imageCaptionCleaned = true;
        }
    },

    /**
     * Batch prototype injection before registration
     */
    async beforeRegisterNodeDef(nodeType, nodeData) {
        const self = this;
        const proto = nodeType.prototype;

        const origOnCreated = proto.onNodeCreated;
        const origOnSelected = proto.onSelected;
        const origOnRemoved = proto.onRemoved;

        // Inject creation hook (prototype-level fallback)
        proto.onNodeCreated = function () {
            if (origOnCreated) origOnCreated.apply(this, arguments);
            self._handleNodeActive(this, { delay: true });
        };

        // Inject selection hook (prototype-level fallback)
        proto.onSelected = function () {
            if (origOnSelected) origOnSelected.apply(this, arguments);
            self._handleNodeActive(this, { reset: true, delay: true });
        };

        // Inject removal hook (prototype-level fallback)
        proto.onRemoved = function () {
            self._handleNodeCleanup(this);
            if (origOnRemoved) origOnRemoved.apply(this, arguments);
        };
    },

    /**
     * Extension unload hook
     * Cleans up all resources when the extension is unloaded
     */
    async beforeExtensionUnload() {
        promptAssistant.cleanup();
        imageCaption.cleanup();
    }
});

export { EventManager, UIToolkit };