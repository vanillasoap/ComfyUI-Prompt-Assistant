import { app } from "../../../scripts/app.js";
import { EventManager } from "../utils/eventManager.js";
import "../lib/Sortable.min.js";

/**
 * Debug switch: disable auto-collapse
 * Enter window.PA_DEBUG_NO_COLLAPSE = true in the console to disable auto-collapse
 * Enter window.PA_DEBUG_NO_COLLAPSE = false to restore auto-collapse
 */
window.PA_DEBUG_NO_COLLAPSE = window.PA_DEBUG_NO_COLLAPSE || false;

// Anchor position enum
export const ANCHOR_POSITION = {
    TOP_LEFT_H: 'top-left-h',
    TOP_LEFT_V: 'top-left-v',
    TOP_CENTER_H: 'top-center-h',
    TOP_RIGHT_H: 'top-right-h',
    TOP_RIGHT_V: 'top-right-v',
    RIGHT_CENTER_V: 'right-center-v',
    BOTTOM_RIGHT_H: 'bottom-right-h',
    BOTTOM_RIGHT_V: 'bottom-right-v',
    BOTTOM_CENTER_H: 'bottom-center-h',
    BOTTOM_LEFT_H: 'bottom-left-h',
    BOTTOM_LEFT_V: 'bottom-left-v',
    LEFT_CENTER_V: 'left-center-v'
};

export class AssistantContainer {
    constructor(options = {}) {
        this.nodeId = options.nodeId;
        this.type = options.type || 'prompt'; // 'prompt' or 'image'
        this.anchorPosition = options.anchorPosition || ANCHOR_POSITION.BOTTOM_RIGHT_H;
        this.offset = options.offset || { x: 0, y: 0 };
        this.enableDragSort = options.enableDragSort !== false;

        // Callbacks
        this.onButtonOrderChange = options.onButtonOrderChange;
        this.shouldCollapse = options.shouldCollapse;

        // State
        this.isCollapsed = true;
        this.isTransitioning = false;
        this.isDestroyed = false;
        this.buttons = [];
        this.element = null;
        this.container = null;
        this.hoverArea = null;
        this.indicator = null;
        this.content = null;

        // Timers
        this._collapseTimer = null;
        this._expandTimer = null;

        // Event cleanup functions
        this._cleanupFunctions = [];

        // Sortable instance
        this._sortable = null;
    }

    render() {
        // Check if already destroyed
        if (this.isDestroyed) return null;

        // Main container
        this.element = document.createElement('div');
        this.element.className = `assistant-container-common ${this.type}-assistant-container`;

        // Hover area (invisible, used to detect mouse enter/leave)
        this.hoverArea = document.createElement('div');
        this.hoverArea.className = 'assistant-hover-area';
        this.element.appendChild(this.hoverArea);

        // Indicator (icon)
        this.indicator = document.createElement('div');
        this.indicator.className = `assistant-indicator ${this.type}-assistant-indicator`;

        // Add entrance animation class
        this.indicator.classList.add('indicator-init');

        // Remove initialization class after animation ends
        this.indicator.addEventListener('animationend', () => {
            this.indicator.classList.remove('indicator-init');
        }, { once: true });

        this.element.appendChild(this.indicator);

        // Button content container
        this.content = document.createElement('div');
        this.content.className = 'assistant-content';
        this.element.appendChild(this.content);

        // Initial style based on anchor point
        this.updatePosition();

        // Bind events
        this._bindEvents();

        // Set up Sortable
        if (this.enableDragSort) {
            this._setupSortable();
        }

        return this.element;
    }

    mount(parentElement) {
        if (parentElement) {
            parentElement.appendChild(this.element);
            // Force reflow/update dimensions after mount
            requestAnimationFrame(() => this.updateDimensions());
        }
    }

    setIconContent(svgContent) {
        if (this.indicator) {
            this.indicator.innerHTML = svgContent;
        }
    }

    addButton(buttonElement, id) {
        if (!buttonElement) return;
        buttonElement.dataset.id = id; // Used by Sortable

        // Set button index for stagger animation delay
        const buttonIndex = this.buttons.length;
        buttonElement.style.setProperty('--button-index', buttonIndex);

        this.content.appendChild(buttonElement);
        this.buttons.push({ id, element: buttonElement });

        // If it's a divider, set class name based on current layout direction
        if (buttonElement.classList.contains('prompt-assistant-divider') ||
            buttonElement.classList.contains('image-assistant-divider')) {
            const isVertical = this.anchorPosition.endsWith('-v');
            if (isVertical) {
                buttonElement.classList.add('divider-horizontal');
            }
        }

        this.updateDimensions();
    }

