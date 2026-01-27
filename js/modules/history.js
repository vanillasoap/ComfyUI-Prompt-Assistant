/**
 * History Manager
 * Manages the display and operations of history records
 */

import { app } from "../../../../scripts/app.js";
import { logger } from '../utils/logger.js';
import { HistoryCacheService } from "../services/cache.js";
import { PopupManager } from "../utils/popupManager.js";
import { EventManager } from "../utils/eventManager.js";
import { UIToolkit } from "../utils/UIToolkit.js";
import { ResourceManager } from "../utils/resourceManager.js";

/**
 * History Manager class
 * Manages history popup and history selection
 */
class HistoryManager {
    static popupInstance = null;
    static onCloseCallback = null;
    static currentNodeId = null;  // Current node ID
    static currentInputId = null; // Current input ID
    static eventCleanups = [];    // Event cleanup functions array
    static activeTooltip = null;  // Currently active tooltip

    /**
     * Show history popup
     */
    static async showHistoryPopup(params) {
        const { anchorButton, nodeId, inputId, onClose } = params;

        try {
            // Save current node and input ID
            this.currentNodeId = nodeId;
            this.currentInputId = inputId;

            // logger.debug(`History popup | Trigger show | Node:${nodeId} | Input:${inputId}`);

            // Clean up existing event listeners
            this._cleanupEvents();

            // Get history data
            const historyList = HistoryCacheService.getHistoryList({
                nodeId: nodeId,
                limit: 100,  // Increase limit to ensure enough history data
                workflowId: app.graph?._workflow_id
            });

            // Create new popup
            const popup = this._createHistoryPopup({ historyList, nodeId });

            // Show popup using PopupManager
            await PopupManager.showPopup({
                popup: popup,
                anchorButton: anchorButton,
                buttonInfo: params.buttonInfo,
                onClose: () => {
                    // Clean up event listeners
                    this._cleanupEvents();
                    // Execute the passed close callback
                    if (typeof onClose === 'function') {
                        onClose();
                    }
                }
            });

            // logger.debug(`History popup | Result: success | Node:${nodeId}`);
        } catch (error) {
            logger.error(`History popup | Result: failed | Error:${error.message}`);
            this._cleanupAll();
        }
    }

    /**
     * Hide history popup
     */
    static hideHistoryPopup() {
        // Clean up event listeners
        this._cleanupEvents();

        // Close all popups using PopupManager
        PopupManager.closeAllPopups();
    }

    /**
     * Clean up all event listeners
     */
    static _cleanupEvents() {
        // Execute and clear all event cleanup functions
        if (this.eventCleanups.length > 0) {
            this.eventCleanups.forEach(cleanup => {
                if (typeof cleanup === 'function') {
                    cleanup();
                }
            });
            this.eventCleanups = [];
        }
    }

    /**
     * Force cleanup all related resources
     */
    static _cleanupAll() {
        // Clean up event listeners
        this._cleanupEvents();

        // Close all popups using PopupManager
        PopupManager.closeAllPopups();
    }

    /**
     * Format history content with appropriate truncation and processing
     */
    static _formatHistoryContent(content, operationType) {
        // No longer adds operation type prefix, returns content directly
        return content;
    }

    /**
     * Create and show tooltip
     */
    static _showTooltip(target, text) {
        // Remove existing tooltip
        this._hideTooltip();

        // Create tooltip element
        const tooltip = document.createElement('div');
        tooltip.className = 'tag_tooltip';
        tooltip.textContent = text;
        document.body.appendChild(tooltip);

        // Get target element position and dimensions
        const rect = target.getBoundingClientRect();

        // Calculate tooltip position
        const tooltipRect = tooltip.getBoundingClientRect();
        const left = rect.left + (rect.width - tooltipRect.width) / 2;
        const top = rect.top - tooltipRect.height - 8; // 8px gap

        // Set tooltip position
        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;

        // Save current tooltip reference
        this.activeTooltip = tooltip;
    }

