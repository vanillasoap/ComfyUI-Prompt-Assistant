/**
 * Assistant Settings Service
 * Manages assistant settings options and provides toggle control functionality
 */

import { app } from "../../../../scripts/app.js";
import { logger } from '../utils/logger.js';
import { PromptAssistant } from "./PromptAssistant.js";
import { ImageCaption } from "./imageCaption.js";
import { EventManager } from "../utils/eventManager.js";
import { ResourceManager } from "../utils/resourceManager.js";
import { HistoryCacheService, TagCacheService, TranslateCacheService, CACHE_CONFIG } from "../services/cache.js";
import { UIToolkit } from "../utils/UIToolkit.js";
import { FEATURES, handleFeatureChange } from "../services/features.js";
import { APIService } from "../services/api.js";

import { apiConfigManager } from "./apiConfigManager.js";
import { rulesConfigManager } from "./rulesConfigManager.js";
import {
    createSettingsDialog,
    closeModalWithAnimation,
    createFormGroup,
    createInputGroup,
    createSelectGroup,
    createHorizontalFormGroup,
    createLoadingButton
} from "./uiComponents.js";

// Flag for whether this is the first page load
let isFirstLoad = true;

// ---Service Selector Configuration---
const SERVICE_TYPES = {
    translate: {
        name: 'Translate',
        configEndpoint: '/config/translate',
        serviceType: 'translate',
        filterKey: 'llm_models',
        includeBaidu: true
    },
    llm: {
        name: 'Prompt Enhance',
        configEndpoint: '/config/llm',
        serviceType: 'llm',
        filterKey: 'llm_models',
        includeBaidu: false
    },
    vlm: {
        name: 'Image Caption',
        configEndpoint: '/config/vision',
        serviceType: 'vlm',
        filterKey: 'vlm_models',
        includeBaidu: false
    }
};

// ---Service Selector---
const serviceSelector = {
    _servicesCache: null,
    _cacheTime: 0,
    _cacheDuration: 2000, // Cache for 2 seconds

    /**
     * Clear service cache
     */
    clearCache() {
        this._servicesCache = null;
        this._cacheTime = 0;
        logger.debug('Service list cache cleared');
    },

    // Get service list (with cache)
    async getServices(forceRefresh = false) {
        const now = Date.now();
        if (!forceRefresh && this._servicesCache && (now - this._cacheTime) < this._cacheDuration) {
            return this._servicesCache;
        }

        try {
            const response = await fetch(APIService.getApiUrl('/services'));
            if (response.ok) {
                const data = await response.json();
                if (data.success) {
                    this._servicesCache = data.services || [];
                    this._cacheTime = now;
                    return this._servicesCache;
                }
            }
        } catch (error) {
            logger.error(`Failed to get service list: ${error.message}`);
        }
        return [];
    },

    // Get current service ID for specified type
    async getCurrentService(type) {
        const config = SERVICE_TYPES[type];
        if (!config) return null;

        try {
            const response = await fetch(APIService.getApiUrl(config.configEndpoint));
            if (response.ok) {
                const data = await response.json();
                return data.provider || null;
            }
        } catch (error) {
            logger.error(`Failed to get current ${config.name} service: ${error.message}`);
        }
        return null;
    },

    // Set service for specified type
    async setCurrentService(type, serviceId) {
        const config = SERVICE_TYPES[type];
        if (!config) return false;

        try {
            const response = await fetch(APIService.getApiUrl('/services/current'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    service_type: config.serviceType,
                    service_id: serviceId
                })
            });

            if (response.ok) {
                logger.log(`${config.name} service switched | Service ID: ${serviceId}`);

                // Dispatch global event to notify other components to sync
                window.dispatchEvent(new CustomEvent('pa-service-changed', {
                    detail: { service_type: config.serviceType, service_id: serviceId }
                }));

                return true;
            }
        } catch (error) {
            logger.error(`Failed to switch ${config.name} service: ${error.message}`);
        }
        return false;
    },

    // Get available service options for specified type
    async getServiceOptions(type) {
        const config = SERVICE_TYPES[type];
        if (!config) return [];

        const services = await this.getServices();
        const options = [];

        // Add Baidu Translate option (translate type only)
        if (config.includeBaidu) {
            options.push({ value: 'baidu', text: 'Baidu Translate' });
        }

        // Filter and add other services
        services
            .filter(service => {
                const models = service[config.filterKey];
                return models && models.length > 0;
            })
            .forEach(service => {
                options.push({
                    value: service.id,
                    text: service.name || service.id
                });
            });

        return options;
    }
};

// Mount service selector to global app object for use by other modules (e.g., PromptAssistant.js, imageCaption.js),
// also avoiding circular reference issues between modules.
app.paServiceSelector = serviceSelector;

// ---Version Check Utility Functions---

// Version check state cache
let versionCheckCache = {
    checked: false,        // Whether already checked
    latestVersion: null,   // Latest version number
    hasUpdate: false       // Whether an update is available
};

/**
 * Fetch latest version number from jsDelivr (by reading pyproject.toml)
 * @returns {Promise<string|null>} Returns latest version number like "1.2.3", or null on failure
 */
async function fetchLatestVersion() {
    // If already checked, return cached result directly
    if (versionCheckCache.checked) {
        return versionCheckCache.latestVersion;
    }

    try {
        const response = await fetch('https://cdn.jsdelivr.net/gh/yawiii/ComfyUI-Prompt-Assistant@main/pyproject.toml', {
            cache: 'no-cache'
        });

        if (!response.ok) {
            logger.warn(`[Version Check] Request failed: ${response.status}`);
            versionCheckCache.checked = true;
            return null;
        }

        const tomlContent = await response.text();
        const versionMatch = tomlContent.match(/^version\s*=\s*["']([^"']+)["']/m);
        const version = versionMatch ? versionMatch[1] : null;

        // Cache check result
        versionCheckCache.checked = true;
        versionCheckCache.latestVersion = version;

        return version;
    } catch (error) {
        logger.warn(`[Version Check] Fetch failed: ${error.message}`);
        versionCheckCache.checked = true;
        return null;
    }
}