    // Batch add buttons; if Sortable exists, follows Sortable logic (usually append)
    // If specific order is needed, sort before adding
    addButtons(buttonElementsWithIds) {
        buttonElementsWithIds.forEach(({ element, id }) => {
            this.addButton(element, id);
        });
    }

    // Clear buttons
    clearButtons() {
        this.content.innerHTML = '';
        this.buttons = [];
    }

    setAnchorPosition(position) {
        if (Object.values(ANCHOR_POSITION).includes(position)) {
            this.anchorPosition = position;
            this.updatePosition();
        }
    }

    updatePosition() {
        if (!this.element) return;

        // Save current expanded/collapsed state
        const wasExpanded = !this.isCollapsed;

        // Reset class names, maintain current state
        const stateClass = wasExpanded ? 'expanded' : 'collapsed';
        this.element.className = `assistant-container-common ${this.type}-assistant-container ${stateClass}`;

        // Add layout class name
        this.element.classList.add(`layout-${this.anchorPosition}`);

        // Ensure content container flex direction is correct
        const isVertical = this.anchorPosition.endsWith('-v');
        if (isVertical) {
            this.content.classList.add('flex-col');
            this.content.classList.remove('flex-row');
        } else {
            this.content.classList.add('flex-row');
            this.content.classList.remove('flex-col');
        }

        // Update divider class: add divider-horizontal class for vertical layout
        this._updateDividerOrientation(isVertical);

        // Trigger dimension recalculation
        this.updateDimensions();
    }

    // Update divider orientation class
    _updateDividerOrientation(isVertical) {
        if (!this.content) return;
        const dividers = this.content.querySelectorAll('.prompt-assistant-divider, .image-assistant-divider');
        dividers.forEach(divider => {
            if (isVertical) {
                divider.classList.add('divider-horizontal');
            } else {
                divider.classList.remove('divider-horizontal');
            }
        });
    }

    /**
     * Update container dimensions (optimized: constant layout mode)
     * Directly calculate dimensions based on currently enabled button combinations, avoiding DOM clone measurement overhead
     */
    updateDimensions() {
        if (!this.element || !this.content) return;

        // --- 1. Get current state statistics ---
        const buttons = Array.from(this.content.children).filter(el =>
            el.style.display !== 'none' &&
            !el.classList.contains('assistant-indicator')
        );

        const totalCount = buttons.length;
        if (totalCount === 0) return;

        // Count feature groups
        const hasHistoryGroup = buttons.some(el => el.dataset.id === 'history' || el.dataset.id === 'undo' || el.dataset.id === 'redo');
        const hasDivider = buttons.some(el => el.classList.contains('prompt-assistant-divider') || el.classList.contains('image-assistant-divider'));

        // Calculate effective feature button count excluding history and dividers
        const otherFeaturesCount = buttons.filter(el =>
            !['history', 'undo', 'redo'].includes(el.dataset.id) &&
            !el.classList.contains('prompt-assistant-divider') &&
            !el.classList.contains('image-assistant-divider')
        ).length;

        // --- 2. Dimension mapping based on preset constants ---
        let finalDimension = 28; // Default single button width (or collapsed size)

        // Logic rule matching (based on user-provided precise measurements)
        if (hasHistoryGroup && otherFeaturesCount === 3) {
            finalDimension = 143; // All features on (history 3 + divider 1 + other 3)
        } else if (hasHistoryGroup && otherFeaturesCount === 2) {
            finalDimension = 121; // History + two others
        } else if (hasHistoryGroup && otherFeaturesCount === 1) {
            finalDimension = 99;  // History + one other
        } else if (hasHistoryGroup && otherFeaturesCount === 0) {
            finalDimension = 77;  // History only
        } else if (!hasHistoryGroup && otherFeaturesCount === 3) {
            finalDimension = 72;  // Three features without history
        } else if (!hasHistoryGroup && otherFeaturesCount === 2) {
            finalDimension = 50;  // Only two buttons
        } else if (!hasHistoryGroup && otherFeaturesCount === 1) {
            finalDimension = 28;  // Only one button
        } else {
            // Fallback dynamic calculation: base 28 + (extra buttons * 22) + (has divider ? 5 : 0)
            const extraCount = totalCount - 1;
            finalDimension = 28 + (extraCount * 22);
            if (hasDivider) finalDimension += 5;
        }

        // --- 3. Apply dimensions ---
        const isVertical = this.anchorPosition.endsWith('-v');
        if (isVertical) {
            // Vertical layout: fixed width, dynamic height
            this.element.style.setProperty('--expanded-width', `28px`);
            this.element.style.setProperty('--expanded-height', `${finalDimension}px`);
        } else {
            // Horizontal layout: fixed height, dynamic width
            this.element.style.setProperty('--expanded-width', `${finalDimension}px`);
            this.element.style.setProperty('--expanded-height', `28px`);
        }

        /*
        // --- Original auto-measurement code (commented out, backup) ---
        const clone = this.content.cloneNode(true);
        clone.style.cssText = `
            position: absolute; 
            visibility: hidden; 
            height: auto; 
            width: auto; 
            white-space: nowrap;
            display: flex;
            align-items: center;
            gap: 0;
        `;

        const isVerticalMeasure = this.anchorPosition.endsWith('-v');
        clone.style.flexDirection = isVerticalMeasure ? 'column' : 'row';

        document.body.appendChild(clone);
        const contentWidth = clone.scrollWidth;
        const contentHeight = clone.scrollHeight;
        document.body.removeChild(clone);

        const containerPadding = 4;
        const lastButtonMargin = 2;
        const collapsedSize = 28;

        let expandedWidth, expandedHeight;
        if (isVerticalMeasure) {
            expandedWidth = collapsedSize;
            expandedHeight = Math.max(contentHeight + containerPadding + lastButtonMargin, collapsedSize);
        } else {
            expandedWidth = Math.max(contentWidth + containerPadding + lastButtonMargin, collapsedSize);
            expandedHeight = collapsedSize;
        }

        this.element.style.setProperty('--expanded-width', `${expandedWidth}px`);
        this.element.style.setProperty('--expanded-height', `${expandedHeight}px`);
        */
    }

