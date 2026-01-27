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

        // 加载基础功能开关
        loadBool('enabled', "PromptAssistant.Features.Enabled");
        loadBool('history', "PromptAssistant.Features.History");
        loadBool('tag', "PromptAssistant.Features.Tag");
        loadBool('expand', "PromptAssistant.Features.Expand");
        loadBool('translate', "PromptAssistant.Features.Translate");
        loadBool('imageCaption', "PromptAssistant.Features.ImageCaption");
        loadBool('nodeHelpTranslator', "PromptAssistant.Features.NodeHelpTranslator");
        loadBool('useTranslateCache', "PromptAssistant.Features.UseTranslateCache");

        // 加载翻译格式化选项
        loadBool('translateFormatPunctuation', "PromptAssistant.Features.TranslateFormatPunctuation");
        loadBool('translateFormatSpace', "PromptAssistant.Features.TranslateFormatSpace");
        loadBool('translateFormatDots', "PromptAssistant.Features.TranslateFormatDots");

        // 加载混合语言缓存选项
        loadBool('cacheMixedLangTranslation', "PromptAssistant.Features.CacheMixedLangTranslation");
        loadBool('translateFormatNewline', "PromptAssistant.Features.TranslateFormatNewline");

        // 加载混合语言翻译规则
        const mixedLangRule = app.ui.settings.getSettingValue("PromptAssistant.Features.MixedLangTranslateRule");
        if (mixedLangRule) {
            this.mixedLangTranslateRule = mixedLangRule;
        }

        // 加载系统设置
        loadBool('showStreamingProgress', "PromptAssistant.Settings.ShowStreamingProgress");
        loadBool('enableStreaming', "PromptAssistant.Settings.EnableStreaming");

        // 加载日志级别
        const logLevel = app.ui.settings.getSettingValue("PromptAssistant.Settings.LogLevel");
        if (logLevel !== undefined) {
            // 确保是数字
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
     * 更新所有实例的按钮显示状态
     * 根据功能开关状态控制UI元素的显示和隐藏
     */
    updateButtonsVisibility() {
        if (!PromptAssistant) return;
        // 遍历所有助手实例
        PromptAssistant.instances.forEach((instance) => {
            if (instance.buttons) {
                // 历史相关按钮 - 由单一的history开关控制
                if (instance.buttons['history']) {
                    instance.buttons['history'].style.display = this.history ? 'block' : 'none';
                }
                if (instance.buttons['undo']) {
                    instance.buttons['undo'].style.display = this.history ? 'block' : 'none';
                }
                if (instance.buttons['redo']) {
                    instance.buttons['redo'].style.display = this.history ? 'block' : 'none';
                }

                // 分隔线1 - 在历史功能之后
                if (instance.buttons['divider1']) {
                    const hasHistoryFeature = this.history;
                    const hasOtherFeatures = this.tag || this.expand || this.translate;
                    const showDivider1 = hasHistoryFeature && hasOtherFeatures;
                    instance.buttons['divider1'].style.display = showDivider1 ? 'block' : 'none';
                }

                // 其他功能按钮
                if (instance.buttons['tag']) {
                    instance.buttons['tag'].style.display = this.tag ? 'block' : 'none';
                }
                if (instance.buttons['expand']) {
                    instance.buttons['expand'].style.display = this.expand ? 'block' : 'none';
                }
                if (instance.buttons['translate']) {
                    instance.buttons['translate'].style.display = this.translate ? 'block' : 'none';
                }

                // 记录日志 (太频繁，已移除)
                // logger.debug(`按钮更新 | 节点ID: ${instance.nodeId}`);
            }
        });

        // 处理图像小助手的按钮显示
        if (ImageCaption) {
            ImageCaption.instances.forEach((assistant) => {
                if (assistant.buttons) {
                    // 图像反推按钮
                    if (assistant.buttons['caption_zh']) {
                        assistant.buttons['caption_zh'].style.display = this.imageCaption ? 'block' : 'none';
                    }
                    if (assistant.buttons['caption_en']) {
                        assistant.buttons['caption_en'].style.display = this.imageCaption ? 'block' : 'none';
                    }

                    // 如果图像反推功能被禁用，隐藏整个小助手
                    if (assistant.element) {
                        if (!this.imageCaption) {
                            assistant.element.style.display = 'none';
                        } else {
                            // 始终显示图像小助手
                            assistant.element.style.display = 'flex';
                        }
                    }
                }
            });
        }
    }
};