/**
 * Compare two version numbers
 * @param {string} v1 - First version number
 * @param {string} v2 - Second version number
 * @returns {number} Returns 1 if v1 > v2, -1 if v1 < v2, 0 if v1 === v2
 */
function compareVersion(v1, v2) {
    // Split version numbers into arrays of digits
    const parts1 = v1.split('.').map(n => parseInt(n, 10) || 0);
    const parts2 = v2.split('.').map(n => parseInt(n, 10) || 0);

    // Ensure both arrays have the same length
    const maxLength = Math.max(parts1.length, parts2.length);

    for (let i = 0; i < maxLength; i++) {
        const num1 = parts1[i] || 0;
        const num2 = parts2[i] || 0;

        if (num1 > num2) return 1;
        if (num1 < num2) return -1;
    }

    return 0;
}


// ====================== Settings Management ======================

/**
 * Show API configuration dialog
 */
function showAPIConfigModal() {
    try {
        // Call API config manager's show dialog method
        apiConfigManager.showAPIConfigModal();
    } catch (error) {
        logger.error(`Failed to open API configuration dialog: ${error.message}`);
        app.extensionManager.toast.add({
            severity: "error",
            summary: "Failed to open configuration",
            detail: error.message || "An error occurred while opening the configuration dialog",
            life: 3000
        });
    }
}

/**
 * Show rules configuration dialog
 */
function showRulesConfigModal() {
    try {
        // Call rules config manager's show dialog method
        rulesConfigManager.showRulesConfigModal();
    } catch (error) {
        logger.error(`Failed to open rules configuration dialog: ${error.message}`);
        app.extensionManager.toast.add({
            severity: "error",
            summary: "Failed to open configuration",
            detail: error.message || "An error occurred while opening the configuration dialog",
            life: 3000
        });
    }
}

/**
 * Create service selector dropdown
 * @param {string} type - Service type: 'translate' | 'llm' | 'vlm'
 * @param {string} label - Display name
 * @returns {HTMLElement} Settings row element
 */
function createServiceSelector(type, label) {
    const row = document.createElement("tr");
    row.className = "promptwidget-settings-row";

    const labelCell = document.createElement("td");
    labelCell.className = "comfy-menu-label";
    row.appendChild(labelCell);

    const selectCell = document.createElement("td");

    // Create loading placeholder container
    const container = document.createElement("div");
    container.style.minWidth = "180px";
    container.innerHTML = '<span style="color: var(--p-text-muted-color); font-size: 12px;">Loading...</span>';

    selectCell.appendChild(container);
    row.appendChild(selectCell);

    let currentOptions = []; // Store current options reference
    let updateDropdownOptions = null; // Store update function

    /**
     * Update dropdown content
     * @param {boolean} force - Whether to force refresh data
     */
    const updateContent = async (force = false) => {
        try {
            if (force) {
                // If force refresh (e.g., config change or click trigger), clear cache first
                serviceSelector.clearCache();
            }

            // Get service list and currently selected service
            const [options, currentService] = await Promise.all([
                serviceSelector.getServiceOptions(type),
                serviceSelector.getCurrentService(type)
            ]);

            // If dropdown instance already exists, try incremental update
            if (updateDropdownOptions) {
                updateDropdownOptions(options, currentService);
                currentOptions = options;
                return;
            }

            // ---First load logic---
            container.innerHTML = '';

            if (options.length === 0) {
                container.innerHTML = '<span style="color: var(--p-text-muted-color); font-size: 12px;">No services available</span>';
                return;
            }

            currentOptions = options;
            const res = createSelectGroup(label, options, currentService, { showLabel: false });
            const { group, select } = res;
            updateDropdownOptions = res.updateOptions;

            // Append group's child elements to the container
            while (group.firstChild) {
                container.appendChild(group.firstChild);
            }

            // Listen for click/mousedown events: when user is about to click the dropdown, try to silently sync latest config
            const dropdownContainer = container.querySelector('.pa-dropdown');
            if (dropdownContainer) {
                dropdownContainer.addEventListener('mousedown', () => {
                    // Trigger refresh on click, but don't show "syncing" to avoid UI disruption
                    updateContent(true);
                });
            }

            // Listen for change events
            select.addEventListener('change', async () => {
                const newValue = select.value;
                if (!newValue) return;

                const dropdown = container.querySelector('.pa-dropdown');
                if (dropdown) {
                    dropdown.style.opacity = '0.6';
                    dropdown.style.pointerEvents = 'none';
                }

                try {
                    const success = await serviceSelector.setCurrentService(type, newValue);
                    if (success) {
                        logger.log(`Set ${label} service | Service: ${newValue}`);
                    } else {
                        logger.error(`Failed to set ${label} service`);
                        const oldValue = await serviceSelector.getCurrentService(type);
                        if (oldValue && updateDropdownOptions) {
                            updateDropdownOptions(currentOptions, oldValue);
                        }
                    }
                } catch (error) {
                    logger.error(`Error setting ${label} service: ${error.message}`);
                } finally {
                    if (dropdown) {
                        dropdown.style.opacity = '';
                        dropdown.style.pointerEvents = '';
                    }
                }
            });

        } catch (error) {
            logger.error(`Failed to sync ${label} config: ${error.message}`);
            if (!updateDropdownOptions) {
                container.innerHTML = '<span style="color: var(--p-red-400); font-size: 12px;">Loading failed</span>';
            }
        }
    };

    // Initial load
    updateContent();

    // Listen for config update events (triggered when API config manager modifies config)
    const onConfigUpdated = () => {
        logger.debug(`Received config update notification, syncing ${label} state...`);
        updateContent(true);
    };
    window.addEventListener('pa-config-updated', onConfigUpdated);

    // Cleanup function for destroying listeners (simple handling, as settings panel typically destroyed with page)
    // If more complex component mounting logic is needed later, a cleanup function can be returned here for external use

    return row;
}


/**
 * Register settings options
 * Add settings options to the ComfyUI settings panel
 */
