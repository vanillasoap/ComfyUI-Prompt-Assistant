/**
 * Image node assistant class
 * Detects and processes image nodes, provides image caption functionality
 */

import { app } from "../../../../scripts/app.js";
import { logger } from '../utils/logger.js';
import { ResourceManager } from "../utils/resourceManager.js";
import { UIToolkit } from "../utils/UIToolkit.js";
import { EventManager } from "../utils/eventManager.js";
import { APIService } from '../services/api.js';
import { HistoryCacheService } from '../services/cache.js';
import { buttonMenu } from "../services/btnMenu.js";
import { rulesConfigManager } from "./rulesConfigManager.js";
import { nodeMountService, RENDER_MODE } from "../services/NodeMountService.js";
import { AssistantContainer, ANCHOR_POSITION } from "./AssistantContainer.js";
import { PopupManager } from "../utils/popupManager.js";



class ImageCaption {
    /** Map collection storing all assistant instances */
    static instances = new Map();

    constructor() {
        this.initialized = false;
    }

    /**
     * Get low quality rendering threshold
     * Extracted as a class method to ensure consistent threshold calculation logic everywhere
     */
    _getQualityThreshold() {
        // Prefer getting from system settings
        if (app.ui?.settings) {
            try {
                // Fix: don't use deprecated defaultValue parameter
                const settingValue = app.ui.settings.getSettingValue('Comfy.Graph.CanvasInfo');
                if (typeof settingValue === 'number') {
                    return settingValue;
                }
            } catch (e) {
                // Ignore error, use default value
            }
        }
        // Get from canvas object
        return app.canvas?.low_quality_zoom_threshold || 0.6;
    }

    /**
     * Check if node type is an allowed image node type (public method)
     */
    isSupportedNode(node) {
        return this._isAllowedNodeType(node);
    }

    /**
     * Check if node type is an allowed image node type
     * @param {object} node - LiteGraph node object
     * @param {boolean} debug - Whether to print debug logs
     * @returns {boolean} Whether the node type is allowed
     */
    _isAllowedNodeType(node, debug = false) {
        if (!node || !node.type) return false;

        // Allowed node type list (can be adjusted as needed)
        const allowedTypes = [
            // Load image nodes
            'LoadImage',
            'LoadImageFromUrl',

            // Preview image nodes
            'PreviewImage',
            'ImagePreview',

            // Save image nodes
            'SaveImage',
            'SaveImages'
        ];

        // Check if node type is in the allowed list
        // Uses partial matching to support similar nodes from different plugins
        const isAllowed = allowedTypes.some(type =>
            node.type.includes(type) ||
            (node.title && node.title.includes(type))
        );

        // Enable debug logs during development
        if (debug && !isAllowed) {
            logger.debug(`[Image Assistant] Node type not allowed: ${node.type || 'unknown'} | Title: ${node.title || 'unknown'}`);
        }

        return isAllowed;
    }

    /**
     * Check if node and canvas state are suitable for displaying the assistant
     * @param {object} node - LiteGraph node object
     * @returns {object} Returns detection result object
     */
    _checkNodeAndCanvasState(node) {
        const result = {
            isValid: false,
            isCollapsed: false,
            isLowQuality: false,
            hasValidImage: false
        };

        if (!node) {
            return result;
        }

        // Check if node is an allowed image node type
        if (!this._isAllowedNodeType(node)) {
            return result;
        }

        // Check if node is collapsed
        if (node.flags && node.flags.collapsed) {
            result.isCollapsed = true;
            return result;
        }

        // Check if in low quality rendering state
        if (app.canvas) {
            // Get low quality rendering threshold
            const threshold = this._getQualityThreshold();
            const scale = app.canvas.ds.scale;

            // Add a larger tolerance value to handle floating point comparison and threshold application delay
            const epsilon = 0.001;
            if (scale <= threshold + epsilon) {
                result.isLowQuality = true;
                return result;
            }
        }

        // Check if node has a valid image
        if (node.imgs && Array.isArray(node.imgs) && node.imgs.length > 0) {
            const imageIndex = node.imageIndex || 0;
            if (imageIndex >= 0 && imageIndex < node.imgs.length && node.imgs[imageIndex]) {
                result.hasValidImage = true;
                result.isValid = true;
            }
        }

        return result;
    }

    /**
     * Check if node has a valid image
     * @param {object} node - LiteGraph node object
     * @returns {boolean} Whether the node has a valid image
     */
    hasValidImage(node) {
        if (!node) return false;

        // Check if node type is allowed
        if (!this._isAllowedNodeType(node)) {
            return false;
        }

        // Check if node has imgs property
        if (!node.imgs || !Array.isArray(node.imgs) || node.imgs.length === 0) {
            return false;
        }

        // Get currently displayed image
        const imageIndex = node.imageIndex || 0;
        return imageIndex >= 0 && imageIndex < node.imgs.length && node.imgs[imageIndex] != null;
    }

    /**
     * Get the currently displayed image object of the node
     * @param {object} node - LiteGraph node object
     * @returns {object|null} Returns image object or null
     */
    getNodeImage(node) {
        // Check if node type is allowed
        if (!this._isAllowedNodeType(node)) {
            return null;
        }

        const state = this._checkNodeAndCanvasState(node);

        if (!state.isValid) {
            return null;
        }

        // Return the currently displayed image
        const imageIndex = node.imageIndex || 0;
        return node.imgs[imageIndex];
    }

    /**
     * Initialize the image assistant
     */
    async initialize() {
        if (this.initialized) return true;

        try {
            // Check the initial state of the master switch
            const initialEnabled = app.ui.settings.getSettingValue("PromptAssistant.Features.ImageCaption");
            window.FEATURES.imageCaption = initialEnabled !== undefined ? initialEnabled : true;

            // Only log initialization state in debug mode
            logger.debug(`Image caption feature initialized | Status: ${window.FEATURES.imageCaption ? "enabled" : "disabled"}`);

            // Register node selection listener
            this.registerNodeSelectionListener();

            // Mark as initialized
            this.initialized = true;
            logger.log("Image assistant initialization complete");
            return true;
        } catch (error) {
            logger.error(() => `Image assistant initialization failed | Error: ${error.message}`);
            this.initialized = false;
            return false;
        }
    }

    /**
     * Register node selection event listener
     */
    registerNodeSelectionListener() {
        if (!app.canvas) {
            logger.error("Canvas not initialized, cannot register node selection event listener");
            return;
        }

        // If selection event handler is already registered, skip re-registration
        if (app.canvas._imageCaptionSelectionHandler) {
            logger.debug("Image assistant node selection listener already exists, skipping registration");
            return;
        }

        // Create selection event handler
        const selectionHandler = (selected_nodes) => {
            // When the master switch or image caption feature is disabled, skip all node processing
            if (!window.FEATURES || !window.FEATURES.enabled || !window.FEATURES.imageCaption) {
                return;
            }

            // Handle empty selection
            if (!selected_nodes || Object.keys(selected_nodes).length === 0) {
                return;
            }

            // Process selected nodes
            for (const nodeId in selected_nodes) {
                const node = app.canvas.graph._nodes_by_id[nodeId];
                if (!node || node.id === -1) continue;

                // Remove initialization flag check, re-detect node state on every selection
                this.checkAndSetupNode(node);
            }
        };

        // Save the original selection event handler
        if (app.canvas.onSelectionChange && app.canvas.onSelectionChange !== selectionHandler) {
            app.canvas._originalImageCaptionSelectionChange = app.canvas.onSelectionChange;
        }

        // Set the new selection event handler
        app.canvas._imageCaptionSelectionHandler = selectionHandler;

        // Add to LiteGraph's event system
        if (app.canvas.graph) {
            app.canvas.graph._imageCaptionNodeSelectionChange = selectionHandler;
        }

        logger.debug("Image assistant node selection listener registered successfully");

        // Initial check of currently selected nodes
        if (app.canvas.selected_nodes && Object.keys(app.canvas.selected_nodes).length > 0) {
            selectionHandler(app.canvas.selected_nodes);
        }
    }

    /**
     * Check node and setup assistant
     */
    checkAndSetupNode(node) {
        // Check master switch and image caption feature switch state
        if (!window.FEATURES || !window.FEATURES.enabled || !window.FEATURES.imageCaption) {
            return;
        }

        // Check if node is valid
        if (!node) return;

        // Check if node type is allowed
        if (!this._isAllowedNodeType(node)) {
            return;
        }

        // Check if node has been deleted (only clean up instance on deletion)
        if (!app.canvas || !app.canvas.graph || !app.canvas.graph._nodes_by_id[node.id]) {
            // Node has been deleted, clean up instance
            if (ImageCaption.hasInstance(node.id)) {
                this.cleanup(node.id);
            }
            return;
        }

        // Check node and canvas state
        const nodeState = this._checkNodeAndCanvasState(node);

        // If node is collapsed or canvas zoom is too small, hide existing instance but don't create new one
        if (nodeState.isCollapsed || nodeState.isLowQuality) {
            if (ImageCaption.hasInstance(node.id)) {
                const instance = ImageCaption.getInstance(node.id);
                if (instance) {
                    this.updateAssistantVisibility(instance);
                }
            }
            return;
        }

        // Validate existing instance
        const existingInstance = ImageCaption.getInstance(node.id);
        if (existingInstance && existingInstance.element && document.body.contains(existingInstance.element)) {
            // Instance is valid, update its display state (image detection handled internally)
            this.updateAssistantVisibility(existingInstance);
        } else {
            // Instance is invalid or doesn't exist, clean up and force create (whitelist mechanism)
            if (existingInstance) {
                this.cleanup(node.id);
            }

            // Create new assistant instance
            const assistant = this.setupNodeAssistant(node);
            if (assistant) {
                logger.debug(() => `[Image Assistant] Pre-mount successful | ID: ${node.id} | Waiting for image to load...`);
            }
        }
    }

