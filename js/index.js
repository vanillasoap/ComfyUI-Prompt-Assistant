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

                    // 重置初始化标记，允许重新创建
                    node._promptAssistantInitialized = false;
                    node._imageCaptionInitialized = false;

                    // 注入钩子
                    this._injectUniversalHooks(node);

                    // 触发自动创建
                    this._handleNodeActive(node, { delay: false });
                });

                if (nodes.length > 0) {
                    logger.debug(`[graphSwitch] 自动扫描完成 | 节点数: ${nodes.length}`);
                }
            }, delay);
        }
    },

    /**
     * 为所有节点注入通用的交互钩子 (onSelected, onRemoved)
     * 特别是针对动态创建的子图节点，确确保能够响应点击和资源清理
     * @param {object} node - LiteGraph 节点实例
     */
    _injectUniversalHooks(node) {
        if (!node || node._promptAssistantHooksInjected) return;

        const self = this;
        const origOnSelected = node.onSelected;
        const origOnRemoved = node.onRemoved;

        // 实例级覆盖 (针对动态创建或特殊节点)
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
     * @deprecated 已由 _injectUniversalHooks 替代，保留用于注册时的遗留支持
     */
    _hookNoteNodeType(NodeType, typeName) {
        if (!NodeType || !NodeType.prototype) return;

        // 我们不再重写原型方法，而是通过 onNodeAdded 动态注入实例方法
        // 这在 Node 2.0 动态创建时更可靠
        // logger.debug(`[_hookNoteNodeType] 类型已注册: ${typeName}`);
    },

    // ---其他方法保持不变---
    async _setupOtherMethods() {

        // 仅保留工作流ID识别功能，不处理工作流切换事件
        try {
            const LGraph = app.graph.constructor;
            const origConfigure = LGraph.prototype.configure;
            LGraph.prototype.configure = function (data) {
                // 在图表对象上存储工作流ID
                this._workflow_id = data.id || LiteGraph.uuidv4();

                // 执行原始方法
                return origConfigure.apply(this, arguments);
            };

            // 添加工作流加载监听，只标记切换状态，不做特殊处理
            const origLoadGraphData = app.loadGraphData;
            app.loadGraphData = async function (data) {
                // 设置工作流切换标记，避免删除缓存
                window.PROMPT_ASSISTANT_WORKFLOW_SWITCHING = true;

                // 简化日志：仅在工作流ID变化时打印一次
                const workflowId = data?.id || (data?.extra?.workflow_id) || "未知工作流";
                if (app.graph?._workflow_id !== workflowId) {
                    logger.log(`[工作流] 切换: ${workflowId}`);
                }

                try {
                    // 调用原始加载方法
                    const result = await origLoadGraphData.apply(this, arguments);

                    // 工作流加载完成后，统一处理现有节点的激活（包括自动创建判定）
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
                    // 延迟重置工作流切换标记
                    setTimeout(() => {
                        window.PROMPT_ASSISTANT_WORKFLOW_SWITCHING = false;
                    }, 500);
                }
            };
        } catch (e) {
            logger.error("[PromptAssistant] 注入 LGraph 设置工作流ID失败", e);
        }
    },

    // ---节点生命周期钩子---
    /**
     * 节点创建钩子
     * 在节点创建时初始化特定类型节点的小助手
     */
    async nodeCreated(node) {
        // nodeCreated 钩子现在主要用于补齐子图节点的特殊交互，大部分逻辑已通过 onNodeCreated 注入
        if (!node || node.id === -1) return;
        this._injectUniversalHooks(node);
    },

    async nodeRemoved(node) {
        if (window.PROMPT_ASSISTANT_WORKFLOW_SWITCHING) return;
        this._handleNodeCleanup(node);
    },

    /**
     * 节点定义注册前钩子
     * 向所有节点类型注入小助手相关功能
     */


    // --- 统一生命周期管理逻辑 (重构点) ---

    /**
     * 统一处理节点的“进入/激活”逻辑
     * 涵盖：新节点创建(onNodeCreated), 全局节点添加(onNodeAdded), 节点选中(onSelected)
     * @param {object} node - 节点实例
     * @param {object} options - 配置参数 { reset: 是否强制重置标记, delay: 是否使用 raf 延迟 }
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

            // 1. 提示词小助手核心入口
            if (PromptAssistant.isValidNode(node)) {
                const creationMode = app.ui.settings.getSettingValue("PromptAssistant.Settings.CreationMode") || "auto";
                if ((creationMode === "auto" || reset) && !node._promptAssistantInitialized) {
                    node._promptAssistantInitialized = true;
                    promptAssistant.checkAndSetupNode(node);
                }
            }

            // 2. 图像反推小助手入口
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
     * 统一处理节点的“销毁/清理”逻辑
     * @param {object} node - 节点实例
     */
    _handleNodeCleanup(node) {
        if (!node || node.id === undefined || node.id === -1) return;
        const nodeId = node.id;

        // 执行清理并标记状态
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
     * 注册前的批量原型注入
     */
    async beforeRegisterNodeDef(nodeType, nodeData) {
        const self = this;
        const proto = nodeType.prototype;

        const origOnCreated = proto.onNodeCreated;
        const origOnSelected = proto.onSelected;
        const origOnRemoved = proto.onRemoved;

        // 注入创建钩子 (原型级补救)
        proto.onNodeCreated = function () {
            if (origOnCreated) origOnCreated.apply(this, arguments);
            self._handleNodeActive(this, { delay: true });
        };

        // 注入选中钩子 (原型级补救)
        proto.onSelected = function () {
            if (origOnSelected) origOnSelected.apply(this, arguments);
            self._handleNodeActive(this, { reset: true, delay: true });
        };

        // 注入移除钩子 (原型级补救)
        proto.onRemoved = function () {
            self._handleNodeCleanup(this);
            if (origOnRemoved) origOnRemoved.apply(this, arguments);
        };
    },

    /**
     * 扩展卸载钩子
     * 在扩展被卸载时清理所有资源
     */
    async beforeExtensionUnload() {
        promptAssistant.cleanup();
        imageCaption.cleanup();
    }
});

export { EventManager, UIToolkit };