    _bindEvents() {
        // Hover handling with interrupt logic
        const onMouseEnter = () => this.expand();
        const onMouseLeave = () => this.collapse();

        // Bind to hover area and element itself
        // Use EventManager for binding to facilitate cleanup
        this._cleanupFunctions.push(EventManager.addDOMListener(this.element, 'mouseenter', onMouseEnter));
        this._cleanupFunctions.push(EventManager.addDOMListener(this.element, 'mouseleave', onMouseLeave));
    }

    expand() {
        // Check if already destroyed
        if (this.isDestroyed) return;

        // Clear any pending collapse timers
        if (this._collapseTimer) {
            clearTimeout(this._collapseTimer);
            this._collapseTimer = null;
        }

        // Update dimensions first, ensure CSS variables are set before expanding
        this.updateDimensions();

        // Adjust button stagger animation index based on anchor position
        this._updateButtonStaggerIndex();

        // Expand immediately
        this.isCollapsed = false;
        this.element.classList.remove('collapsed');
        this.element.classList.add('expanded');

        // Hide indicator
        if (this.indicator) {
            this.indicator.style.opacity = '0';
            this.indicator.style.pointerEvents = 'none';
        }

        // 显示内容
        if (this.content) {
            this.content.style.opacity = '1';
            this.content.style.pointerEvents = 'auto';
        }
    }

    // 根据锚点位置调整按钮递进动画索引
    _updateButtonStaggerIndex() {
        if (!this.content) return;

        const children = Array.from(this.content.children);
        const totalButtons = children.length;

        // 判断是否需要反向索引
        // 右侧布局向左展开、底部布局向上展开时，需要反向（最后的按钮先显示）
        const needReverse = this._isReverseStaggerDirection();

        children.forEach((child, index) => {
            const staggerIndex = needReverse ? (totalButtons - 1 - index) : index;
            child.style.setProperty('--button-index', staggerIndex);
        });
    }

    // 判断递进动画是否需要反向
    _isReverseStaggerDirection() {
        // 从右侧/底部展开的布局需要反向
        // right 布局：从右向左展开，最右边的按钮先显示
        // bottom-v 布局：从下向上展开，最下面的按钮先显示
        const pos = this.anchorPosition;

        // 横向布局：右侧的需要反向
        if (pos.includes('right') && pos.endsWith('-h')) {
            return true;
        }
        // 竖向布局：底部的需要反向（column-reverse）
        if (pos.includes('bottom') && pos.endsWith('-v')) {
            return true;
        }

        return false;
    }

