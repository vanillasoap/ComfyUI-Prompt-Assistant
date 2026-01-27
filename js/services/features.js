/**
 * Assistant feature management module
 * Manages all feature toggles, button visibility, feature state changes, etc.
 */

import { logger } from '../utils/logger.js';

// Externally injected promptAssistant instance
let promptAssistant = null;
// Externally injected PromptAssistant class
let PromptAssistant = null;
// Externally injected UIToolkit
let UIToolkit = null;
// Externally injected HistoryCacheService
let HistoryCacheService = null;
// Externally injected imageCaption instance
let imageCaption = null;
// Externally injected ImageCaption class
let ImageCaption = null;
// Externally injected nodeHelpTranslator instance
let nodeHelpTranslator = null;

/**
 * Inject dependency instances (called by main entry)
 */
export function setFeatureModuleDeps({ promptAssistant: pa, PromptAssistant: PAC, UIToolkit: ui, HistoryCacheService: hc, imageCaption: ic, ImageCaption: ICC, nodeHelpTranslator: nht }) {
    promptAssistant = pa;
    PromptAssistant = PAC;
    UIToolkit = ui;
    HistoryCacheService = hc;
    imageCaption = ic;
    ImageCaption = ICC;
    nodeHelpTranslator = nht;
    // Sync log level during initialization
    try {
        if (typeof window !== 'undefined' && window.FEATURES) {
            if (typeof window.FEATURES.logLevel === 'undefined') {
                window.FEATURES.logLevel = 0;
            }
            if (typeof logger.setLevel === 'function') {
                logger.setLevel(window.FEATURES.logLevel);
            }
        }
    } catch (e) { }
}

/**
 * Feature configuration object
 * Controls the enabled state of each feature
 */
export const FEATURES = {
    // Basic feature toggles
    enabled: true,

    // Specific feature toggles
    history: true, // History feature (includes history, undo, redo)
    tag: true,
    expand: true,
    translate: true,
    autoTranslate: false, // Auto-translate feature
    imageCaption: true, // Image caption (reverse prompt) feature
    nodeHelpTranslator: true, // Node help document translation feature

    // Translation formatting options
    translateFormatPunctuation: true, // Auto-convert punctuation to half-width
    translateFormatSpace: true, // Remove extra spaces
    translateFormatDots: false, // Handle consecutive dots
    translateFormatNewline: false, // Preserve newlines

    // Mixed-language translation cache
    cacheMixedLangTranslation: false, // Whether to cache mixed-language translation results

    // Mixed-language translation rules
    mixedLangTranslateRule: 'auto_minor', // Auto-translate minor-proportion language

    // System settings
    showStreamingProgress: true, // Show streaming output progress (terminal log)
    enableStreaming: true, // Enable frontend streaming output effect

    /**
     * Load feature toggle states from settings
     * Must be called after app.ui.settings is loaded
     */
    loadSettings() {
        if (typeof app === 'undefined' || !app.ui || !app.ui.settings) return;

        // Helper function: load boolean setting, keep default if not set
        const loadBool = (key, settingId) => {
            const val = app.ui.settings.getSettingValue(settingId);
            if (typeof val === 'boolean') {
                this[key] = val;
            }
        };

        // Load basic feature toggles
        loadBool('enabled', "PromptAssistant.Features.Enabled");
        loadBool('history', "PromptAssistant.Features.History");
        loadBool('tag', "PromptAssistant.Features.Tag");
        loadBool('expand', "PromptAssistant.Features.Expand");
        loadBool('translate', "PromptAssistant.Features.Translate");
        loadBool('imageCaption', "PromptAssistant.Features.ImageCaption");
        loadBool('nodeHelpTranslator', "PromptAssistant.Features.NodeHelpTranslator");
        loadBool('useTranslateCache', "PromptAssistant.Features.UseTranslateCache");

        // Load translation formatting options
        loadBool('translateFormatPunctuation', "PromptAssistant.Features.TranslateFormatPunctuation");
        loadBool('translateFormatSpace', "PromptAssistant.Features.TranslateFormatSpace");
        loadBool('translateFormatDots', "PromptAssistant.Features.TranslateFormatDots");

        // Load mixed language cache options
        loadBool('cacheMixedLangTranslation', "PromptAssistant.Features.CacheMixedLangTranslation");
        loadBool('translateFormatNewline', "PromptAssistant.Features.TranslateFormatNewline");

        // Load mixed language translation rules
        const mixedLangRule = app.ui.settings.getSettingValue("PromptAssistant.Features.MixedLangTranslateRule");
        if (mixedLangRule) {
            this.mixedLangTranslateRule = mixedLangRule;
        }

        // Load system settings
        loadBool('showStreamingProgress', "PromptAssistant.Settings.ShowStreamingProgress");
        loadBool('enableStreaming', "PromptAssistant.Settings.EnableStreaming");

        // Load log level
        const logLevel = app.ui.settings.getSettingValue("PromptAssistant.Settings.LogLevel");
        if (logLevel !== undefined) {
            // Ensure it's a number
            const level = parseInt(logLevel);
            if (!isNaN(level)) {
                if (typeof window !== 'undefined') {
                    if (!window.FEATURES) window.FEATURES = {};
                    window.FEATURES.logLevel = level;
                }
                if (logger) logger.setLevel(level);
            }
        }
    },

    /**
     * Update button display state for all instances
     * Controls UI element show/hide based on feature toggle state
     */
    updateButtonsVisibility() {
        if (!PromptAssistant) return;
        // Iterate through all assistant instances
        PromptAssistant.instances.forEach((instance) => {
            if (instance.buttons) {
                // History-related buttons - controlled by single history toggle
                if (instance.buttons['history']) {
                    instance.buttons['history'].style.display = this.history ? 'block' : 'none';
                }
                if (instance.buttons['undo']) {
                    instance.buttons['undo'].style.display = this.history ? 'block' : 'none';
                }
                if (instance.buttons['redo']) {
                    instance.buttons['redo'].style.display = this.history ? 'block' : 'none';
                }

                // Divider 1 - after history features
                if (instance.buttons['divider1']) {
                    const hasHistoryFeature = this.history;
                    const hasOtherFeatures = this.tag || this.expand || this.translate;
                    const showDivider1 = hasHistoryFeature && hasOtherFeatures;
                    instance.buttons['divider1'].style.display = showDivider1 ? 'block' : 'none';
                }

                // Other feature buttons
                if (instance.buttons['tag']) {
                    instance.buttons['tag'].style.display = this.tag ? 'block' : 'none';
                }
                if (instance.buttons['expand']) {
                    instance.buttons['expand'].style.display = this.expand ? 'block' : 'none';
                }
                if (instance.buttons['translate']) {
                    instance.buttons['translate'].style.display = this.translate ? 'block' : 'none';
                }

                // Log (too frequent, removed)
                // logger.debug(`Button update | Node ID: ${instance.nodeId}`);
            }
        });

        // Handle image assistant button display
        if (ImageCaption) {
            ImageCaption.instances.forEach((assistant) => {
                if (assistant.buttons) {
                    // Image caption buttons
                    if (assistant.buttons['caption_zh']) {
                        assistant.buttons['caption_zh'].style.display = this.imageCaption ? 'block' : 'none';
                    }
                    if (assistant.buttons['caption_en']) {
                        assistant.buttons['caption_en'].style.display = this.imageCaption ? 'block' : 'none';
                    }

                    // If image caption feature is disabled, hide entire assistant
                    if (assistant.element) {
                        if (!this.imageCaption) {
                            assistant.element.style.display = 'none';
                        } else {
                            // Always show image assistant
                            assistant.element.style.display = 'flex';
                        }
                    }
                }
            });
        }
    }
};