/**
 * 处理功能开关状态变化
 */
export function handleFeatureChange(featureName, value, oldValue) {
    if (!PromptAssistant || !promptAssistant) return;
    // 无论总开关状态如何，功能开关始终独立工作
    // 如果是从禁用变为启用，需要重新创建按钮
    if (value && !oldValue) {
        // 只有当小助手系统已初始化时才重建按钮
        if (PromptAssistant.instances.size > 0) {
            // 重新创建所有实例的按钮
            PromptAssistant.instances.forEach((instance) => {
                if (instance.element && instance.innerContent) {
                    // 清空现有按钮容器
                    instance.innerContent.innerHTML = '';
                    instance.buttons = {};
                    // 重新创建所有按钮
                    promptAssistant.addFunctionButtons(instance);
                }
            });
            logger.debug(`功能重建 | 结果:完成 | 功能: ${featureName}`);

            // 重新计算并更新所有实例的宽度
            promptAssistant.updateAllInstancesWidth();
            if (imageCaption && imageCaption.updateAllInstancesWidth) {
                imageCaption.updateAllInstancesWidth();
            }
        }

        // 如果是图像反推功能被启用
        if (featureName === '图像反推' && imageCaption) {
            // 启用图像小助手功能
            if (imageCaption.initialized) {
                // 重置节点初始化标记
                if (app.canvas && app.canvas.graph) {
                    const nodes = app.canvas.graph._nodes || [];
                    nodes.forEach(node => {
                        if (node) {
                            node._imageCaptionInitialized = false;
                        }
                    });
                }

                // 如果有当前选中的节点，立即处理
                if (app.canvas && app.canvas.selected_nodes && Object.keys(app.canvas.selected_nodes).length > 0) {
                    app.canvas._imageCaptionSelectionHandler(app.canvas.selected_nodes);
                }
            } else {
                // 如果图像小助手尚未初始化，则初始化它
                imageCaption.initialize().then(() => {
                    // 初始化完成后处理当前选中的节点
                    if (app.canvas && app.canvas.selected_nodes && Object.keys(app.canvas.selected_nodes).length > 0) {
                        app.canvas._imageCaptionSelectionHandler(app.canvas.selected_nodes);
                    }
                });
            }
        }

        // 如果是节点帮助翻译功能被启用
        if (featureName === '节点帮助翻译' && nodeHelpTranslator) {
            // 启用节点帮助翻译功能
            nodeHelpTranslator.initialize();
        }
    } else {
        // 否则只更新显示状态
        FEATURES.updateButtonsVisibility();

        // 如果是图像反推功能被禁用
        if (featureName === '图像反推' && !value && imageCaption) {
            // 清理所有图像小助手实例
            imageCaption.cleanup();
        }

        // 如果是节点帮助翻译功能被禁用
        if (featureName === '节点帮助翻译' && !value && nodeHelpTranslator) {
            // 清理节点帮助翻译功能
            nodeHelpTranslator.cleanup();
        }

        // 功能开关变化时，更新所有实例的宽度
        if (PromptAssistant.instances.size > 0 || (ImageCaption && ImageCaption.instances.size > 0)) {
            promptAssistant.updateAllInstancesWidth();
            if (imageCaption && imageCaption.updateAllInstancesWidth) {
                imageCaption.updateAllInstancesWidth();
            }
        }
    }
} 