    /**
     * Setup assistant for node
     */
    setupNodeAssistant(node) {
        if (!node) return null;

        // Create assistant instance
        const assistant = this.createAssistant(node);
        if (assistant) {
            // Initialize display state
            this.showAssistantUI(assistant);
            return assistant;
        }
        return null;
    }

    /**
     * Create assistant instance
     */
    createAssistant(node) {
        // Check if node is valid
        if (!node || !node.id || node.id === -1) {
            return null;
        }

        // Check if instance already exists
        if (ImageCaption.hasInstance(node.id)) {
            return ImageCaption.getInstance(node.id);
        }

        // Save nodeId for dynamic node retrieval
        const nodeId = node.id;

        // Create assistant object
        const assistant = {
            nodeId: nodeId,
            buttons: {},
            isActive: false,
            isTransitioning: false,
            isDestroyed: false,
            _eventCleanupFunctions: [],
            _timers: {},
            // Save initial node reference as fallback (Vue Node 2.0 subgraph switching scenario)
            _initialNode: node
        };

        // Dynamic node getter to avoid holding references to deleted nodes
        // [Fix] Prefer getting from graph, fall back to initial reference (fixes canvas not synced during subgraph switching)
        Object.defineProperty(assistant, 'node', {
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

        // Create UI
        this.createAssistantUI(assistant);

        // Add to instance collection
        ImageCaption.addInstance(nodeId, assistant);

        // Setup node collapse state listener
        this._setupNodeCollapseListener(assistant);

        // Setup canvas scale listener
        this._setupCanvasScaleListener(assistant);

        // Show assistant
        this.updateAssistantVisibility(assistant);

        return assistant;
    }

    /**
     * Create assistant UI
     */
    createAssistantUI(assistant) {
        // [Fix] Use nodeId for validity check, avoid creation failure when getter returns null during canvas switching
        if (!assistant?.nodeId) return null;

        try {
            // Get location setting
            const locationSetting = app.ui.settings.getSettingValue(
                "ImageCaption.Location"
            );

            // Create AssistantContainer instance
            const container = new AssistantContainer({
                nodeId: assistant.nodeId,
                type: 'image', // Uses image-assistant-container class
                anchorPosition: locationSetting,
                enableDragSort: true,
                onButtonOrderChange: (order) => {
                    // Order preservation handled by container
                },
                shouldCollapse: () => {
                    return !this._checkAssistantActiveState(assistant);
                }
            });

            // Render
            const containerEl = container.render();

            // Set Icon
            const mainIcon = ResourceManager.getIcon('icon-main.svg');
            if (mainIcon && container.indicator) {
                container.indicator.innerHTML = '';
                container.indicator.appendChild(mainIcon);
            }

            // Save references
            assistant.container = container;
            assistant.element = containerEl;
            assistant.innerContent = container.content;
            assistant.hoverArea = container.hoverArea;
            assistant.indicator = container.indicator;
            assistant.buttons = {};

            // Sync state properties
            Object.defineProperty(assistant, 'isCollapsed', {
                get: () => container.isCollapsed,
                set: (val) => {
                    if (val) container.collapse(); else container.expand();
                }
            });
            Object.defineProperty(assistant, 'isTransitioning', {
                get: () => container.isTransitioning,
                set: (val) => { container.isTransitioning = val; }
            });

            // Add buttons
            this.addFunctionButtons(assistant);

            // Restore order
            container.restoreOrder();

            // Initial setup
            // Note: Original code sets position to fixed and appends to body
            // AssistantContainer creates elements but does not mount them.
            // Original code:
            // containerDiv.style.position = 'fixed';
            // document.body.appendChild(containerDiv);

            // We follow the original logic, appending the Image Assistant to body
            containerEl.style.position = 'fixed';
            containerEl.style.zIndex = '1';
            document.body.appendChild(containerEl);

            // Delay position setup
            // Optimization: Use requestAnimationFrame to ensure position is updated before next repaint
            requestAnimationFrame(() => {
                this._setupUIPosition(assistant);
                if (container) container.updateDimensions();
            });

            // Collapse/expand handling is delegated to container
            // Remove manual event setup

            return containerEl;

        } catch (error) {
            logger.error(`Image assistant UI creation failed | ID: ${assistant.nodeId} | ${error.message}`);
            return null;
        }
    }

    /**
     * Add function buttons
     */
    addFunctionButtons(assistant) {
        if (!assistant?.element) return;

        // Create caption button (Chinese)
        const buttonZh = this.addButtonWithIcon(assistant, {
            id: 'caption_zh',
            title: 'Caption Prompt (Chinese)',
            icon: 'icon-caption-zh',
            onClick: async (e, assistant) => {
                e.preventDefault();
                e.stopPropagation();
                await this.handleImageAnalysis(assistant, 'zh');
            },
            // Add context menu for Chinese caption button
            contextMenu: async (assistant) => {
                // Get service list and current active state
                let services = [];
                let currentVLMService = null;
                let currentVLMModel = null;

                // Get Chinese caption rules
                let activePromptId = null;
                let visionPrompts = [];

                try {
                    // Get service list
                    const servicesResp = await fetch(APIService.getApiUrl('/services'));
                    if (servicesResp.ok) {
                        const servicesData = await servicesResp.json();
                        if (servicesData.success) {
                            services = servicesData.services || [];
                        }
                    }

                    // Get currently active VLM service and model
                    const vlmResp = await fetch(APIService.getApiUrl('/config/vision'));
                    if (vlmResp.ok) {
                        const vlmConfig = await vlmResp.json();
                        currentVLMService = vlmConfig.provider || null;
                        currentVLMModel = vlmConfig.model || null;
                    }

                    // Get Chinese caption rules
                    const response = await fetch(APIService.getApiUrl('/config/system_prompts'));
                    if (response.ok) {
                        const data = await response.json();
                        activePromptId = data.active_prompts?.vision_zh || null;

                        if (data.vision_prompts) {
                            const originalOrder = Object.keys(data.vision_prompts);
                            originalOrder.forEach(key => {
                                if (key.startsWith('vision_zh')) {
                                    const prompt = data.vision_prompts[key];
                                    const showIn = prompt.showIn || ['frontend', 'node'];

                                    // Only show in frontend menu when config includes 'frontend'
                                    if (showIn.includes('frontend')) {
                                        visionPrompts.push({
                                            id: key,
                                            name: prompt.name || key,
                                            category: prompt.category || '',
                                            showIn: showIn,
                                            isActive: key === activePromptId
                                        });
                                    }
                                }
                            });
                            visionPrompts.sort((a, b) =>
                                originalOrder.indexOf(a.id) - originalOrder.indexOf(b.id)
                            );
                        }
                    }
                } catch (error) {
                    logger.error(() => `Failed to get Chinese caption config: ${error.message}`);
                }

                // Create service menu items (only show services with VLM models)
                const serviceMenuItems = services
                    .filter(service => service.vlm_models && service.vlm_models.length > 0)
                    .map(service => {
                        const isCurrentService = currentVLMService === service.id;

                        // Create model submenu
                        const modelChildren = (service.vlm_models || []).map(model => {
                            const isCurrentModel = isCurrentService && currentVLMModel === model.name;
                            return {
                                label: model.display_name || model.name,
                                icon: `<span class="pi ${isCurrentModel ? 'pi-check-circle active-status' : 'pi-circle-off inactive-status'}"></span>`,
                                onClick: async (context) => {
                                    try {
                                        const res = await fetch(APIService.getApiUrl('/services/current'), {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ service_type: 'vlm', service_id: service.id, model_name: model.name })
                                        });
                                        if (!res.ok) throw new Error(`Server returned error: ${res.status}`);
                                        const modelLabel = model.display_name || model.name;
                                        UIToolkit.showStatusTip(context.buttonElement, 'success', `Switched to: ${service.name} - ${modelLabel}`);
                                        logger.log(`Vision service switched | Service: ${service.name} | Model: ${modelLabel}`);
                                    } catch (err) {
                                        logger.error(`Failed to switch vision model: ${err.message}`);
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
                                        body: JSON.stringify({ service_type: 'vlm', service_id: service.id })
                                    });
                                    if (!res.ok) throw new Error(`Server returned error: ${res.status}`);
                                    UIToolkit.showStatusTip(context.buttonElement, 'success', `Switched to: ${service.name}`);
                                    logger.log(`Vision service switched | Service: ${service.name}`);
                                } catch (err) {
                                    logger.error(`Failed to switch vision service: ${err.message}`);
                                    UIToolkit.showStatusTip(context.buttonElement, 'error', `Switch failed: ${err.message}`);
                                }
                            },
                            children: modelChildren.length > 0 ? modelChildren : undefined
                        };
                    });

                // ---Create rule menu items (with category grouping support)---
                const ruleMenuItems = [];

                // Helper function: create a single rule menu item
                const createRuleMenuItem = (prompt) => ({
                    label: prompt.name,
                    icon: `<span class="pi ${prompt.isActive ? 'pi-check-circle active-status' : 'pi-circle-off inactive-status'}"></span>`,
                    onClick: async (context) => {
                        try {
                            const response = await fetch(APIService.getApiUrl('/config/active_prompt'), {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ type: 'vision_zh', prompt_id: prompt.id })
                            });
                            if (response.ok) {
                                UIToolkit.showStatusTip(context.buttonElement, 'success', `Switched to: ${prompt.name}`);
                            } else {
                                throw new Error(`Server returned error: ${response.status}`);
                            }
                        } catch (error) {
                            logger.error(`Failed to switch Chinese caption prompt: ${error.message}`);
                            UIToolkit.showStatusTip(context.buttonElement, 'error', `Switch failed: ${error.message}`);
                        }
                    }
                });

                // Group rules by category
                const uncategorizedPrompts = visionPrompts.filter(p => !p.category);
                const categorizedPrompts = visionPrompts.filter(p => p.category);

                // Collect all categories and sort
                const categories = [...new Set(categorizedPrompts.map(p => p.category))].sort();

                // Add uncategorized rules (at top level)
                uncategorizedPrompts.forEach(prompt => {
                    ruleMenuItems.push(createRuleMenuItem(prompt));
                });

                // Add category groups (each category as a submenu)
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
                    label: 'Rule Management',
                    icon: '<span class="pi pi-pen-to-square"></span>',
                    onClick: () => {
                        rulesConfigManager.showRulesConfigModal();
                    }
                });