    /**
     * Hide tooltip
     */
    static _hideTooltip() {
        if (this.activeTooltip) {
            this.activeTooltip.remove();
            this.activeTooltip = null;
        }
    }

    /**
     * Create history popup
     */
    static _createHistoryPopup({ historyList, nodeId }) {
        const popup = document.createElement('div');
        popup.className = 'popup_container';

        // Create title bar
        const titleBar = document.createElement('div');
        titleBar.className = 'popup_title_bar';

        const title = document.createElement('div');
        title.className = 'popup_title';
        title.style.display = 'flex';
        title.style.alignItems = 'center';

        // Add icon
        const iconContainer = ResourceManager.getIcon('icon-history.svg');
        if (iconContainer) {
            iconContainer.style.width = '18px';
            iconContainer.style.height = '18px';
            iconContainer.style.color = 'var(--p-dialog-color)';
            iconContainer.style.marginRight = '8px';
            title.appendChild(iconContainer);
        }

        title.appendChild(document.createTextNode('History'));

        const actions = document.createElement('div');
        actions.className = 'popup_actions';

        // Create clear current button
        const clearCurrentBtn = document.createElement('button');
        clearCurrentBtn.className = 'popup_action_btn';
        clearCurrentBtn.textContent = 'Clear Current';

        // Add click event using EventManager
        const clearCurrentCleanup = EventManager.addDOMListener(clearCurrentBtn, 'click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.hideHistoryPopup();
            try {
                // Get current input content
                const inputEl = window.PromptAssistantInputWidgetMap?.[`${nodeId}_${this.currentInputId}`]?.inputEl;
                const currentContent = inputEl?.value || '';

                // Clear current node's history
                await HistoryCacheService.clearNodeHistory(nodeId);

                // If input has content, add to history
                if (currentContent.trim()) {
                    HistoryCacheService.addHistory({
                        workflow_id: '',
                        node_id: nodeId,
                        input_id: this.currentInputId,
                        content: currentContent,
                        operation_type: 'input',
                        timestamp: Date.now()
                    });
                    logger.debug(`History | Saved current content after clear | Node:${nodeId} | Input:${this.currentInputId}`);
                }

                // Update button state
                if (window.PromptAssistantInputWidgetMap?.[`${nodeId}_${this.currentInputId}`]?.widget) {
                    const widget = window.PromptAssistantInputWidgetMap[`${nodeId}_${this.currentInputId}`].widget;
                    UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);
                }

                logger.debug(`History | Cleared current node history | Node:${nodeId}`);
            } catch (error) {
                logger.error(`History | Clear failed | Error:${error.message}`);
            }
        });
        this.eventCleanups.push(clearCurrentCleanup);

        // Create clear all button
        const clearAllBtn = document.createElement('button');
        clearAllBtn.className = 'popup_action_btn danger';
        clearAllBtn.textContent = 'Clear All';

        // Add click event using EventManager
        const clearAllCleanup = EventManager.addDOMListener(clearAllBtn, 'click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.hideHistoryPopup();
            try {
                // Get current input content
                const inputEl = window.PromptAssistantInputWidgetMap?.[`${nodeId}_${this.currentInputId}`]?.inputEl;
                const currentContent = inputEl?.value || '';

                // Clear all history
                await HistoryCacheService.clearAllHistory();

                // If input has content, add to history
                if (currentContent.trim()) {
                    HistoryCacheService.addHistory({
                        workflow_id: '',
                        node_id: nodeId,
                        input_id: this.currentInputId,
                        content: currentContent,
                        operation_type: 'input',
                        timestamp: Date.now()
                    });
                    logger.debug(`History | Saved current content after clear | Node:${nodeId} | Input:${this.currentInputId}`);
                }

                // Update button state
                if (window.PromptAssistantInputWidgetMap?.[`${nodeId}_${this.currentInputId}`]?.widget) {
                    const widget = window.PromptAssistantInputWidgetMap[`${nodeId}_${this.currentInputId}`].widget;
                    UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);
                }

                logger.debug('History | Cleared all history');
            } catch (error) {
                logger.error(`History | Clear failed | Error:${error.message}`);
            }
        });
        this.eventCleanups.push(clearAllCleanup);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'popup_btn';
        UIToolkit.addIconToButton(closeBtn, 'pi-times', 'Close');

        // Add click event using EventManager
        const closeCleanup = EventManager.addDOMListener(closeBtn, 'click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.hideHistoryPopup();
        });
        this.eventCleanups.push(closeCleanup);

        // Add buttons to actions area
        actions.appendChild(clearCurrentBtn);
        actions.appendChild(clearAllBtn);
        actions.appendChild(closeBtn);
        titleBar.appendChild(title);
        titleBar.appendChild(actions);

        // Group and sort history records by node
        const { orderedNodeIds, nodeGroups } = this._groupAndSortHistoryByNode(historyList, nodeId);

        // Create tabs container
        const tabsContainer = document.createElement('div');
        tabsContainer.className = 'popup_tabs_container';

        // Create scrollable area
        const tabsScroll = document.createElement('div');
        tabsScroll.className = 'popup_tabs_scroll';

        // Create tabs
        const tabs = document.createElement('div');
        tabs.className = 'popup_tabs';

        // Create left/right scroll indicators
        const leftIndicator = document.createElement('div');
        leftIndicator.className = 'tabs_scroll_indicator left';

        // Add icon
        const leftIcon = ResourceManager.getIcon('icon-movedown.svg');
        if (leftIcon) {
            leftIcon.classList.add('rotate_left', 'scroll_indicator_icon');
            leftIndicator.appendChild(leftIcon);
        }
        leftIndicator.style.display = 'none'; // Initially hidden

        const rightIndicator = document.createElement('div');
        rightIndicator.className = 'tabs_scroll_indicator right';

        // Add icon
        const rightIcon = ResourceManager.getIcon('icon-movedown.svg');
        if (rightIcon) {
            rightIcon.classList.add('rotate_right', 'scroll_indicator_icon');
            rightIndicator.appendChild(rightIcon);
        }
        rightIndicator.style.display = 'none'; // Initially hidden

        // Add indicator click events - improved scroll logic
        const leftScrollCleanup = EventManager.addDOMListener(leftIndicator, 'click', () => {
            // Get visible area width
            const visibleWidth = tabsScroll.clientWidth;

            // Calculate scroll distance, PrimeVue style scrolls a larger distance
            const scrollDistance = visibleWidth * 0.75;

            // Smooth scroll
            tabsScroll.scrollBy({
                left: -scrollDistance,
                behavior: 'smooth'
            });
        });
        this.eventCleanups.push(leftScrollCleanup);

        const rightScrollCleanup = EventManager.addDOMListener(rightIndicator, 'click', () => {
            // Get visible area width
            const visibleWidth = tabsScroll.clientWidth;

            // Calculate scroll distance, PrimeVue style scrolls a larger distance
            const scrollDistance = visibleWidth * 0.75;

            // Smooth scroll
            tabsScroll.scrollBy({
                left: scrollDistance,
                behavior: 'smooth'
            });
        });
        this.eventCleanups.push(rightScrollCleanup);

        // Listen for scroll events, show/hide scroll indicators
        const scrollCleanup = EventManager.addDOMListener(tabsScroll, 'scroll', () => {
            // Check if scrolling is needed
            const canScroll = tabsScroll.scrollWidth > tabsScroll.clientWidth;

            if (!canScroll) {
                // If no scrolling needed, hide both indicators
                leftIndicator.style.display = 'none';
                rightIndicator.style.display = 'none';
                return;
            }

            // Show/hide left and right scroll indicators
            leftIndicator.style.display = tabsScroll.scrollLeft > 0 ? 'flex' : 'none';
            rightIndicator.style.display =
                tabsScroll.scrollLeft < (tabsScroll.scrollWidth - tabsScroll.clientWidth - 2) ? 'flex' : 'none';
        });
        this.eventCleanups.push(scrollCleanup);

        // Initial check for scroll indicators
        setTimeout(() => {
            // Check if scrolling is needed
            const canScroll = tabsScroll.scrollWidth > tabsScroll.clientWidth;

            if (canScroll) {
                // If scrolling is needed, show right indicator
                rightIndicator.style.display = 'flex';
            }
        }, 100);

        // Create content area
        const tabContentsContainer = document.createElement('div');
        tabContentsContainer.className = 'popup_content';

        // Record tab and content element mapping
        const tabContentPairs = [];

        // Iterate sorted node ID array, ensuring current node is first, others sorted by number
        orderedNodeIds.forEach((groupNodeId) => {
            const nodeItems = nodeGroups[groupNodeId];

            // Skip if no data
            if (!nodeItems || nodeItems.length === 0) return;

            // Create tab
            const tab = document.createElement('div');
            tab.className = 'popup_tab';

            // Set tab title
            if (groupNodeId === nodeId) {
                tab.textContent = 'Current Node';
                tab.classList.add('current_node');

                // Current node tab is selected and active by default
                tab.classList.add('active');
            } else {
                // Extract node number (assuming format is digits + possible letters)
                const nodeNumMatch = String(groupNodeId).match(/\d+/);
                const nodeNum = nodeNumMatch ? nodeNumMatch[0] : groupNodeId;
                tab.textContent = `Node ${nodeNum}`;
            }

            // Create content container
            const tabContent = document.createElement('div');
            tabContent.className = 'popup_tab_content';

            // If this tab is selected by default, show its content
            if (tab.classList.contains('active')) {
                tabContent.classList.add('active');
            }

            // Render this node's history records
            if (nodeItems.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'popup_empty';
                empty.textContent = 'No history records';
                tabContent.appendChild(empty);
            } else {
                nodeItems.forEach((item) => {
                    const itemDiv = document.createElement('div');
                    itemDiv.className = 'popup_list_item';

                    // Add metadata container
                    const metaDiv = document.createElement('div');
                    metaDiv.className = 'history_meta';

                    // Add input ID (always shown)
                    const inputIdSpan = document.createElement('span');
                    inputIdSpan.className = 'input_id';
                    inputIdSpan.textContent = `${item.input_id}`;
                    metaDiv.appendChild(inputIdSpan);

                    // Add corresponding label based on operation type
                    if (item.operation_type) {
                        const operationSpan = document.createElement('span');

                        switch (item.operation_type) {
                            case 'translate':
                                operationSpan.className = 'history_operation translated';
                                operationSpan.textContent = 'Translate';
                                break;
                            case 'expand':
                                operationSpan.className = 'history_operation expanded';
                                operationSpan.textContent = 'Prompt Enhance';
                                break;
                            case 'caption':
                                operationSpan.className = 'history_operation caption';
                                operationSpan.textContent = 'Image Caption';
                                break;
                            // Other operation types can be added here
                        }

                        if (operationSpan.textContent) {
                            metaDiv.appendChild(operationSpan);
                        }
                    }

                    // Create content container
                    const contentDiv = document.createElement('div');
                    contentDiv.className = 'history_content';

                    // Set display content - using format method
                    const displayContent = this._formatHistoryContent(item.content, item.operation_type);
                    contentDiv.textContent = displayContent;

                    // Assemble history item
                    itemDiv.appendChild(metaDiv);
                    itemDiv.appendChild(contentDiv);

                    // Add mouse hover events to show full content tooltip
                    const mouseEnterCleanup = EventManager.addDOMListener(itemDiv, 'mouseenter', () => {
                        this._showTooltip(itemDiv, displayContent);
                    });

                    const mouseLeaveCleanup = EventManager.addDOMListener(itemDiv, 'mouseleave', () => {
                        this._hideTooltip();
                    });

                    this.eventCleanups.push(mouseEnterCleanup, mouseLeaveCleanup);

                    // Add click event using EventManager
                    const itemCleanup = EventManager.addDOMListener(itemDiv, 'click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();

                        // Actively close tooltip
                        this._hideTooltip();

                        // Write content to input using UIToolkit
                        const success = UIToolkit.writeToInput(item.content, this.currentNodeId, this.currentInputId, {
                            highlight: true,
                            focus: true
                        });

                        if (success) {
                            // If content comes from another input, add history and update undo state
                            if (item.node_id !== this.currentNodeId || item.input_id !== this.currentInputId) {
                                HistoryCacheService.addHistoryAndUpdateUndoState(
                                    this.currentNodeId,
                                    this.currentInputId,
                                    item.content,
                                    'input'
                                );
                            }

                            // Hide history popup
                            this.hideHistoryPopup();
                        }
                    });
                    this.eventCleanups.push(itemCleanup);

                    tabContent.appendChild(itemDiv);
                });
            }

            // Add to container
            tabs.appendChild(tab);
            tabContentsContainer.appendChild(tabContent);

            // Save tab and content mapping for tab click switching
            tabContentPairs.push({ tab, content: tabContent });

            // Add tab click event
            const tabCleanup = EventManager.addDOMListener(tab, 'click', () => {
                // Get currently active tab
                const currentActiveTab = tabs.querySelector('.popup_tab.active');

                // If clicking the currently active tab, do nothing
                if (currentActiveTab === tab) return;

                // Add exit animation to currently active tab
                if (currentActiveTab) {
                    currentActiveTab.classList.add('exiting');
                    // Listen for animation end
                    const animationEndHandler = () => {
                        currentActiveTab.classList.remove('active', 'exiting');
                        currentActiveTab.removeEventListener('transitionend', animationEndHandler);
                    };
                    currentActiveTab.addEventListener('transitionend', animationEndHandler);
                }

                // Remove active class from all content
                tabContentPairs.forEach(pair => {
                    pair.content.classList.remove('active');
                });

                // Activate the clicked tab
                tab.classList.add('active');
                tabContent.classList.add('active');

                // Scroll into visible area
                tab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
            });
            this.eventCleanups.push(tabCleanup);
        });

        // Assemble tabs container
        tabsScroll.appendChild(tabs);
        tabsContainer.appendChild(tabsScroll);
        tabsContainer.appendChild(leftIndicator);
        tabsContainer.appendChild(rightIndicator);

        // Assemble popup
        popup.appendChild(titleBar);
        popup.appendChild(tabsContainer);
        popup.appendChild(tabContentsContainer);

        return popup;
    }

    /**
     * Group and sort history records by node
     */
    static _groupAndSortHistoryByNode(historyList, currentNodeId) {
        // Group by node ID
        const groups = {};

        // Collect all node IDs for subsequent sorting
        const nodeIds = new Set();

        // Group history records
        historyList.forEach(item => {
            const nodeId = item.node_id;
            if (!groups[nodeId]) {
                groups[nodeId] = [];
                nodeIds.add(nodeId);
            }
            groups[nodeId].push(item);
        });

        // Ensure current node ID exists in the node list
        if (currentNodeId && !nodeIds.has(currentNodeId)) {
            nodeIds.add(currentNodeId);
            groups[currentNodeId] = [];
        }

        // Convert node IDs to array and sort
        // Sort rules: 1. Current node first 2. Other nodes sorted by numeric order
        const sortedNodeIds = Array.from(nodeIds).sort((a, b) => {
            // If a is the current node, place it first
            if (a === currentNodeId) return -1;
            // If b is the current node, place it first
            if (b === currentNodeId) return 1;

            // Extract numeric part from node ID
            const getNodeNumber = (id) => {
                const match = String(id).match(/\d+/);
                return match ? parseInt(match[0]) : 0;
            };

            // Sort by numeric value
            return getNodeNumber(a) - getNodeNumber(b);
        });

        // Sort history records within each group by timestamp (newest first)
        Object.keys(groups).forEach(nodeId => {
            groups[nodeId].sort((a, b) => b.timestamp - a.timestamp);
        });

        // Return sorted node ID array and grouped history records
        return {
            orderedNodeIds: sortedNodeIds,
            nodeGroups: groups
        };
    }
}

export { HistoryManager };