export function registerSettings() {
    try {
        app.registerExtension({
            name: "PromptAssistant.Settings",
            settings: [
                // Master switch - independently controls assistant system-level features
                {
                    id: "PromptAssistant.Features.Enabled",
                    name: "Enable Assistant",
                    category: ["✨Prompt Assistant", "Assistant Feature Toggles", "Master Switch"],
                    type: "boolean",
                    defaultValue: true,
                    tooltip: "When disabled, all Prompt Assistant features will be turned off",
                    onChange: async (value) => {
                        try {
                            // Get current state to determine if this is initialization
                            const currentState = window.FEATURES.enabled;

                            // Only log when state actually changes
                            if (currentState !== value) {
                                logger.log(`Master switch state changed | Status: ${value ? "Enabled" : "Disabled"}`);
                            } else {
                                // If state unchanged, use debug level log
                                logger.debug(`Master switch state unchanged | Status: ${value ? "Enabled" : "Disabled"}`);
                            }

                            // Update global state
                            window.FEATURES.enabled = value;

                            // Get promptAssistant instance from global app object
                            const promptAssistantInstance = app.promptAssistant;
                            const imageCaptionInstance = app.imageCaption;

                            if (!promptAssistantInstance) {
                                logger.error("Master switch toggle failed | Error: PromptAssistant instance not found");
                                return;
                            }

                            // Execute corresponding operations based on switch state
                            if (value) {
                                // Enable features
                                await promptAssistantInstance.toggleGlobalFeature(true, currentState !== value);
                                if (imageCaptionInstance) {
                                    await imageCaptionInstance.toggleGlobalFeature(true, currentState !== value);
                                }

                                // Only log and show toast when state actually changes and not first load
                                if (currentState !== value) {
                                    logger.debug("Features enabled successfully");
                                    // Only show toast when state changes and not first load
                                    if (!isFirstLoad) {
                                        app.extensionManager.toast.add({
                                            severity: "info",
                                            summary: "Prompt Assistant enabled",
                                            life: 3000
                                        });
                                    }
                                }
                            } else {
                                // Disable features
                                await promptAssistantInstance.toggleGlobalFeature(false, currentState !== value);
                                if (imageCaptionInstance) {
                                    await imageCaptionInstance.toggleGlobalFeature(false, currentState !== value);
                                }

                                // Only log and show toast when state actually changes and not first load
                                if (currentState !== value) {
                                    logger.debug("Features disabled successfully");
                                    // Only show toast when state changes and not first load
                                    if (!isFirstLoad) {
                                        app.extensionManager.toast.add({
                                            severity: "warn",
                                            summary: "Prompt Assistant disabled",
                                            life: 3000
                                        });
                                    }
                                }
                            }

                            // Set first load flag to false, indicating first load is complete
                            isFirstLoad = false;
                        } catch (error) {
                            logger.error(`Master switch toggle error | Error: ${error.message}`);
                        }
                    }
                },

                // Assistant creation mode setting
                {
                    id: "PromptAssistant.Settings.CreationMode",
                    name: "Assistant Creation Mode (Prompt)",
                    category: ["✨Prompt Assistant", "System", "Prompt Assistant Creation Mode"],
                    type: "combo",
                    options: [
                        { text: "Auto Create", value: "auto" },
                        { text: "Create on Node Select", value: "manual" }
                    ],
                    defaultValue: "auto",
                    tooltip: "Auto Create: automatically show assistant when node is created or loaded; Create on Node Select: only show when node is selected",
                    onChange: (value) => {
                        logger.log(`Assistant creation mode changed | Mode: ${value === 'auto' ? 'Auto Create' : 'Create on Node Select'}`);
                        // If switching to auto create, immediately try to initialize all nodes
                        if (value === 'auto' && window.FEATURES.enabled && app.graph) {
                            const nodes = app.graph._nodes || [];
                            nodes.forEach(node => {
                                if (node && !node._promptAssistantInitialized) {
                                    app.promptAssistant.checkAndSetupNode(node);
                                }
                            });
                        }
                    }
                },

                // Image Caption assistant creation mode setting
                {
                    id: "PromptAssistant.Settings.ImageCaptionCreationMode",
                    name: "Assistant Creation Mode (Image Caption)",
                    category: ["✨Prompt Assistant", "System", "Image Assistant Creation Mode"],
                    type: "combo",
                    options: [
                        { text: "Auto Create", value: "auto" },
                        { text: "Create on Node Select", value: "manual" }
                    ],
                    defaultValue: "auto",
                    tooltip: "Auto Create: automatically show Image Caption assistant when node is created or loaded; Create on Node Select: only show when node is selected",
                    onChange: (value) => {
                        logger.log(`Image Caption assistant creation mode changed | Mode: ${value === 'auto' ? 'Auto Create' : 'Create on Node Select'}`);
                        // If switching to auto create, immediately try to initialize all nodes
                        if (value === 'auto' && window.FEATURES.enabled && window.FEATURES.imageCaption && app.graph) {
                            const nodes = app.graph._nodes || [];
                            nodes.forEach(node => {
                                if (node && !node._imageCaptionInitialized) {
                                    app.imageCaption.checkAndSetupNode(node);
                                }
                            });
                        }
                    }
                },

                // Assistant layout (Prompt)
                {
                    id: "PromptAssistant.Location",
                    name: "Assistant Layout (Prompt)",
                    category: ["✨Prompt Assistant", "Interface", "Prompt Assistant Layout"],
                    type: "combo",
                    options: [
                        // { text: "Top Left (Horizontal)", value: "top-left-h" },
                        // { text: "Top Left (Vertical)", value: "top-left-v" },
                        // { text: "Top Center (Horizontal)", value: "top-center-h" },
                        // { text: "⇗ ━", value: "top-right-h" },
                        // { text: "⇗ ┃", value: "top-right-v" },
                        { text: "Right Center (Vertical)", value: "right-center-v" },
                        { text: "Bottom Right (Horizontal)", value: "bottom-right-h" },
                        { text: "Bottom Right (Vertical)", value: "bottom-right-v" },
                        { text: "Bottom Center (Horizontal)", value: "bottom-center-h" },
                        { text: "Bottom Left (Horizontal)", value: "bottom-left-h" },
                        // { text: "Bottom Left (Vertical)", value: "bottom-left-v" },
                        // { text: "Left Center (Vertical)", value: "left-center-v" }
                    ],
                    defaultValue: "bottom-right-h", // Default bottom-right horizontal
                    tooltip: "Set the layout and expansion direction of the Prompt Assistant around the input box",
                    onChange: (value) => {
                        logger.log(`Prompt Assistant layout changed | Layout: ${value}`);
                        // Notify all instances to update layout (handled via CSS classes)
                        PromptAssistant.instances.forEach(widget => {
                            if (widget.container && widget.container.setAnchorPosition) {
                                widget.container.setAnchorPosition(value);
                            }
                        });
                    }
                },
                // Assistant position setting (Image Caption)
                {
                    id: "ImageCaption.Location",
                    name: "Assistant Layout (Image Caption)",
                    category: ["✨Prompt Assistant", "Interface", "Image Assistant Layout"],
                    type: "combo",
                    options: [
                        { text: "Horizontal", value: "bottom-left-h" },
                        { text: "Vertical", value: "bottom-left-v" }
                    ],
                    defaultValue: "bottom-left-h", // Default horizontal
                    tooltip: "Set the expansion direction of the Image Caption assistant (position fixed at bottom-left)",
                    onChange: (value) => {
                        logger.log(`Image Caption assistant layout changed | Layout: ${value}`);
                        // Notify all instances to update layout
                        ImageCaption.instances.forEach(assistant => {
                            if (assistant.container && assistant.container.setAnchorPosition) {
                                assistant.container.setAnchorPosition(value);
                            }
                        });
                    },
                },

                // API configuration button
                {
                    id: "PromptAssistant.Features.APIConfig",
                    name: "Baidu and LLM API Configuration",
                    category: ["✨Prompt Assistant", " Configuration", "API Configuration"],
                    tooltip: "Configure or modify API information",
                    type: () => {
                        const row = document.createElement("tr");
                        row.className = "promptwidget-settings-row";

                        const labelCell = document.createElement("td");
                        labelCell.className = "comfy-menu-label";
                        row.appendChild(labelCell);

                        const buttonCell = document.createElement("td");
                        const button = createLoadingButton("API Manager", async () => {
                            showAPIConfigModal();
                        }, false); // Set showSuccessToast to false

                        buttonCell.appendChild(button);
                        row.appendChild(buttonCell);
                        return row;
                    }
                },

                // ---Service category settings---
                // Translate service selection
                {
                    id: "PromptAssistant.Service.Translate",
                    name: "Select Translate Service",
                    category: ["✨Prompt Assistant", " Configuration", "Translate"],
                    tooltip: "Select a service provider for translation; you can also switch by right-clicking the Translate button",
                    type: () => {
                        return createServiceSelector('translate', 'Translate');
                    }
                },

                // Prompt Enhance service selection
                {
                    id: "PromptAssistant.Service.LLM",
                    name: "Select Prompt Enhance Service",
                    category: ["✨Prompt Assistant", " Configuration", "Prompt Enhance"],
                    tooltip: "Select a service provider for prompt enhancement; you can also switch by right-clicking the Enhance button",
                    type: () => {
                        return createServiceSelector('llm', 'Prompt Enhance');
                    }
                },

                // Image Caption service selection
                {
                    id: "PromptAssistant.Service.VLM",
                    name: "Select Image Caption Service",
                    category: ["✨Prompt Assistant", " Configuration", "Image Caption"],
                    tooltip: "Select a service provider for image captioning; you can also switch by right-clicking the Caption button",
                    type: () => {
                        return createServiceSelector('vlm', 'Image Caption');
                    }
                },

                // History feature (includes history, undo, redo buttons)
                {
                    id: "PromptAssistant.Features.History",
                    name: "Enable History Feature",
                    category: ["✨Prompt Assistant", "Assistant Feature Toggles", "History Feature"],
                    type: "boolean",
                    defaultValue: true,
                    tooltip: "Enable or disable history, undo, and redo features",
                    onChange: (value) => {
                        const oldValue = FEATURES.history;
                        FEATURES.history = value;
                        handleFeatureChange('History Feature', value, oldValue);
                        logger.log(`History Feature - ${value ? "Enabled" : "Disabled"}`);
                    }
                },

                // Tags tool
                {
                    id: "PromptAssistant.Features.Tag",
                    name: "Enable Tags Tool",
                    category: ["✨Prompt Assistant", "Assistant Feature Toggles", "Tags Feature"],
                    type: "boolean",
                    defaultValue: true,
                    tooltip: "Enable or disable the tags tool feature",
                    onChange: (value) => {
                        const oldValue = FEATURES.tag;
                        FEATURES.tag = value;
                        handleFeatureChange('Tags Tool', value, oldValue);
                        logger.log(`Tags Tool - ${value ? "Enabled" : "Disabled"}`);
                    }
                },

                // Enhance feature
                {
                    id: "PromptAssistant.Features.Expand",
                    name: "Enable Prompt Enhance Feature",
                    category: ["✨Prompt Assistant", "Assistant Feature Toggles", "Prompt Enhance Feature"],
                    type: "boolean",
                    defaultValue: true,
                    tooltip: "Enable or disable the prompt enhance feature",
                    onChange: (value) => {
                        const oldValue = FEATURES.expand;
                        FEATURES.expand = value;
                        handleFeatureChange('Prompt Enhance Feature', value, oldValue);
                        logger.log(`Prompt Enhance Feature - ${value ? "Enabled" : "Disabled"}`);
                    }
                },

                // Translate feature
                {
                    id: "PromptAssistant.Features.Translate",
                    name: "Enable Translate Feature",
                    category: ["✨Prompt Assistant", "Assistant Feature Toggles", "Translate Feature"],
                    type: "boolean",
                    defaultValue: true,
                    tooltip: "Enable or disable the translate feature",
                    onChange: (value) => {
                        const oldValue = FEATURES.translate;
                        FEATURES.translate = value;
                        handleFeatureChange('Translate Feature', value, oldValue);
                        logger.log(`Translate Feature - ${value ? "Enabled" : "Disabled"}`);
                    }
                },

                // Use translate cache feature
                {
                    id: "PromptAssistant.Features.UseTranslateCache",
                    name: "Use Translate Cache",
                    category: ["✨Prompt Assistant", " Translate Settings", "Translate Cache"],
                    type: "boolean",
                    defaultValue: true,
                    tooltip: "When enabled, previously translated content will use cached results to avoid re-translating identical content. To force re-translation, simply add a space to bypass the cache.",
                    onChange: (value) => {
                        const oldValue = FEATURES.useTranslateCache;
                        FEATURES.useTranslateCache = value;
                        logger.log(`Translate Cache - ${value ? "Enabled" : "Disabled"}`);
                    }
                },

                // Mixed language cache option
                {
                    id: "PromptAssistant.Features.CacheMixedLangTranslation",
                    name: "Cache Mixed Language Translations",
                    category: ["✨Prompt Assistant", " Translate Settings", "Mixed Language Cache"],
                    type: "boolean",
                    defaultValue: false,
                    tooltip: "When disabled, translation results of mixed Chinese-English content will not be written to cache, avoiding cache pollution. When enabled, caching works normally.",
                    onChange: (value) => {
                        FEATURES.cacheMixedLangTranslation = value;
                        logger.log(`Mixed Language Cache - ${value ? "Enabled" : "Disabled"}`);
                    }
                },

                // Mixed language translation rules
                {
                    id: "PromptAssistant.Features.MixedLangTranslateRule",
                    name: "Mixed Language Translation Rules",
                    category: ["✨Prompt Assistant", " Translate Settings", "Mixed Language Rules"],
                    type: "combo",
                    options: [
                        { text: "Translate to English", value: "to_en" },
                        { text: "Translate to Chinese", value: "to_zh" },
                        { text: "Auto-translate minority language", value: "auto_minor" },
                        { text: "Auto-translate majority language", value: "auto_major" }
                    ],
                    defaultValue: "to_en",
                    tooltip: "Set translation rules for mixed Chinese-English content based on personal preference",
                    onChange: (value) => {
                        FEATURES.mixedLangTranslateRule = value;
                        logger.log(`Mixed Language Translation Rules - set to: ${value}`);
                    }
                },

                // Translation formatting options
                {
                    id: "PromptAssistant.Features.TranslateFormatPunctuation",
                    name: "Always Use Half-width Punctuation",
                    category: ["✨Prompt Assistant", " Translate Settings", "Punctuation Handling"],
                    type: "boolean",
                    defaultValue: false,
                    tooltip: "When enabled, translation results will automatically replace Chinese punctuation with English punctuation",
                    onChange: (value) => {
                        FEATURES.translateFormatPunctuation = value;
                        logger.log(`Punctuation Conversion - ${value ? "Enabled" : "Disabled"}`);
                    }
                },
                {
                    id: "PromptAssistant.Features.TranslateFormatSpace",
                    name: "Auto-remove Extra Spaces",
                    category: ["✨Prompt Assistant", " Translate Settings", "Space Handling"],
                    type: "boolean",
                    defaultValue: false,
                    tooltip: "When enabled, translation results will automatically remove extra spaces",
                    onChange: (value) => {
                        FEATURES.translateFormatSpace = value;
                        logger.log(`Remove Extra Spaces - ${value ? "Enabled" : "Disabled"}`);
                    }
                },
                {
                    id: "PromptAssistant.Features.TranslateFormatDots",
                    name: "Remove Redundant Consecutive Dots",
                    category: ["✨Prompt Assistant", " Translate Settings", "Dots Handling"],
                    type: "boolean",
                    defaultValue: false,
                    tooltip: "When enabled, translation results will normalize excessive '......' to '...'",
                    onChange: (value) => {
                        FEATURES.translateFormatDots = value;
                        logger.log(`Handle Consecutive Dots - ${value ? "Enabled" : "Disabled"}`);
                    }
                },
                {
                    id: "PromptAssistant.Features.TranslateFormatNewline",
                    name: "Preserve Line Breaks",
                    category: ["✨Prompt Assistant", " Translate Settings", "Line Break Handling"],
                    type: "boolean",
                    defaultValue: true,
                    tooltip: "When enabled, translation results will try to maintain the original line breaks, avoiding loss of paragraph structure after translation",
                    onChange: (value) => {
                        FEATURES.translateFormatNewline = value;
                        logger.log(`Preserve Line Breaks - ${value ? "Enabled" : "Disabled"}`);
                    }
                },



                // Image Caption feature
                {
                    id: "PromptAssistant.Features.ImageCaption",
                    name: "Enable Image Caption Feature",
                    category: ["✨Prompt Assistant", "Assistant Feature Toggles", "Image Caption"],
                    type: "boolean",
                    defaultValue: true,
                    tooltip: "Enable or disable the image caption prompt feature",
                    onChange: (value) => {
                        const oldValue = FEATURES.imageCaption;
                        FEATURES.imageCaption = value;
                        handleFeatureChange('Image Caption', value, oldValue);
                        logger.log(`Image Caption Feature - ${value ? "Enabled" : "Disabled"}`);
                    }
                },

                // Node help translation feature
                {
                    id: "PromptAssistant.Features.NodeHelpTranslator",
                    name: "Enable Node Info Translation",
                    category: ["✨Prompt Assistant", "Assistant Feature Toggles", "Node Info Translation"],
                    type: "boolean",
                    defaultValue: true,
                    tooltip: "Enable or disable translation of ComfyUI sidebar node help documentation",
                    onChange: (value) => {
                        const oldValue = FEATURES.nodeHelpTranslator;
                        FEATURES.nodeHelpTranslator = value;
                        handleFeatureChange('Node Info Translation', value, oldValue);
                        logger.log(`Node Info Translation Feature - ${value ? "Enabled" : "Disabled"}`);
                    }
                },

                // System settings
                {
                    id: "PromptAssistant.Settings.LogLevel",
                    name: "Log Level",
                    category: ["✨Prompt Assistant", "System", "Log Level"],
                    type: "hidden",
                    defaultValue: "0",
                    options: [
                        { text: "Error Logs", value: "0" },
                        { text: "Basic Logs", value: "1" },
                        { text: "Verbose Logs", value: "2" }
                    ],
                    tooltip: "Set log output level: Error Logs (errors only), Basic Logs (errors + basic info), Verbose Logs (errors + basic info + debug info)",
                    onChange: (value) => {
                        const oldValue = window.FEATURES.logLevel;
                        window.FEATURES.logLevel = parseInt(value);
                        logger.setLevel(window.FEATURES.logLevel);
                        logger.log(`Log level updated | Previous: ${oldValue} | New: ${value}`);
                    }
                },

                // Show streaming output progress
                {
                    id: "PromptAssistant.Settings.ShowStreamingProgress",
                    name: "Console Streaming Progress Logs",
                    category: ["✨Prompt Assistant", "System", "Terminal Logs"],
                    type: "boolean",
                    defaultValue: false,
                    tooltip: "When enabled, the console will show streaming output progress, which may cause screen flooding on some terminals; when disabled, only shows a static 'Generating...' message.",
                    onChange: async (value) => {
                        FEATURES.showStreamingProgress = value;
                        // Notify backend to update settings
                        try {
                            await fetch(APIService.getApiUrl('/settings/streaming_progress'), {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ enabled: value })
                            });
                        } catch (error) {
                            logger.error(`Failed to update streaming progress setting: ${error.message}`);
                        }
                        logger.log(`Streaming Progress - ${value ? "Enabled" : "Disabled"}`);
                    }
                },

                // Streaming output toggle
                {
                    id: "PromptAssistant.Settings.EnableStreaming",
                    name: "Streaming Output Toggle",
                    category: ["✨Prompt Assistant", "System", "Streaming Experience"],
                    type: "boolean",
                    defaultValue: true,
                    tooltip: "When enabled, translate, enhance, caption and other features will display with streaming character-by-character generation effect; when disabled, results will be displayed all at once after full generation.",
                    onChange: (value) => {
                        FEATURES.enableStreaming = value;
                        logger.log(`Streaming Output Toggle - ${value ? "Enabled" : "Disabled"}`);
                    }
                },

                {
                    id: "PromptAssistant.Settings.IconOpacity",
                    name: " Assistant Icon Opacity",
                    category: ["✨Prompt Assistant", "Interface", "Assistant Icon"],
                    type: "slider",
                    min: 0,
                    max: 100,
                    step: 1,
                    defaultValue: 20,
                    tooltip: "Set the opacity of the collapsed assistant icon",
                    onChange: (value) => {
                        // Convert 0-100 value to 0-1 opacity
                        const opacity = value * 0.01;
                        document.documentElement.style.setProperty('--assistant-icon-opacity', opacity);
                        logger.log(`Assistant icon opacity updated | Value: ${value}% | Opacity: ${opacity}`);
                    },
                    onLoad: (value) => {
                        // Apply default value on initialization
                        const opacity = value * 0.01;
                        document.documentElement.style.setProperty('--assistant-icon-opacity', opacity);
                        logger.debug(`Assistant icon opacity initialized | Value: ${value}% | Opacity: ${opacity}`);
                    }
                },

                {
                    id: "PromptAssistant.Settings.ClearCache",
                    name: "Clear History, Tags, and Translate Cache",
                    category: ["✨Prompt Assistant", "System", "Clear Cache"],
                    tooltip: "Clear all caches including history records, tags, translate cache, and node documentation translate cache",
                    type: () => {
                        const row = document.createElement("tr");
                        row.className = "promptwidget-settings-row";

                        const labelCell = document.createElement("td");
                        labelCell.className = "comfy-menu-label";
                        row.appendChild(labelCell);

                        const buttonCell = document.createElement("td");
                        const button = createLoadingButton("Clear All Cache", async () => {
                            try {
                                // Get cache stats before clearing
                                const beforeStats = {
                                    history: HistoryCacheService.getHistoryStats(),
                                    tags: 0,
                                    translate: TranslateCacheService.getTranslateCacheStats(),
                                    nodeHelpTranslate: 0 // Node documentation translate cache
                                };

                                // Count all tags
                                const tagCacheKeys = Object.keys(localStorage)
                                    .filter(key => key.startsWith(CACHE_CONFIG.TAG_KEY_PREFIX));

                                // Calculate total tag count across all caches
                                tagCacheKeys.forEach(key => {
                                    try {
                                        const cacheData = JSON.parse(localStorage.getItem(key));
                                        if (cacheData && typeof cacheData === 'object') {
                                            // Get tag count in cache
                                            const tagCount = Object.keys(cacheData).length;
                                            beforeStats.tags += tagCount;
                                        }
                                    } catch (e) {
                                        // Remove error log, silently handle parse errors
                                    }
                                });

                                // Count node documentation translate cache entries
                                try {
                                    const nodeHelpCache = sessionStorage.getItem('pa_node_help_translations');
                                    if (nodeHelpCache) {
                                        const parsed = JSON.parse(nodeHelpCache);
                                        beforeStats.nodeHelpTranslate = Object.keys(parsed).length;
                                    }
                                } catch (e) {
                                    // Silent handling
                                }

                                // Execute history clearing operation
                                HistoryCacheService.clearAllHistory();

                                // Clear all tag caches
                                TagCacheService.clearAllTagCache();

                                // Clear translate cache
                                TranslateCacheService.clearAllTranslateCache();

                                // Clear node documentation translate cache (sessionStorage)
                                sessionStorage.removeItem('pa_node_help_translations');

                                // Clear legacy tag caches (all records starting with PromptAssistant_tag_cache_)
                                Object.keys(localStorage)
                                    .filter(key => key.startsWith('PromptAssistant_tag_cache_'))
                                    .forEach(key => localStorage.removeItem(key));

                                // Clear three legacy config entries from versions before 1.0.3 to prevent leakage
                                localStorage.removeItem("PromptAssistant_Settings_llm_api_key");
                                localStorage.removeItem("PromptAssistant_Settings_baidu_translate_secret");
                                localStorage.removeItem("PromptAssistant_Settings_baidu_translate_appid");

                                // Get cache stats after clearing
                                const afterStats = {
                                    history: HistoryCacheService.getHistoryStats(),
                                    tags: 0, // Tag count should be 0 after clearing
                                    translate: TranslateCacheService.getTranslateCacheStats()
                                };

                                // Calculate cleared counts
                                const clearedHistory = beforeStats.history.total - afterStats.history.total;
                                const clearedTags = beforeStats.tags;
                                const clearedTranslate = beforeStats.translate.total - afterStats.translate.total;
                                const clearedNodeHelp = beforeStats.nodeHelpTranslate;

                                // Output only final statistics
                                logger.log(`Cache clearing complete | History: ${clearedHistory} entries | Tags: ${clearedTags} items | Translations: ${clearedTranslate} entries | Node docs: ${clearedNodeHelp} items`);

                                // Update undo/redo button state for all instances
                                PromptAssistant.instances.forEach((instance) => {
                                    if (instance && instance.nodeId && instance.inputId) {
                                        UIToolkit.updateUndoRedoButtonState(instance, HistoryCacheService);
                                    }
                                });

                            } catch (error) {
                                // Simplified error log
                                logger.error(`Cache clearing failed`);
                                throw error;
                            }
                        });

                        buttonCell.appendChild(button);
                        row.appendChild(buttonCell);
                        return row;
                    }
                },



                // About plugin info
                {
                    id: "PromptAssistant.Settings.About",
                    name: "About",
                    category: ["✨Prompt Assistant", " ✨Prompt Assistant"],
                    type: () => {
                        const row = document.createElement("tr");
                        row.className = "promptwidget-settings-row";
                        const cell = document.createElement("td");
                        cell.colSpan = 2;
                        cell.style.display = "flex";
                        cell.style.alignItems = "center";
                        cell.style.gap = "12px";
                        // Version badge container (entire area clickable to navigate to latest release)
                        const versionLink = document.createElement("a");
                        versionLink.href = "https://github.com/yawiii/comfyui_prompt_assistant/releases/latest";
                        versionLink.target = "_blank";
                        versionLink.style.textDecoration = "none";
                        versionLink.style.display = "flex";
                        versionLink.style.alignItems = "center";
                        versionLink.style.cursor = "pointer";

                        const versionContainer = document.createElement("div");
                        versionContainer.style.display = "flex";
                        versionContainer.style.alignItems = "center";
                        versionContainer.style.gap = "8px";
                        versionLink.appendChild(versionContainer);

                        // Version badge
                        const versionBadge = document.createElement("img");
                        versionBadge.alt = "Version";
                        versionBadge.style.display = "block";
                        versionBadge.style.height = "20px";

                        // Get version number from global variable
                        if (!window.PromptAssistant_Version) {
                            logger.error("Version number not found, badge will not display correctly");
                            versionBadge.src = `https://img.shields.io/badge/%E7%89%88%E6%9C%AC-%E6%9C%AA%E7%9F%A5-red?style=flat`;
                            versionContainer.appendChild(versionBadge);
                        } else {
                            const currentVersion = window.PromptAssistant_Version;
                            versionBadge.src = `https://img.shields.io/badge/%E7%89%88%E6%9C%AC-${currentVersion}-green?style=flat`;
                            versionContainer.appendChild(versionBadge);

                            // Use cache to check version, avoid repeated requests
                            if (versionCheckCache.checked && versionCheckCache.hasUpdate) {
                                // Already checked and update available, apply cached result directly
                                const latestVersion = versionCheckCache.latestVersion;
                                const labelEncoded = encodeURIComponent("New Version");
                                const messageEncoded = encodeURIComponent(`${currentVersion}→${latestVersion}`);
                                versionBadge.src = `https://img.shields.io/badge/${labelEncoded}-${messageEncoded}-orange?style=flat&labelColor=555555`;
                                versionBadge.style.cursor = "pointer";
                                versionBadge.title = `Current version: ${currentVersion}\nLatest version: ${latestVersion}\nClick to download`;
                            } else if (!versionCheckCache.checked) {
                                // First check, initiate async request
                                fetchLatestVersion().then(latestVersion => {
                                    if (latestVersion && compareVersion(latestVersion, currentVersion) > 0) {
                                        versionCheckCache.hasUpdate = true;
                                        const labelEncoded = encodeURIComponent("New Version");
                                        const messageEncoded = encodeURIComponent(`${currentVersion}→${latestVersion}`);
                                        versionBadge.src = `https://img.shields.io/badge/${labelEncoded}-${messageEncoded}-orange?style=flat&labelColor=555555`;
                                        versionBadge.style.cursor = "pointer";
                                        versionBadge.title = `Current version: ${currentVersion}\nLatest version: ${latestVersion}\nClick to download`;
                                        logger.log(`[Version Check] New version found: ${currentVersion} → ${latestVersion}`);
                                    } else if (latestVersion) {
                                        versionBadge.title = `Already on latest version: ${currentVersion}`;
                                        logger.debug(`[Version Check] Current version: ${currentVersion}`);
                                    }
                                }).catch(error => {
                                    logger.warn(`[Version Check] Error: ${error.message}`);
                                });
                            } else {
                                // Already checked but no update
                                versionBadge.title = `Already on latest version: ${currentVersion}`;
                            }
                        }

                        cell.appendChild(versionLink);

                        // GitHub badge
                        const authorTag = document.createElement("a");
                        authorTag.href = "https://github.com/yawiii/comfyui_prompt_assistant";
                        authorTag.target = "_blank";
                        authorTag.style.textDecoration = "none";
                        authorTag.style.display = "flex";
                        authorTag.style.alignItems = "center";
                        const authorBadge = document.createElement("img");
                        authorBadge.alt = "Static Badge";
                        authorBadge.src = "https://img.shields.io/github/stars/yawiii/comfyui_prompt_assistant?style=flat&logo=github&logoColor=%23292F34&label=Yawiii&labelColor=%23FFFFFF&color=blue";
                        authorBadge.style.display = "block";
                        authorBadge.style.height = "20px";
                        authorTag.appendChild(authorBadge);
                        cell.appendChild(authorTag);

                        // B站徽标
                        const biliTag = document.createElement("a");
                        biliTag.href = "https://space.bilibili.com/520680644";
                        biliTag.target = "_blank";
                        biliTag.style.textDecoration = "none";
                        biliTag.style.display = "flex";
                        biliTag.style.alignItems = "center";
                        const biliBadge = document.createElement("img");
                        biliBadge.alt = "Bilibili";
                        biliBadge.src = "https://img.shields.io/badge/%E4%BD%BF%E7%94%A8%E6%95%99%E7%A8%8B-blue?style=flat&logo=bilibili&logoColor=2300A5DC&labelColor=%23FFFFFF&color=%2307A3D7";
                        biliBadge.style.display = "block";
                        biliBadge.style.height = "20px";
                        biliTag.appendChild(biliBadge);
                        cell.appendChild(biliTag);
                        // 交流群徽标
                        const wechatTag = document.createElement("a");
                        // 取消跳转；点击不再打开链接，避免本地缓存链接
                        wechatTag.href = 'javascript:void(0)';
                        wechatTag.addEventListener('click', (e) => { e.preventDefault(); toggleWechatQr(); });
                        wechatTag.style.textDecoration = "none";
                        wechatTag.style.display = "flex";
                        wechatTag.style.alignItems = "center";
                        wechatTag.classList.add("has-tooltip", "pa-wechat-badge");
                        const wechatBadge = document.createElement("img");
                        wechatBadge.alt = "交流反馈群";
                        wechatBadge.src = "https://img.shields.io/badge/%E4%BA%A4%E6%B5%81%E5%8F%8D%E9%A6%88-blue?logo=wechat&logoColor=green&labelColor=%23FFFFFF&color=%2307A3D7";
                        wechatBadge.style.display = "block";
                        wechatBadge.style.height = "20px";
                        wechatTag.appendChild(wechatBadge);

                        // 悬浮显示二维码
                        const wechatQr = document.createElement("div");
                        wechatQr.className = "pa-wechat-qr";
                        const wechatQrImg = document.createElement("img");
                        // 优先加载远程二维码，失败则回退到本地备用图
                        const remoteQrUrl = 'http://data.xflow.cc/wechat.png';
                        let qrFallbackTimer = null;
                        const localQrUrl = ResourceManager.getAssetUrl('wechat.png');

                        // 每次显示时强制重新加载远程二维码（带时间戳），避免缓存
                        const loadWechatQr = () => {
                            if (qrFallbackTimer) { clearTimeout(qrFallbackTimer); qrFallbackTimer = null; }
                            wechatQrImg.dataset.fallbackApplied = '';
                            wechatQrImg.dataset.source = 'remote';
                            wechatQrImg.src = `${remoteQrUrl}?t=${Date.now()}`;
                            // 超时回退到本地，但需要判断图片是否已开始加载
                            qrFallbackTimer = setTimeout(() => {
                                // 检查是否已标记为已回退
                                if (wechatQrImg.dataset.fallbackApplied === '1') return;

                                // 检查图片是否已开始加载（naturalHeight > 0 说明图片正在加载）
                                if (wechatQrImg.naturalHeight > 0) {
                                    Logger.log(2, '远程二维码加载中，延长等待时间');
                                    // 图片已开始加载，继续等待 onload，取消超时回退
                                    if (qrFallbackTimer) { clearTimeout(qrFallbackTimer); qrFallbackTimer = null; }
                                } else {
                                    // 图片未开始加载，可能是网络问题，回退到本地
                                    Logger.log(1, '远程二维码加载超时，切换到本地备用图');
                                    loadLocalQr();
                                }
                            }, 3000); // 延长到 3 秒，给远程图片更多加载时间
                        };
                        // 手动切换到本地二维码（带时间戳），清理超时
                        const loadLocalQr = () => {
                            if (qrFallbackTimer) { clearTimeout(qrFallbackTimer); qrFallbackTimer = null; }
                            wechatQrImg.dataset.fallbackApplied = '1';
                            wechatQrImg.dataset.source = 'local';
                            wechatQrImg.src = localQrUrl; // 本地图片固定，不加时间戳
                        };

                        // 点击徽标时在远程/本地之间来回切换
                        const toggleWechatQr = () => {
                            if (wechatQrImg.dataset.source === 'local') {
                                loadWechatQr();
                            } else {
                                loadLocalQr();
                            }
                        };


                        wechatQrImg.alt = "微信交流群二维码";
                        wechatQrImg.className = "pa-wechat-qr-img";

                        // 加载成功清理超时定时器
                        wechatQrImg.onload = () => { if (qrFallbackTimer) { clearTimeout(qrFallbackTimer); qrFallbackTimer = null; } };

                        // 远程加载失败时回退到本地备用图（也带时间戳避免缓存）
                        wechatQrImg.onerror = () => {
                            if (qrFallbackTimer) { clearTimeout(qrFallbackTimer); qrFallbackTimer = null; }
                            if (wechatQrImg.dataset.fallbackApplied !== '1') {
                                loadLocalQr();
                            }
                        };

                        // 初次渲染和每次鼠标进入都触发重新加载
                        loadWechatQr();
                        wechatTag.addEventListener('mouseenter', loadWechatQr);

                        wechatQr.appendChild(wechatQrImg);
                        wechatTag.appendChild(wechatQr);

                        cell.appendChild(wechatTag);

                        row.appendChild(cell);
                        return row;
                    }
                },

                // 规则配置按钮
                {
                    id: "PromptAssistant.Features.RulesConfig",
                    name: "提示词优化和反推规则修改",
                    category: ["✨提示词小助手", " 配置", "规则"],
                    tooltip: "可以自定义提示词优化规则，和反推提示词规则，使得提示词生成更加符合你的需求",
                    type: () => {
                        const row = document.createElement("tr");
                        row.className = "promptwidget-settings-row";

                        const labelCell = document.createElement("td");
                        labelCell.className = "comfy-menu-label";
                        row.appendChild(labelCell);

                        const buttonCell = document.createElement("td");
                        const button = createLoadingButton("规则管理器", async () => {
                            showRulesConfigModal();
                        }, false);

                        buttonCell.appendChild(button);
                        row.appendChild(buttonCell);
                        return row;
                    }
                },

            ]
        });

        logger.log("小助手设置注册成功");
        return true;
    } catch (error) {
        logger.error(`小助手设置注册失败: ${error.message}`);
        return false;
    }
}