                return [
                    ...ruleMenuItems,
                    // { type: 'separator' },
                    {
                        label: "Select Service",
                        icon: '<span class="pi pi-sparkles"></span>',
                        submenuAlign: 'bottom',
                        children: serviceMenuItems
                    }
                ];
            }
        });

        // Create caption button (English)
        const buttonEn = this.addButtonWithIcon(assistant, {
            id: 'caption_en',
            title: 'Caption Prompt (English)',
            icon: 'icon-caption-en',
            onClick: async (e, assistant) => {
                e.preventDefault();
                e.stopPropagation();
                await this.handleImageAnalysis(assistant, 'en');
            },
            // Add context menu for English caption button
            contextMenu: async (assistant) => {
                // Get service list and current active state
                let services = [];
                let currentVLMService = null;
                let currentVLMModel = null;

                // Get English caption rules
                let activePromptId = null;
                let visionPrompts = [];

                try {
                    // Get service list
                    const servicesResp = await fetch(APIService.getApiUrl('/services'));
                    if (servicesResp.ok) {
                        const servicesData = await servicesResp.json();
                        if (servicesData.success) {
                            services = servicesData.services || [];
                        }
                    }

                    // Get currently active VLM service and model
                    const vlmResp = await fetch(APIService.getApiUrl('/config/vision'));
                    if (vlmResp.ok) {
                        const vlmConfig = await vlmResp.json();
                        currentVLMService = vlmConfig.provider || null;
                        currentVLMModel = vlmConfig.model || null;
                    }

                    // Get English caption rules
                    const response = await fetch(APIService.getApiUrl('/config/system_prompts'));
                    if (response.ok) {
                        const data = await response.json();
                        activePromptId = data.active_prompts?.vision_en || null;

                        if (data.vision_prompts) {
                            const originalOrder = Object.keys(data.vision_prompts);
                            originalOrder.forEach(key => {
                                if (key.startsWith('vision_en')) {
                                    const prompt = data.vision_prompts[key];
                                    const showIn = prompt.showIn || ['frontend', 'node'];

                                    // Only show in frontend menu when config includes 'frontend'
                                    if (showIn.includes('frontend')) {
                                        visionPrompts.push({
                                            id: key,
                                            name: prompt.name || key,
                                            category: prompt.category || '',
                                            showIn: showIn,
                                            isActive: key === activePromptId
                                        });
                                    }
                                }
                            });
                            visionPrompts.sort((a, b) =>
                                originalOrder.indexOf(a.id) - originalOrder.indexOf(b.id)
                            );
                        }
                    }
                } catch (error) {
                    logger.error(`Failed to get English caption config: ${error.message}`);
                }

                // Create service menu items (only show services with VLM models)
                const serviceMenuItems = services
                    .filter(service => service.vlm_models && service.vlm_models.length > 0)
                    .map(service => {
                        const isCurrentService = currentVLMService === service.id;

                        // Create model submenu
                        const modelChildren = (service.vlm_models || []).map(model => {
                            const isCurrentModel = isCurrentService && currentVLMModel === model.name;
                            return {
                                label: model.display_name || model.name,
                                icon: `<span class="pi ${isCurrentModel ? 'pi-check-circle active-status' : 'pi-circle-off inactive-status'}"></span>`,
                                onClick: async (context) => {
                                    try {
                                        const res = await fetch(APIService.getApiUrl('/services/current'), {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ service_type: 'vlm', service_id: service.id, model_name: model.name })
                                        });
                                        if (!res.ok) throw new Error(`Server returned error: ${res.status}`);
                                        const modelLabel = model.display_name || model.name;
                                        UIToolkit.showStatusTip(context.buttonElement, 'success', `Switched to: ${service.name} - ${modelLabel}`);
                                        logger.log(`Vision service switched | Service: ${service.name} | Model: ${modelLabel}`);
                                    } catch (err) {
                                        logger.error(`Failed to switch vision model: ${err.message}`);
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
                                        body: JSON.stringify({ service_type: 'vlm', service_id: service.id })
                                    });
                                    if (!res.ok) throw new Error(`Server returned error: ${res.status}`);
                                    UIToolkit.showStatusTip(context.buttonElement, 'success', `Switched to: ${service.name}`);
                                    logger.log(`Vision service switched | Service: ${service.name}`);
                                } catch (err) {
                                    logger.error(`Failed to switch vision service: ${err.message}`);
                                    UIToolkit.showStatusTip(context.buttonElement, 'error', `Switch failed: ${err.message}`);
                                }
                            },
                            children: modelChildren.length > 0 ? modelChildren : undefined
                        };
                    });

                // ---Create rule menu items (with category grouping support)---
                const ruleMenuItems = [];

                // Helper function: create a single rule menu item
                const createRuleMenuItem = (prompt) => ({
                    label: prompt.name,
                    icon: `<span class="pi ${prompt.isActive ? 'pi-check-circle active-status' : 'pi-circle-off inactive-status'}"></span>`,
                    onClick: async (context) => {
                        try {
                            const response = await fetch(APIService.getApiUrl('/config/active_prompt'), {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ type: 'vision_en', prompt_id: prompt.id })
                            });
                            if (response.ok) {
                                UIToolkit.showStatusTip(context.buttonElement, 'success', `Switched to: ${prompt.name}`);
                            } else {
                                throw new Error(`Server returned error: ${response.status}`);
                            }
                        } catch (error) {
                            logger.error(`Failed to switch English caption prompt: ${error.message}`);
                            UIToolkit.showStatusTip(context.buttonElement, 'error', `Switch failed: ${error.message}`);
                        }
                    }
                });

                // Group rules by category
                const uncategorizedPrompts = visionPrompts.filter(p => !p.category);
                const categorizedPrompts = visionPrompts.filter(p => p.category);

                // Collect all categories and sort
                const categories = [...new Set(categorizedPrompts.map(p => p.category))].sort();

                // Add uncategorized rules (at top level)
                uncategorizedPrompts.forEach(prompt => {
                    ruleMenuItems.push(createRuleMenuItem(prompt));
                });

                // Add category groups (each category as a submenu)
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
                    label: 'Rule Management',
                    icon: '<span class="pi pi-pen-to-square"></span>',
                    onClick: () => {
                        rulesConfigManager.showRulesConfigModal();
                    }
                });

                return [
                    ...ruleMenuItems,
                    // { type: 'separator' },
                    {
                        label: "Select Service",
                        icon: '<span class="pi pi-sparkles"></span>',
                        submenuAlign: 'bottom',
                        children: serviceMenuItems
                    }
                ];
            }
        });

        // Create buttons


        if (buttonZh) {
            assistant.container.addButton(buttonZh, 'caption_zh');
        }
        if (buttonEn) {
            assistant.container.addButton(buttonEn, 'caption_en');
        }
    }

    // ---Streaming output helper methods---

    /**
     * Create streaming display overlay
     /**
     * Create node inline streaming display container
     */
    _createStreamingOverlay(assistant) {
        try {
            const nodeId = assistant.node?.id;
            // Strategy 1: Prefer getting Vue node container
            let mountContainer = document.querySelector(`[data-node-id="${nodeId}"]`);
            let isLiteGraph = false;

            if (!mountContainer) {
                // Strategy 2: LiteGraph mode, use Body mount + Fixed positioning for "clip isolation"
                mountContainer = document.body;
                isLiteGraph = true;
            }

            // Create outer container
            const container = document.createElement('div');
            container.className = 'node-streaming-text-container';
            if (isLiteGraph) {
                container.classList.add('is-litegraph');
            }

            // Create text content container
            const content = document.createElement('div');
            content.className = 'node-streaming-text-content';

            container.appendChild(content);
            mountContainer.appendChild(container);

            // LiteGraph mode: start frame-synced position locking
            let syncHandler = null;
            if (isLiteGraph) {
                const syncPos = () => {
                    if (!assistant.streamingOverlay || !assistant.streamingOverlay.container) return;
                    this._syncLiteGraphPosition(assistant, container);
                    syncHandler = requestAnimationFrame(syncPos);
                };
                syncHandler = requestAnimationFrame(syncPos);
            }

            // Trigger entrance animation
            requestAnimationFrame(() => {
                container.classList.add('show');
            });

            return { container, content, isLiteGraph, syncHandler };
        } catch (error) {
            logger.error(`Failed to create streaming display container: ${error.message}`);
            return null;
        }
    }

    /**
     * LiteGraph mode position and geometry sync (Viewport absolute positioning)
     */
    _syncLiteGraphPosition(assistant, container) {
        const node = assistant.node;
        if (!node || !app.canvas) return;

        const ds = app.canvas.ds;
        const pos = node.pos;
        const size = node.size;
        const scale = ds?.scale || 1;

        // 1. Get the screen coordinates of the node's top-left corner
        let screenX, screenY;
        if (ds && typeof ds.canvas_to_screen === 'function') {
            const screenPos = ds.canvas_to_screen(pos[0], pos[1]);
            screenX = screenPos[0];
            screenY = screenPos[1];
        } else {
            screenX = (pos[0] + (ds?.offset?.[0] || 0)) * scale;
            screenY = (pos[1] + (ds?.offset?.[1] || 0)) * scale;
        }

        // 2. Sync geometry dimensions: convert node's logical width/height to screen physical pixels
        // Key point: container width/height must sync with scale to prevent text from "overflowing" the node's physical boundaries
        const physicalWidth = size[0] * scale;
        const physicalHeight = 100 * scale; // Logical height 100px converted to physical pixels

        // 3. Calculate alignment position
        // Bottom toolbar logical height is 35px, converted as 35 * scale
        const bottomOffset = 35 * scale;
        const top = screenY + (size[1] * scale) - bottomOffset - physicalHeight;

        // 4. Apply styles to sync container
        container.style.width = `${physicalWidth - 16 * scale}px`; // Subtract edge margin
        container.style.height = `${physicalHeight}px`;
        container.style.left = `${screenX + 8 * scale}px`;
        container.style.top = `${top}px`;

        // 5. Sync content scaling: ensure font size changes with node size
        // Note: We change the container's fontSize to affect content.
        // Content container internally uses relative units or inherits from parent.
        const content = container.querySelector('.node-streaming-text-content');
        if (content) {
            content.style.fontSize = `${10 * scale}px`;
            content.style.lineHeight = `${1.6}`;
        }
    }

    /**
     * Remove streaming inline container
     */
    _removeStreamingOverlay(assistant, overlayObj) {
        if (!overlayObj || !overlayObj.container) return;
        const { container, syncHandler } = overlayObj;

        // Stop sync loop
        if (syncHandler) {
            cancelAnimationFrame(syncHandler);
        }

        try {
            container.classList.remove('show');
            setTimeout(() => {
                if (container.parentNode) {
                    container.parentNode.removeChild(container);
                }
            }, 300);
        } catch (error) {
            logger.error(`Failed to remove streaming container: ${error.message}`);
            if (container.parentNode) container.parentNode.removeChild(container);
        }
    }

    /**
     * Handle image analysis
     */
    async handleImageAnalysis(assistant, lang) {
        // Store current request ID for cancel operation
        let currentRequestId = null;

        try {
            const node = assistant.node;

            // Vue Node 2.0 mode: get currently displayed image from DOM
            // Traditional LiteGraph mode: use node.imgs property
            let currentImage = null;
            const isVueMode = nodeMountService.isVueNodesMode();

            if (isVueMode) {
                // Vue Node 2.0 mode: get image from node container's DOM
                const nodeContainer = document.querySelector(`[data-node-id="${node.id}"]`);
                if (nodeContainer) {
                    // Find img element in node container (prefer preview image)
                    const imgElement = nodeContainer.querySelector('img');
                    if (imgElement && imgElement.src) {
                        // Use image src from DOM
                        currentImage = imgElement.src;
                        logger.debug(`[Image Assistant-Vue Mode] Got image from DOM | Node ID: ${node.id}`);
                    }
                }
            }

            // If Vue mode didn't find an image, or in traditional mode, use node.imgs
            if (!currentImage) {
                if (!node.imgs || node.imgs.length === 0) {
                    throw new Error('No valid image found');
                }
                currentImage = node.imgs[node.imageIndex || 0];
                if (!currentImage) {
                    throw new Error('No valid image found');
                }
            }

            // Get button element
            const buttonId = lang === 'en' ? 'caption_en' : 'caption_zh';
            const buttonElement = assistant.buttons[buttonId];
            if (!buttonElement) {
                throw new Error('Button element not found');
            }

            // Check if button is already in processing state, if so, cancel current request
            if (buttonElement.classList.contains('button-processing') && assistant.currentRequestId) {
                // Cancel current request
                await APIService.cancelRequest(assistant.currentRequestId);

                // Show cancel tip
                UIToolkit.showStatusTip(
                    buttonElement,
                    'info',
                    'Caption cancelled',
                    { x: buttonElement.getBoundingClientRect().left + buttonElement.offsetWidth / 2, y: buttonElement.getBoundingClientRect().top }
                );

                // Reset button state
                this._setButtonState(assistant, buttonId, 'processing', false);

                // Restore other button states
                Object.keys(assistant.buttons).forEach(id => {
                    if (id !== buttonId) {
                        this._setButtonState(assistant, id, 'disabled', false);
                    }
                });

                // Update assistant state to inactive
                this._updateAssistantActiveState(assistant, false);

                // Clear current request ID
                assistant.currentRequestId = null;

                return;
            }

            // Set current button to processing state
            this._setButtonState(assistant, buttonId, 'processing', true);

            // Disable other buttons
            Object.keys(assistant.buttons).forEach(id => {
                if (id !== buttonId) {
                    this._setButtonState(assistant, id, 'disabled', true);
                }
            });

            // Update assistant state to active
            this._updateAssistantActiveState(assistant, true);

            // Show loading status tip
            const tipMessage = lang === 'en' ? "Captioning prompt... (English)" : "Captioning prompt... (Chinese)";
            UIToolkit.showStatusTip(
                buttonElement,
                'loading',
                tipMessage,
                { x: buttonElement.getBoundingClientRect().left + buttonElement.offsetWidth / 2, y: buttonElement.getBoundingClientRect().top }
            );

            // Generate request ID
            // Generate request ID
            currentRequestId = APIService.generateRequestId('icap', null, node.id);
            // Save to assistant object for cancel operation
            assistant.currentRequestId = currentRequestId;

            // Convert image to Base64
            let imageBase64;
            try {
                imageBase64 = await APIService.imageToBase64(currentImage);
                if (!imageBase64) {
                    throw new Error('Image conversion failed');
                }
            } catch (e) {
                throw new Error(`Image conversion failed: ${e.message || e}`);
            }

            // Ensure image data format is correct
            if (typeof imageBase64 !== 'string') {
                throw new Error(`Image data type error: ${typeof imageBase64}`);
            }

            // Ensure image data is in Base64 format
            if (!imageBase64.startsWith('data:image')) {
                imageBase64 = `data:image/jpeg;base64,${imageBase64}`;
            }

            // Get currently active prompt content
            let promptContent = '';
            try {
                const response = await fetch(APIService.getApiUrl('/config/system_prompts'));
                if (response.ok) {
                    const data = await response.json();
                    const activePromptKey = `vision_${lang}`;
                    const activePromptId = data.active_prompts?.[activePromptKey];
                    if (activePromptId && data.vision_prompts?.[activePromptId]) {
                        promptContent = data.vision_prompts[activePromptId].content;
                    }
                }
                if (!promptContent) {
                    throw new Error(`No valid ${lang === 'zh' ? 'Chinese' : 'English'} caption prompt found`);
                }
            } catch (error) {
                throw new Error(`Failed to get caption rules: ${error.message}`);
            }

            // Choose streaming or blocking API based on switch
            let result;
            let fullContent = '';

            if (FEATURES.enableStreaming !== false) {
                // Create inline streaming object
                const overlayObj = this._createStreamingOverlay(assistant);
                if (!overlayObj) {
                    logger.error("[Image Assistant] Unable to create inline streaming display object");
                    return;
                }
                assistant.streamingOverlay = overlayObj;
                // Use streaming API to call image analysis service
                result = await APIService.llmAnalyzeImageStream(
                    imageBase64,
                    promptContent,
                    currentRequestId,
                    (chunk) => {
                        // Streaming callback: update overlay content in real-time
                        fullContent += chunk;
                        if (assistant.streamingOverlay && assistant.streamingOverlay.content) {
                            const contentEl = assistant.streamingOverlay.content;

                            // Update text content
                            contentEl.textContent = fullContent;

                            // Scroll container (keep at bottom)
                            const container = assistant.streamingOverlay.container;
                            container.scrollTop = container.scrollHeight;
                        }
                    }
                );

                // Ensure streaming content is assigned to result object after completion
                if (result && result.success && fullContent) {
                    if (!result.data) result.data = {};
                    result.data.description = fullContent;
                }
            } else {
                // ---Blocking output: directly call image analysis service---
                result = await APIService.llmAnalyzeImage(
                    imageBase64,
                    promptContent,
                    currentRequestId
                );
            }

            // Remove streaming inline container
            if (assistant.streamingOverlay) {
                this._removeStreamingOverlay(assistant, assistant.streamingOverlay);
                assistant.streamingOverlay = null;
            }

            // Clear current request ID
            assistant.currentRequestId = null;

            // Check if cancelled
            if (result && result.cancelled) {
                logger.debug(`Image analysis request cancelled | ID: ${currentRequestId}`);
                return;
            }

            if (!result || !result.success) {
                const errorMsg = result?.error || 'Unknown error';
                throw new Error(errorMsg);
            }

            // Get description text (prefer streaming collected content)
            const description = fullContent || result.data?.description;
            if (!description) {
                throw new Error('Failed to get image description');
            }

            // Try to copy to clipboard
            let copySuccess = false;
            try {
                // Prefer modern Clipboard API
                if (navigator.clipboard && window.isSecureContext) {
                    await navigator.clipboard.writeText(description);
                    copySuccess = true;
                } else {
                    // Create a temporary textarea element
                    const textarea = document.createElement('textarea');
                    textarea.value = description;
                    textarea.style.position = 'fixed';
                    textarea.style.left = '0';
                    textarea.style.top = '0';
                    textarea.style.opacity = '0';
                    document.body.appendChild(textarea);

                    // Try to focus and select text
                    textarea.focus();
                    textarea.select();
                    textarea.setSelectionRange(0, textarea.value.length);

                    // Try to copy
                    try {
                        copySuccess = document.execCommand('copy');
                    } catch (err) {
                        logger.warn(`execCommand copy failed: ${err.message}`);
                    }

                    // Remove temporary element
                    document.body.removeChild(textarea);
                }

                if (!copySuccess) {
                    throw new Error('Copy to clipboard operation failed');
                }
            } catch (copyError) {
                logger.warn(`Copy to clipboard failed: ${copyError.message}`);
                // Continue execution even if copy fails, don't throw error, but record status
                copySuccess = false;
            }

            // Create history record for current image node
            HistoryCacheService.addHistory({
                node_id: node.id,
                input_id: "image",
                content: description,
                operation_type: 'caption',
                timestamp: Date.now(),
                request_id: currentRequestId
            });

            // Show success tip
            const successMessage = copySuccess
                ? (lang === 'en' ? "Caption complete, copied to clipboard" : "Caption complete, copied to clipboard")
                : (lang === 'en' ? "Caption complete, but copy failed" : "Caption complete, but copy failed");

            UIToolkit.showStatusTip(
                buttonElement,
                copySuccess ? 'success' : 'warning',
                successMessage,
                { x: buttonElement.getBoundingClientRect().left + buttonElement.offsetWidth / 2, y: buttonElement.getBoundingClientRect().top }
            );

            // Limit Toast display text length
            const maxLength = 40;
            const truncatedDescription = description.length > maxLength
                ? description.substring(0, maxLength) + '...'
                : description;

            // Show Toast notification
            app.extensionManager.toast.add({
                severity: copySuccess ? "success" : "info",
                summary: copySuccess
                    ? (lang === 'en' ? "Image caption complete (English), use ctrl+v to paste" : "Image caption complete (Chinese), use ctrl+v to paste")
                    : (lang === 'en' ? "Image caption complete (English), but copy failed, please copy manually" : "Image caption complete (Chinese), but copy failed, please copy manually"),
                detail: truncatedDescription,
                life: 5000
            });

            // If copy failed, create a dialog to display result, allowing user to copy manually
            if (!copySuccess) {
                this._showCopyDialog(description, lang);
            }

        } catch (error) {
            // Clear current request ID
            assistant.currentRequestId = null;

            logger.error(`Image analysis failed: ${error.message}`);

            // Get button element
            const buttonId = lang === 'en' ? 'caption_en' : 'caption_zh';
            const buttonElement = assistant.buttons[buttonId];

            if (buttonElement) {
                // Show error tip
                UIToolkit.showStatusTip(
                    buttonElement,
                    'error',
                    error.message,
                    { x: buttonElement.getBoundingClientRect().left + buttonElement.offsetWidth / 2, y: buttonElement.getBoundingClientRect().top }
                );
            };

            app.extensionManager.toast.add({
                severity: "error",
                summary: lang === 'en' ? "Error" : "Error",
                detail: error.message,
                life: 3000
            });
        } finally {
            // Get button ID
            const buttonId = lang === 'en' ? 'caption_en' : 'caption_zh';

            // Reset current button state
            this._setButtonState(assistant, buttonId, 'processing', false);

            // Restore other button states
            Object.keys(assistant.buttons).forEach(id => {
                if (id !== buttonId) {
                    this._setButtonState(assistant, id, 'disabled', false);
                }
            });

            // Update assistant state to inactive
            this._updateAssistantActiveState(assistant, false);
        }
    }

    /**
     * Show copy dialog
     * When Clipboard API fails, provides a dialog for user to manually copy content
     */
    _showCopyDialog(content, lang) {
        // Create dialog container
        const dialogContainer = document.createElement('div');
        dialogContainer.className = 'image-assistant-copy-dialog';

        // Create title
        const title = document.createElement('div');
        title.className = 'image-assistant-copy-dialog-title';
        title.textContent = 'Clipboard access is restricted, please manually click to copy the prompt content';
        dialogContainer.appendChild(title);

        // Create close button
        const closeButton = document.createElement('button');
        closeButton.className = 'image-assistant-copy-dialog-close';
        closeButton.onclick = () => {
            document.body.removeChild(dialogContainer);
        };

        // Add close icon
        UIToolkit.addIconToButton(closeButton, 'pi-times', 'Close');
        dialogContainer.appendChild(closeButton);

        // Create text area
        const contentArea = document.createElement('textarea');
        contentArea.className = 'image-assistant-copy-dialog-textarea';
        contentArea.value = content;
        contentArea.readOnly = true;
        dialogContainer.appendChild(contentArea);

        // Create copy button
        const copyButton = document.createElement('button');
        copyButton.className = 'image-assistant-copy-dialog-copy-btn';
        copyButton.textContent = 'Copy to Clipboard';
        copyButton.onclick = () => {
            contentArea.select();
            try {
                const success = document.execCommand('copy');
                if (success) {
                    copyButton.textContent = 'Copy successful!';
                    // After successful copy, delay 500ms before closing dialog to show success tip
                    setTimeout(() => {
                        if (document.body.contains(dialogContainer)) {
                            document.body.removeChild(dialogContainer);
                        }
                    }, 500);
                } else {
                    copyButton.textContent = 'Copy failed, please select and copy manually';
                    contentArea.focus();
                }
            } catch (err) {
                copyButton.textContent = 'Copy failed, please select and copy manually';
                contentArea.focus();
            }
        };
        dialogContainer.appendChild(copyButton);

        // Add to document
        document.body.appendChild(dialogContainer);

        // Focus content area so user can copy immediately
        setTimeout(() => {
            contentArea.focus();
            contentArea.select();
        }, 100);
    }

    /**
     * Set button state
     */
    _setButtonState(assistant, buttonId, stateType, value = true) {
        try {
            const button = assistant.buttons[buttonId];
            if (!button) return;

            const stateClass = `button-${stateType}`;

            if (value) {
                button.classList.add(stateClass);
                // If disabling, add disabled attribute
                if (stateType === 'disabled') {
                    button.setAttribute('disabled', 'disabled');
                }
            } else {
                button.classList.remove(stateClass);
                // If re-enabling, remove disabled attribute
                if (stateType === 'disabled') {
                    button.removeAttribute('disabled');
                }
            }

            // Update button clickability state
            this._updateButtonClickability(button, stateType, value);

        } catch (error) {
            logger.error(`Button state | Setting failed | Button: ${buttonId} | State: ${stateType} | Error: ${error.message}`);
        }
    }

    /**
     * Update button clickability state
     */
    _updateButtonClickability(button, stateType, value) {
        // Check if button is in disabled state
        const isDisabled = button.classList.contains('button-disabled');

        // Processing buttons remain clickable (for cancel operation)
        const isProcessing = button.classList.contains('button-processing');

        if (isDisabled) {
            // If button is disabled, block click events
            button.style.pointerEvents = 'none';
        } else {
            // Restore click events, including processing buttons
            button.style.pointerEvents = 'auto';
        }
    }

    /**
     * Check if assistant has buttons in active state
     */
    _checkAssistantActiveState(assistant) {
        if (!assistant || !assistant.buttons) return false;

        // 0. Check if popup is transitioning (don't allow collapse during transition)
        if (PopupManager._isTransitioning) {

            return true;
        }

        // 1. Check if context menu is visible (and belongs to current assistant)
        if (buttonMenu.isMenuVisible && buttonMenu.menuContext?.widget === assistant) {

            return true;
        }

        // 2. Check if PopupManager's active popup belongs to current assistant
        if (PopupManager.activePopupInfo?.buttonInfo?.widget === assistant) {

            return true;
        }

        // 3. Check button active/processing state
        for (const buttonId in assistant.buttons) {
            const button = assistant.buttons[buttonId];
            if (button.classList.contains('button-active') ||
                button.classList.contains('button-processing')) {

                return true;
            }
        }

        return false;
    }

    /**
     * Update assistant active state
     */
    _updateAssistantActiveState(assistant, isActive) {
        if (!assistant) return;

        // Update active state
        assistant.isActive = isActive;

        // If active, force show assistant
        if (isActive) {
            this.showAssistantUI(assistant);
        } else {
            // If no longer active, update visibility first
            this.updateAssistantVisibility(assistant);

            // Then manually trigger auto-collapse (if assistant is still visible and expanded)
            if (assistant.element &&
                assistant.element.style.display !== 'none' &&
                !assistant.isCollapsed &&
                !assistant.isTransitioning) {
                // Delay before triggering collapse to give user time to see the result
                setTimeout(() => {
                    this.triggerAutoCollapse(assistant);
                }, 1500); // Auto-collapse after 1.5 seconds, giving user enough time to view result
            }
        }
    }

    /**
     * Show assistant UI
     */
    showAssistantUI(assistant) {
        if (!assistant?.element) return;

        // Avoid redundant show
        if (assistant.element.classList.contains('image-assistant-show')) {
            // Ensure element is visible
            assistant.element.style.display = 'flex';
            assistant.element.style.opacity = '1';
            return;
        }

        // Show directly, no animation transition
        assistant.element.style.opacity = '1';
        assistant.element.style.display = 'flex';
        assistant.element.classList.add('image-assistant-show');

        // Ensure hover area is visible (for interaction in collapsed state)
        if (assistant.isCollapsed && assistant.hoverArea) {
            assistant.hoverArea.style.display = 'block';
        }

        // Reset transition state
        assistant.isTransitioning = false;

        // Only trigger auto-collapse when clearly not in collapsed state
        if (!assistant.isCollapsed) {
            this.triggerAutoCollapse(assistant);
        }
    }

    /**
     * Hide assistant UI
     */
    hideAssistantUI(assistant) {
        if (!assistant?.element) return;

        // Clear auto-collapse timer
        if (assistant._autoCollapseTimer) {
            clearTimeout(assistant._autoCollapseTimer);
            assistant._autoCollapseTimer = null;
        }

        // Hide element
        assistant.element.style.display = 'none';
        assistant.element.classList.remove('image-assistant-show');

        // Reset state
        assistant.isTransitioning = false;
    }

    /**
     * Update assistant visibility
     */
    updateAssistantVisibility(assistant) {
        // Check if instance has been destroyed
        if (!assistant || assistant.isDestroyed) return;

        // Dynamically get node
        const node = assistant.node;

        // Record current display state for change detection
        const wasVisible = assistant.element &&
            assistant.element.style.display !== 'none' &&
            assistant.element.classList.contains('image-assistant-show');

        // Check master switch and image caption feature switch state
        if (!window.FEATURES || !window.FEATURES.enabled || !window.FEATURES.imageCaption) {
            this.cleanup(assistant.nodeId);
            return;
        }

        // Check if node has been deleted
        if (!node) {
            this.cleanup(assistant.nodeId);
            return;
        }

        // Use unified state detection method
        const nodeState = this._checkNodeAndCanvasState(assistant.node);

        // Check if any buttons are in active state
        const hasActiveButtons = this._checkAssistantActiveState(assistant);

        // Determine new visibility state
        let shouldBeVisible = true;

        // If there are active buttons, force show assistant (overrides other hide conditions)
        if (hasActiveButtons) {
            this.showAssistantUI(assistant);

            // If currently collapsed, expand
            if (assistant.isCollapsed) {
                this._expandAssistant(assistant);
            }

            return;
        }

        // If node is collapsed or canvas zoom is too small, hide assistant but don't clean up instance
        if (nodeState.isCollapsed || nodeState.isLowQuality) {
            shouldBeVisible = false;
        }

        // If node has no valid image, hide assistant but don't clean up instance
        if (!nodeState.hasValidImage) {
            shouldBeVisible = false;

            // ---Async image detection logic (for performance optimization)---
            // If node is a supported type but temporarily has no image, start a lightweight internal probe
            if (!assistant._imageDetectionTimer) {
                const detectImage = () => {
                    if (!assistant.node) return;
                    const currentState = this._checkNodeAndCanvasState(assistant.node);
                    if (currentState.hasValidImage) {
                        logger.debug(() => `[Image Assistant] Async image load successful | ID: ${assistant.nodeId}`);
                        assistant._imageDetectionTimer = null;
                        this.updateAssistantVisibility(assistant);
                    } else if (document.body.contains(assistant.element)) {
                        // Continue waiting, check every second (very low overhead)
                        assistant._imageDetectionTimer = setTimeout(detectImage, 1000);
                    } else {
                        assistant._imageDetectionTimer = null;
                    }
                };
                assistant._imageDetectionTimer = setTimeout(detectImage, 1000);
            }
        } else {
            // Image exists, clean up detection timer
            if (assistant._imageDetectionTimer) {
                clearTimeout(assistant._imageDetectionTimer);
                assistant._imageDetectionTimer = null;
            }
        }

        // Skip instances that are transitioning to avoid animation interruption
        if (assistant.isTransitioning) {
            return;
        }

        // Update UI based on visibility state
        if (shouldBeVisible) {
            // Show assistant when conditions are met
            this.showAssistantUI(assistant);
        } else {
            // Hide assistant
            this.hideAssistantUI(assistant);
        }
    }

    /**
     * Expand assistant
     */

    _expandAssistant(assistant) {
        if (assistant && assistant.container) {
            assistant.container.expand();
        }
    }


    /**
     * Trigger auto-collapse
     */

    triggerAutoCollapse(assistant) {
        if (assistant && assistant.container) {
            assistant.container.collapse();
        }
    }




    /**
     * Add button with icon
     */
    addButtonWithIcon(assistant, config) {
        if (!assistant?.element || !assistant?.innerContent) return null;

        const { id, title, icon, onClick, contextMenu } = config;

        // Create button
        const button = document.createElement('button');
        button.className = 'image-assistant-button';
        button.title = title || '';
        button.dataset.id = id || `btn_${Date.now()}`;

        // Add icon - use UIToolkit's SVG icon method
        if (icon) {
            UIToolkit.addIconToButton(button, icon, title || '');
        }

        // Add events
        if (typeof onClick === 'function') {
            button.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                // Allow click even when button is processing, for cancel operation
                // If button is disabled, don't execute
                if (button.classList.contains('button-disabled')) {
                    return;
                }

                // Execute click callback
                onClick(e, assistant);
            });
        }

        // Add context menu (if available)
        if (contextMenu && typeof contextMenu === 'function') {
            this._setupButtonContextMenu(button, contextMenu, assistant);
        }

        // Save reference
        if (id) {
            assistant.buttons[id] = button;
        }

        return button;
    }

    /**
     * Setup UI position
     * Supports both Vue node2.0 and litegraph.js rendering modes
     */
    _setupUIPosition(assistant) {
        if (!assistant?.element || !assistant?.node) return;

        const containerDiv = assistant.element;
        const renderMode = nodeMountService.detectRenderMode();

        // Save render mode to assistant
        assistant._renderMode = renderMode;

        if (renderMode === RENDER_MODE.VUE_NODES) {
            // Vue node2.0 mode: use relative positioning to mount inside node container
            this._setupUIPositionVueNodes(assistant, containerDiv);
        } else {
            // litegraph.js mode: use fixed positioning and canvas coordinate calculation
            this._setupUIPositionLitegraph(assistant, containerDiv);
        }
    }

    /**
     * Vue node2.0 mode positioning logic
     */
    _setupUIPositionVueNodes(assistant, containerDiv) {
        const containerInfo = nodeMountService.findImageNodeContainer(assistant.node);

        if (!containerInfo || !containerInfo.container) {
            logger.warn(`[Image Assistant-Vue Positioning] Node container not found | ID: ${assistant.node.id}`);
            // Fallback to litegraph mode
            this._setupUIPositionLitegraph(assistant, containerDiv);
            return;
        }

        const { container: nodeContainer } = containerInfo;

        // Vue mode: use absolute positioning, mount inside node container
        containerDiv.style.position = 'absolute';
        containerDiv.style.left = '6px';
        containerDiv.style.bottom = '6px';
        containerDiv.style.right = 'auto';
        containerDiv.style.top = 'auto';
        containerDiv.style.zIndex = '10';

        // Remove fixed positioning related styles
        containerDiv.style.transform = 'none';

        // Add Vue mode marker class
        containerDiv.classList.add('vue-node-mode');

        // Remove from document.body (if previously mounted)
        if (containerDiv.parentElement === document.body) {
            document.body.removeChild(containerDiv);
        }

        // Mount to node container
        nodeContainer.appendChild(containerDiv);

        // Add cleanup function
        assistant._eventCleanupFunctions = assistant._eventCleanupFunctions || [];
        assistant._eventCleanupFunctions.push(() => {
            if (containerDiv && containerDiv.parentElement) {
                containerDiv.parentElement.removeChild(containerDiv);
            }
        });

        logger.debug(`[Image Assistant-Vue Positioning] Complete | Node ID: ${assistant.node.id}`);
    }

    /**
     * litegraph.js mode positioning logic (original logic)
     */
    _setupUIPositionLitegraph(assistant, containerDiv) {
        // Position update function
        const updatePosition = () => {
            if (!assistant.element || !assistant.node) return;

            try {
                const canvas = app.canvas;
                // If canvas is not initialized, retry with delay
                if (!canvas) {
                    requestAnimationFrame(() => updatePosition());
                    return;
                }

                // Get canvas scale ratio
                const scale = canvas.ds.scale;

                // Get node bounds
                const [nodeX, nodeY, nodeWidth, nodeHeight] = assistant.node.getBounding();

                // Calculate inner offset (to place assistant inside node)
                const INNER_OFFSET_X = 6; // Horizontal offset
                const INNER_OFFSET_Y = 6; // Vertical offset

                // Calculate anchor position (bottom-left of node)
                const anchorX = nodeX + INNER_OFFSET_X;
                const anchorY = nodeY + nodeHeight - INNER_OFFSET_Y;

                // Get canvas element bounds
                const rect = canvas.canvas.getBoundingClientRect();

                // Convert anchor position to screen coordinates
                const canvasPoint = canvas.convertOffsetToCanvas([anchorX, anchorY]);

                if (!canvasPoint) return;

                // Calculate final screen coordinates (considering canvas element position)
                const screenX = canvasPoint[0] + rect.left;
                const screenY = canvasPoint[1] + rect.top;

                // Set container position, aligning its bottom-left with the anchor point
                containerDiv.style.left = `${screenX}px`;
                containerDiv.style.bottom = `${window.innerHeight - screenY}px`;
                containerDiv.style.right = 'auto';
                containerDiv.style.top = 'auto';

                // Apply scaling
                containerDiv.style.setProperty('--assistant-scale', scale);

            } catch (error) {
                // Only log on first error
                if (!assistant._lastPositionError) {
                    logger.error(() => `Failed to update assistant position: ${error.message}`);
                    assistant._lastPositionError = Date.now();
                }
            }
        };

        // Initial position update
        updatePosition();

        // Use debounced function to optimize position updates
        const debouncedUpdatePosition = EventManager.debounce(updatePosition, 16);

        // Add window resize event listener
        assistant._eventCleanupFunctions = assistant._eventCleanupFunctions || [];
        const removeResizeListener = EventManager.addDOMListener(window, 'resize', debouncedUpdatePosition);
        assistant._eventCleanupFunctions.push(removeResizeListener);

        // Monitor canvas changes
        if (app.canvas) {
            // Monitor canvas redraw
            // Optimization: Use requestAnimationFrame to update position each frame, or leverage LiteGraph's render loop
            // For smooth following, update directly in drawBackground hook
            const originalDrawBackground = app.canvas.onDrawBackground;
            const onDrawWrapper = function () {
                const ret = originalDrawBackground?.apply(this, arguments);
                updatePosition();
                return ret;
            };
            app.canvas.onDrawBackground = onDrawWrapper;

            // Add canvas redraw cleanup function
            assistant._eventCleanupFunctions.push(() => {
                if (app.canvas.onDrawBackground === onDrawWrapper) {
                    app.canvas.onDrawBackground = originalDrawBackground;
                }
            });

            // Monitor node movement
            if (assistant.node) {
                // Use LiteGraph's onNodeMoved event
                const originalOnNodeMoved = app.canvas.onNodeMoved;
                app.canvas.onNodeMoved = function (node_dragged) {
                    if (originalOnNodeMoved) {
                        originalOnNodeMoved.apply(this, arguments);
                    }

                    // Only update position when the moved node is the current one
                    if (node_dragged && node_dragged.id === assistant.node.id) {
                        updatePosition();
                    }
                };

                // Add node movement cleanup function
                assistant._eventCleanupFunctions.push(() => {
                    if (app.canvas) {
                        app.canvas.onNodeMoved = originalOnNodeMoved;
                    }
                });

                // Add movement listener to the node itself (compatibility handling)
                const nodeOriginalOnNodeMoved = assistant.node.onNodeMoved;
                assistant.node.onNodeMoved = function () {
                    const ret = nodeOriginalOnNodeMoved?.apply(this, arguments);
                    updatePosition();
                    return ret;
                };

                // Add node's own movement cleanup function
                assistant._eventCleanupFunctions.push(() => {
                    if (assistant.node && nodeOriginalOnNodeMoved) {
                        assistant.node.onNodeMoved = nodeOriginalOnNodeMoved;
                    }
                });
            }

            // Monitor canvas zoom
            const originalDSModified = app.canvas.ds.onModified;
            app.canvas.ds.onModified = function (...args) {
                if (originalDSModified) {
                    originalDSModified.apply(this, args);
                }
                // Update directly on zoom
                updatePosition();
            };

            // Add canvas zoom cleanup function
            assistant._eventCleanupFunctions.push(() => {
                if (app.canvas?.ds) {
                    app.canvas.ds.onModified = originalDSModified;
                }
            });
        }

        // Add DOM element cleanup function
        assistant._eventCleanupFunctions.push(() => {
            if (containerDiv && document.body.contains(containerDiv)) {
                document.body.removeChild(containerDiv);
            }
        });
    }

    /**
     * Setup node collapse state listener
     */
    _setupNodeCollapseListener(assistant) {
        if (!assistant?.node) return;

        const node = assistant.node;

        // Save original collapse method
        const originalCollapse = node.collapse;

        // Override collapse method
        node.collapse = function () {
            // Call original collapse method
            originalCollapse.apply(this, arguments);

            // Call unified visibility update method instead of directly manipulating DOM
            const imageCaptionInstance = window.imageCaptionInstance || imageCaption;
            if (imageCaptionInstance && typeof imageCaptionInstance.updateAssistantVisibility === 'function') {
                imageCaptionInstance.updateAssistantVisibility(assistant);
            }
        };

        // Save cleanup function
        assistant._eventCleanupFunctions.push(() => {
            // Restore original collapse method
            if (node.collapse !== originalCollapse) {
                node.collapse = originalCollapse;
            }
        });
    }

    /**
     * Setup canvas scale listener
     */
    _setupCanvasScaleListener(assistant) {
        if (!assistant?.node || !app.canvas) return;

        let lastScale = app.canvas.ds.scale;

        // Use class method to get threshold for consistency
        const threshold = this._getQualityThreshold();

        // Directly detect zoom state and update UI visibility
        const checkScaleAndUpdate = () => {
            if (!assistant.element || !assistant.node || !app.canvas) return;

            const currentScale = app.canvas.ds.scale;
            const threshold = imageCaption._getQualityThreshold(); // Fix: use global instance's method
            const epsilon = 0.001; // Increased tolerance value

            // Calculate difference from last scale
            const scaleDiff = Math.abs(currentScale - lastScale);

            // Update last scale value
            lastScale = currentScale;

            // Determine current quality state (using tolerance value)
            const isCurrentlyLowQuality = currentScale <= threshold + epsilon;

            // Unconditionally update UI visibility, let _checkNodeAndCanvasState method decide whether to show
            this.updateAssistantVisibility(assistant);
        };

        // Ensure immediate response
        const immediateUpdate = checkScaleAndUpdate;

        // Monitor canvas mouse wheel event (zoom)
        const wheelHandler = (e) => {
            if (e.ctrlKey || e.metaKey) {
                // Update immediately and schedule delayed check
                immediateUpdate();
                setTimeout(immediateUpdate, 50);
            }
        };

        // Monitor canvas touch event (mobile zoom)
        const touchHandler = (e) => {
            if (e.touches && e.touches.length === 2) {
                // Update immediately and schedule delayed check
                immediateUpdate();
                setTimeout(immediateUpdate, 50);
            }
        };

        // Add event listeners
        const canvas = app.canvas.canvas;
        if (canvas) {
            canvas.addEventListener('wheel', wheelHandler, { passive: true });
            canvas.addEventListener('touchmove', touchHandler, { passive: true });
        }

        // Periodically check scale changes
        const scaleCheckInterval = setInterval(immediateUpdate, 50);

        // Initial check of current state
        immediateUpdate();

        // Save cleanup functions
        assistant._eventCleanupFunctions.push(() => {
            if (canvas) {
                canvas.removeEventListener('wheel', wheelHandler);
                canvas.removeEventListener('touchmove', touchHandler);
            }
            clearInterval(scaleCheckInterval);
        });

        // Monitor canvas zoom event (directly monitor ds.scale changes)
        const originalDSScale = Object.getOwnPropertyDescriptor(app.canvas.ds, 'scale');
        if (originalDSScale && originalDSScale.set) {
            const originalSetter = originalDSScale.set;

            Object.defineProperty(app.canvas.ds, 'scale', {
                get: originalDSScale.get,
                set: function (value) {
                    // Get old value
                    const oldValue = this.scale;
                    const threshold = imageCaption._getQualityThreshold();

                    // Call original setter
                    originalSetter.call(this, value);

                    // Detect if threshold boundary was crossed
                    const epsilon = 0.001;
                    const crossedThreshold =
                        (oldValue <= threshold + epsilon && value > threshold + epsilon) ||
                        (oldValue > threshold + epsilon && value <= threshold + epsilon);

                    if (crossedThreshold) {
                        // If threshold was crossed, only log once
                        // Use static variable to record last threshold crossing time, avoid repeated output in short intervals
                        const now = Date.now();
                        if (!ImageCaption._lastThresholdCrossTime || now - ImageCaption._lastThresholdCrossTime > 500) {
                            logger.log(`[Image Assistant-Scale Listener] Crossed threshold | Old: ${oldValue.toFixed(4)} | New: ${value.toFixed(4)} | Threshold: ${threshold}`);
                            ImageCaption._lastThresholdCrossTime = now;
                        }
                    }

                    // Update immediately regardless of threshold crossing
                    immediateUpdate();

                    // Multiple checks to ensure state is correctly applied
                    setTimeout(immediateUpdate, 10);
                    setTimeout(immediateUpdate, 50);
                    setTimeout(() => {
                        // Update all existing image assistant instances
                        ImageCaption.instances.forEach((instance) => {
                            if (instance && instance.node) {
                                imageCaption.updateAssistantVisibility(instance);
                            }
                        });
                    }, 100);
                },
                configurable: true
            });

            // Add cleanup function
            assistant._eventCleanupFunctions.push(() => {
                if (app.canvas && app.canvas.ds) {
                    Object.defineProperty(app.canvas.ds, 'scale', originalDSScale);
                }
            });
        }
    }

    /**
     * Setup collapse/expand events
     */
    _setupCollapseExpandEvents(assistant) {
        // Event handling is delegated to AssistantContainer
    }



    /**
     * Setup button context menu
     * @param {HTMLElement} button Button element
     * @param {Function} getMenuItems Function to get menu items
     * @param {Object} assistant Assistant instance
     */
    _setupButtonContextMenu(button, getMenuItems, assistant) {
        if (!button || typeof getMenuItems !== 'function') return;

        // Ensure assistant object has correct type identifier for context menu close identification
        assistant.type = 'image_caption_assistant';

        const cleanup = buttonMenu.setupButtonMenu(button, () => {
            return getMenuItems(assistant);
        }, { widget: assistant, buttonElement: button }); // Pass correct context

        if (cleanup) {
            assistant._eventCleanupFunctions = assistant._eventCleanupFunctions || [];
            assistant._eventCleanupFunctions.push(cleanup);
        }
    }

    // ---Static methods---
    /**
     * Add instance to manager
     */
    static addInstance(nodeId, assistant) {
        if (nodeId != null && assistant != null) {
            this.instances.set(String(nodeId), assistant);
            return true;
        }
        return false;
    }

    /**
     * Get instance
     */
    static getInstance(nodeId) {
        if (nodeId == null) return null;

        // Ensure nodeId is string type
        const key = String(nodeId);
        const instance = this.instances.get(key);


        return instance;
    }

    /**
     * Check if instance exists
     */
    static hasInstance(nodeId) {
        if (nodeId == null) return false;
        // Ensure nodeId is string type
        return this.instances.has(String(nodeId));
    }

    /**
     * Clean up assistant instance
     * @param {string|null} nodeId - Node ID, if null clean up all instances
     * @param {boolean} silent - Whether to clean up silently (no log output)
     */
    cleanup(nodeId = null, silent = false) {
        // If switching workflows, fully clean up image assistant instances
        if (window.PROMPT_ASSISTANT_WORKFLOW_SWITCHING) {
            // Simplified logging: don't print individual node cleanup logs during workflow switching

            if (nodeId === null) {
                // Clean up all instances and remove from collection
                const instanceCount = ImageCaption.instances.size;
                if (instanceCount > 0) {
                    ImageCaption.instances.forEach((assistant, id) => {
                        this._cleanupSingleInstance(assistant);
                    });
                    // Clear instance collection
                    ImageCaption.instances.clear();
                }
            } else {
                // Clean up specific node instance
                const assistant = ImageCaption.getInstance(nodeId);
                if (assistant) {
                    this._cleanupSingleInstance(assistant);
                    ImageCaption.instances.delete(String(nodeId));
                }
            }

            return;
        }

        try {
            if (nodeId === null) {
                // Clean up all instances
                const instanceCount = ImageCaption.instances.size;
                if (instanceCount > 0) {
                    ImageCaption.instances.forEach((assistant, id) => {
                        this._cleanupSingleInstance(assistant);
                    });
                    ImageCaption.instances.clear();
                    if (!silent) {
                        logger.log(`Cleaned up all image assistant instances | Count: ${instanceCount}`);
                    }
                }
            } else {
                // Clean up specified instance
                const assistant = ImageCaption.getInstance(nodeId);
                if (assistant) {
                    this._cleanupSingleInstance(assistant);
                    ImageCaption.instances.delete(String(nodeId));
                    if (!silent) {
                        logger.log(`Cleaned up image assistant instance | ID: ${nodeId}`);
                    }
                }
            }
        } catch (error) {
            logger.error(`Failed to clean up image assistant instance | ${error.message}`);
        }
    }

    /**
     * Internal method to clean up a single instance
     * @param {object} assistant - Assistant instance
     */
    _cleanupSingleInstance(assistant) {
        if (!assistant) return;

        // Mark instance as destroyed
        assistant.isDestroyed = true;

        try {
            // Clean up DOM elements
            if (assistant.element && assistant.element.parentNode) {
                assistant.element.parentNode.removeChild(assistant.element);
            }

            // Clean up event listeners
            if (assistant._eventCleanupFunctions && Array.isArray(assistant._eventCleanupFunctions)) {
                assistant._eventCleanupFunctions.forEach(cleanup => {
                    if (typeof cleanup === 'function') {
                        cleanup();
                    }
                });
                assistant._eventCleanupFunctions = [];
            }

            // Clean up timers
            if (assistant._timers) {
                Object.values(assistant._timers).forEach(timer => {
                    if (timer) {
                        clearTimeout(timer);
                    }
                });
                assistant._timers = {};
            }

            if (assistant._imageDetectionTimer) {
                clearTimeout(assistant._imageDetectionTimer);
                assistant._imageDetectionTimer = null;
            }

            // Clean up references (node property is a dynamic getter, no manual cleanup needed)
            assistant.element = null;
            assistant.innerContent = null;
            assistant.hoverArea = null;
            assistant.indicator = null;
            assistant.buttons = {};
        } catch (error) {
            logger.error(`Failed to clean up single instance | ${error.message}`);
        }
    }

    /**
     * Unified master switch control
     */
    async toggleGlobalFeature(enable, force = false) {
        // Update state
        const oldValue = window.FEATURES.imageCaption;
        window.FEATURES.imageCaption = enable;

        // Don't execute if state hasn't changed, unless force is true
        if (!force && oldValue === enable) {
            return;
        }

        // Only log when state changes or forced
        if (oldValue !== enable || force) {
            logger.log(`Image caption feature | Action: ${enable ? "enable" : "disable"}`);
        }

        try {
            if (enable) {
                // === Enable image caption feature ===
                // Ensure manager is initialized
                if (!EventManager.initialized) {
                    EventManager.init();
                }

                // 1. Reset node initialization flags, prepare for re-detection
                if (app.canvas && app.canvas.graph) {
                    const nodes = app.canvas.graph._nodes || [];
                    nodes.forEach(node => {
                        if (node) {
                            node._imageCaptionInitialized = false;
                        }
                    });

                    // 2. If auto-creation is enabled, immediately scan all valid nodes
                    const icCreationMode = app.ui.settings.getSettingValue("PromptAssistant.Settings.ImageCaptionCreationMode") || "auto";
                    if (icCreationMode === "auto") {
                        nodes.forEach(node => {
                            if (node && this.hasValidImage(node) && !node._imageCaptionInitialized) {
                                node._imageCaptionInitialized = true;
                                this.checkAndSetupNode(node);
                            }
                        });
                    }
                }

                // 3. Setup or restore node selection event listener
                this.registerNodeSelectionListener();

                // 4. Check currently selected nodes
                if (app.canvas && app.canvas.selected_nodes) {
                    app.canvas._imageCaptionSelectionHandler(app.canvas.selected_nodes);
                }
            } else {
                // === Disable image caption feature ===
                // 1. Clean up all instances
                this.cleanup(null, true);
            }

            // Update button visibility
            if (window.FEATURES.updateButtonsVisibility) {
                window.FEATURES.updateButtonsVisibility();
            }
        } catch (error) {
            logger.error(`Image assistant feature toggle failed | Error: ${error.message}`);
        }
    }

    /**
     * Update preset dimensions of all instances
     * Called when feature switch or config changes, triggers container's constant layout calculation logic
     */
    updateAllInstancesWidth() {
        logger.debug(`[Image Assistant] Triggered dimension recalculation for all instances | Instance count: ${ImageCaption.instances.size}`);

        ImageCaption.instances.forEach((assistant) => {
            if (assistant && assistant.container && typeof assistant.container.updateDimensions === 'function') {
                assistant.container.updateDimensions();
            }
        });
    }

}

// Create singleton instance
const imageCaption = new ImageCaption();


// Export
export { imageCaption, ImageCaption };