    collapse() {
        // 检查是否已销毁
        if (this.isDestroyed) return;

        // 调试模式：禁止自动折叠
        if (window.PA_DEBUG_NO_COLLAPSE) return;

        // 检查是否应阻止折叠（例如：激活的菜单）
        if (this.shouldCollapse && !this.shouldCollapse()) {
            return;
        }

        // 折叠前设置短暂延迟，允许鼠标在间隙/按钮之间移动
        // 但如果用户移回，expand() 会取消此操作。
        this._collapseTimer = setTimeout(() => {
            // 再次检查，因为在延迟期间状态可能已改变
            if (this.shouldCollapse && !this.shouldCollapse()) {
                return;
            }

            this.isCollapsed = true;
            this.element.classList.remove('expanded');
            this.element.classList.add('collapsed');

            // 显示指示器（清除内联样式，让 CSS 变量 --assistant-icon-opacity 生效）
            if (this.indicator) {
                this.indicator.style.opacity = '';
                this.indicator.style.pointerEvents = '';
            }

            // 隐藏内容
            if (this.content) {
                this.content.style.opacity = '0';
                this.content.style.pointerEvents = 'none';
            }

            // 折叠完成后，检测鼠标是否仍在热区内
            // 解决自动折叠后鼠标仍在热区，但需要移出再移入才能展开的问题
            this._checkMouseStillInHoverArea();
        }, 150); // 为了易用性设置的小延迟
    }

    // ---检测鼠标是否仍在热区内---
    _checkMouseStillInHoverArea() {
        if (!this.element) return;

        // 使用 requestAnimationFrame 确保 DOM 已更新
        requestAnimationFrame(() => {
            // 获取当前鼠标位置下的元素
            const hoveredElements = document.querySelectorAll(':hover');

            // 检查小助手容器或其子元素是否被悬停
            let isMouseInside = false;
            for (const el of hoveredElements) {
                if (this.element.contains(el) || el === this.element) {
                    isMouseInside = true;
                    break;
                }
            }

            // 如果鼠标仍在热区内，且当前是折叠状态，则触发展开
            if (isMouseInside && this.isCollapsed) {
                this.expand();
            }
        });
    }

    _setupSortable() {
        if (!this.content) return;

        this._sortable = new Sortable(this.content, {
            animation: 150,
            ghostClass: 'sortable-ghost',
            onEnd: (evt) => {
                const newOrder = Array.from(this.content.children)
                    .map(el => el.dataset.id)
                    .filter(Boolean);

                // 保存排序
                if (this.onButtonOrderChange) {
                    this.onButtonOrderChange(newOrder);
                }

                // 持久化到 settings
                this._saveOrderToSettings(newOrder);
            }
        });
    }

    _saveOrderToSettings(order) {
        const settingKey = `PromptAssistant.ButtonOrder.${this.type}`;
        // 使用 app.ui.settings 保存
        // ComfyUI 设置通常通过 app.ui.settings.setSettingValue(id, value) 设置
        if (app.ui && app.ui.settings) {
            app.ui.settings.setSettingValue(settingKey, JSON.stringify(order));
        }
    }

    restoreOrder() {
        const settingKey = `PromptAssistant.ButtonOrder.${this.type}`;
        if (!app.ui || !app.ui.settings) return;

        const orderStr = app.ui.settings.getSettingValue(settingKey);
        if (!orderStr) return;

        try {
            const order = JSON.parse(orderStr);
            if (!Array.isArray(order) || order.length === 0) return;

            // 按ID创建现有按钮的映射
            const buttonMap = new Map();
            Array.from(this.content.children).forEach(el => {
                if (el.dataset.id) {
                    buttonMap.set(el.dataset.id, el);
                }
            });

            // 按保存的顺序恢复按钮位置,新增按钮放在末尾
            const existingButtons = Array.from(this.content.children);
            const orderedIds = new Set(order);

            // 首先追加排序后的项
            order.forEach(id => {
                const el = buttonMap.get(id);
                if (el) {
                    this.content.appendChild(el);
                }
            });

            // 然后追加任何剩余项，如果它们不在顺序列表中
            existingButtons.forEach(el => {
                if (el.dataset.id && !orderedIds.has(el.dataset.id)) {
                    this.content.appendChild(el);
                }
            });

            this.updateDimensions();
        } catch (e) {
            logger.warn("[PromptAssistant] 恢复按钮顺序失败:", e);
        }
    }

    destroy() {
        // 防止重复销毁
        if (this.isDestroyed) return;
        this.isDestroyed = true;

        // 清理定时器
        if (this._collapseTimer) {
            clearTimeout(this._collapseTimer);
            this._collapseTimer = null;
        }
        if (this._expandTimer) {
            clearTimeout(this._expandTimer);
            this._expandTimer = null;
        }

        // 清理监听器
        this._cleanupFunctions.forEach(fn => fn && fn());
        this._cleanupFunctions = [];

        // 销毁 Sortable
        if (this._sortable) {
            this._sortable.destroy();
            this._sortable = null;
        }

        // 移除元素
        if (this.element && this.element.parentNode) {
            this.element.parentNode.removeChild(this.element);
        }

        // 清空所有引用
        this.element = null;
        this.container = null;
        this.content = null;
        this.indicator = null;
        this.hoverArea = null;
        this.buttons = [];
    }
}