/**
 * Handle feature toggle state changes
 */
export function handleFeatureChange(featureName, value, oldValue) {
    if (!PromptAssistant || !promptAssistant) return;
    // Feature toggles always work independently regardless of master switch state
    // If changing from disabled to enabled, need to recreate buttons
    if (value && !oldValue) {
        // Only rebuild buttons when assistant system is already initialized
        if (PromptAssistant.instances.size > 0) {
            // Recreate buttons for all instances
            PromptAssistant.instances.forEach((instance) => {
                if (instance.element && instance.innerContent) {
                    // Clear existing button container
                    instance.innerContent.innerHTML = '';
                    instance.buttons = {};
                    // Recreate all buttons
                    promptAssistant.addFunctionButtons(instance);
                }
            });
            logger.debug(`Feature rebuild | Result: complete | Feature: ${featureName}`);

            // Recalculate and update width for all instances
            promptAssistant.updateAllInstancesWidth();
            if (imageCaption && imageCaption.updateAllInstancesWidth) {
                imageCaption.updateAllInstancesWidth();
            }
        }

        // If image caption feature is being enabled
        if (featureName === 'Image Caption' && imageCaption) {
            // Enable image assistant feature
            if (imageCaption.initialized) {
                // Reset node initialization flags
                if (app.canvas && app.canvas.graph) {
                    const nodes = app.canvas.graph._nodes || [];
                    nodes.forEach(node => {
                        if (node) {
                            node._imageCaptionInitialized = false;
                        }
                    });
                }

                // If there are currently selected nodes, process immediately
                if (app.canvas && app.canvas.selected_nodes && Object.keys(app.canvas.selected_nodes).length > 0) {
                    app.canvas._imageCaptionSelectionHandler(app.canvas.selected_nodes);
                }
            } else {
                // If image assistant is not yet initialized, initialize it
                imageCaption.initialize().then(() => {
                    // Process currently selected nodes after initialization
                    if (app.canvas && app.canvas.selected_nodes && Object.keys(app.canvas.selected_nodes).length > 0) {
                        app.canvas._imageCaptionSelectionHandler(app.canvas.selected_nodes);
                    }
                });
            }
        }

        // If node help translation feature is being enabled
        if (featureName === 'Node Info Translation' && nodeHelpTranslator) {
            // Enable node help translation feature
            nodeHelpTranslator.initialize();
        }
    } else {
        // Otherwise only update display state
        FEATURES.updateButtonsVisibility();

        // If image caption feature is being disabled
        if (featureName === 'Image Caption' && !value && imageCaption) {
            // Clean up all image assistant instances
            imageCaption.cleanup();
        }

        // If node help translation feature is being disabled
        if (featureName === 'Node Info Translation' && !value && nodeHelpTranslator) {
            // Clean up node help translation feature
            nodeHelpTranslator.cleanup();
        }

        // When feature toggles change, update width for all instances
        if (PromptAssistant.instances.size > 0 || (ImageCaption && ImageCaption.instances.size > 0)) {
            promptAssistant.updateAllInstancesWidth();
            if (imageCaption && imageCaption.updateAllInstancesWidth) {
                imageCaption.updateAllInstancesWidth();
            }
        }
    }
} 