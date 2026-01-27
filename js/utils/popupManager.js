/**
 * Popup Utility Class
 * Provides general popup management functionality
 */

import { logger } from './logger.js';
import { UIToolkit } from "./UIToolkit.js";
import { promptAssistant } from "../modules/PromptAssistant.js";
import { ResourceManager } from './resourceManager.js';

class PopupManager {
    // Store the currently active popup and its info
    static activePopup = null;
    static activePopupInfo = null;
    static eventHandlers = {
        mousedown: null,
        keydown: null,
        focus: null,
        mousemove: null,
        mouseup: null
    };





    /**
     * Show popup, ensuring only one popup is displayed at a time
     */
    static async showPopup(options) {
        const { popup, anchorButton, buttonInfo, onClose, preventCloseOnElementTypes = [], enableResize = false } = options;

        // Close any open context menus first
        const { buttonMenu } = await import('../services/btnMenu.js');
        buttonMenu.hideMenu();

        // If another popup is already open, close it first
        if (this.activePopup && this.activePopup !== popup) {
            // [KEY] Mark that we are transitioning between popups
            this._isTransitioning = true;

            // Clear current active popup reference to avoid state conflicts in hidePopup
            this.activePopup = null;
            this.activePopupInfo = null;

            // Clean up all event listeners
            this.cleanupAllEventListeners();

            // Close the old popup
            if (oldPopupInfo && oldPopupInfo.onClose) {
                try {
                    oldPopupInfo.onClose();
                } catch (error) {
                    logger.error(`Failed to execute close callback: ${error.message}`);
                }
            }

            // Add closing animation
            const isPopupUp = oldPopup.classList.contains('popup-up');
            oldPopup.classList.add(isPopupUp ? 'popup-closing-up' : 'popup-closing-down');

            // Wait for animation to complete before showing the new popup
            return new Promise(resolve => {
                setTimeout(() => {
                    if (oldPopup.parentNode) {
                        oldPopup.parentNode.removeChild(oldPopup);
                    }
                    // Show the new popup
                    this._showNewPopup(options);
                    // Clear transition flag
                    this._isTransitioning = false;
                    resolve();
                }, 200);
            });
        } else {
            // No active popup, show the new popup directly
            return Promise.resolve(this._showNewPopup(options));
        }
    }

    /**
     * Internal method to show a new popup
     */
    static _showNewPopup(options) {
        const { popup, anchorButton, buttonInfo, onClose, preventCloseOnElementTypes = [], enableResize = false } = options;

        // After all other windows are closed, set the active button state
        if (buttonInfo) {
            UIToolkit.setActiveButton(buttonInfo);
        }

        // Save current popup info
        this.activePopup = popup;
        this.activePopupInfo = {
            anchorButton,
            buttonInfo,
            onClose,
            preventCloseOnElementTypes
        };

        // Calculate popup position
        this.positionPopup(popup, anchorButton);

        // Append to document
        document.body.appendChild(popup);

        // Set up close events
        this.setupCloseEvents(popup, () => {
            this.hidePopup(popup, onClose);
        });

        // Set up drag events
        this.setupDragEvents(popup);

        // If resize is enabled, set it up after the popup is fully initialized
        if (enableResize) {
            // Use setTimeout to ensure resize functionality is added after DOM is fully rendered
            setTimeout(() => {
                this.setupResizeEvents(popup);
            }, 0);
        }

        // Return popup element
        return popup;
    }

    /**
     * Clean up all event listeners
     */
    static cleanupAllEventListeners() {
        // Clean up global event listeners
        Object.entries(this.eventHandlers).forEach(([event, handler]) => {
            if (handler) {
                try {
                    if (event === 'focus') {
                        document.removeEventListener(event, handler, true);
                    } else {
                        document.removeEventListener(event, handler);
                    }
                } catch (error) {
                    logger.error(`Failed to remove event listener: ${event}, ${error.message}`);
                }
                this.eventHandlers[event] = null;
            }
        });

        // Restore original selection change event handler
        if (window.app?.canvas && this.activePopup?._originalOnSelectionChange) {
            window.app.canvas.onSelectionChange = this.activePopup._originalOnSelectionChange;
            this.activePopup._originalOnSelectionChange = null;
        }

        // Execute the popup's own cleanup function
        if (this.activePopup && typeof this.activePopup._cleanup === 'function') {
            try {
                this.activePopup._cleanup();
            } catch (error) {
                logger.error(`Failed to execute popup cleanup function: ${error.message}`);
            }
        }

        // Ensure all event handler references are reset
        this.eventHandlers = {
            mousedown: null,
            keydown: null,
            focus: null,
            mousemove: null,
            mouseup: null
        };

        // logger.debug('Popup Manager | Action: Clean up all event listeners');
    }

    /**
     * Set up drag events
     */
    static setupDragEvents(popup) {
        const titleBar = popup.querySelector('.popup_title_bar');
        if (!titleBar) return;

        // Set cursor style to indicate draggable
        titleBar.style.cursor = 'move';

        // Drag-related variables
        let isDragging = false;
        let dragOffset = { x: 0, y: 0 };

        const handleMouseDown = (e) => {
            // If clicking on a button, input, or resize handle, do not start dragging
            if (e.target.closest('.popup_btn') ||
                e.target.closest('.popup_action_btn') ||
                e.target.closest('.popup_resize_handle') ||
                e.target.tagName === 'INPUT' ||
                e.target.closest('input')) {
                return;
            }

            // If clicking on the title bar or title text, allow dragging
            if (e.target.closest('.popup_title') || e.target === titleBar || e.target.closest('.popup_search_container')) {
                e.preventDefault();
                isDragging = true;

                // Add dragging state class
                popup.classList.add('dragging');
                titleBar.classList.add('dragging');

                // Calculate offset between mouse click position and popup top-left corner
                // Force reflow to ensure accurate position information
                void popup.offsetWidth; // Force reflow
                const rect = popup.getBoundingClientRect();
                dragOffset = {
                    x: e.clientX - rect.left,
                    y: e.clientY - rect.top
                };

                // Add styles during dragging
                popup.style.transition = 'none';
                titleBar.style.cursor = 'grabbing';

                // Add temporary global event listeners
                document.addEventListener('mousemove', handleMouseMove, { passive: false });
                document.addEventListener('mouseup', handleMouseUp, { once: true });
            }
        };

        const handleMouseMove = (e) => {
            if (!isDragging) return;

            e.preventDefault();

            // Calculate new position, ensuring it stays within viewport bounds
            const newLeft = Math.max(0, Math.min(
                e.clientX - dragOffset.x,
                window.innerWidth - popup.offsetWidth
            ));
            const newTop = Math.max(0, Math.min(
                e.clientY - dragOffset.y,
                window.innerHeight - popup.offsetHeight
            ));

            // Update popup position
            popup.style.left = `${newLeft}px`;
            popup.style.top = `${newTop}px`;
        };

        const handleMouseUp = () => {
            if (!isDragging) return;

            isDragging = false;

            // Remove dragging state class
            popup.classList.remove('dragging');
            titleBar.classList.remove('dragging');

            titleBar.style.cursor = 'move';
            popup.style.transition = ''; // Restore transition effects

            // Remove temporary event listeners
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };

        // Only add initial mousedown event listener
        titleBar.addEventListener('mousedown', handleMouseDown);

        // Improved cleanup function storage to avoid overwriting
        if (!popup._cleanupFunctions) {
            popup._cleanupFunctions = [];
        }

        popup._cleanupFunctions.push(() => {
            titleBar.removeEventListener('mousedown', handleMouseDown);
            // Ensure cleanup of potentially lingering event listeners
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        });

        // If there's no master cleanup function yet, create one
        if (!popup._cleanup) {
            popup._cleanup = () => {
                if (popup._cleanupFunctions) {
                    popup._cleanupFunctions.forEach(cleanup => cleanup());
                    popup._cleanupFunctions = [];
                }
            };
        }
    }

    /**
     * Set up window resize events
     */
    static setupResizeEvents(popup) {
        // --- Window resize functionality ---
        // Check if resize handle already exists to avoid duplicate creation
        if (popup.querySelector('.popup_resize_handle')) {
            return;
        }

        // Create bottom-right drag handle
        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'popup_resize_handle';

        // Add resize handle icon
        const handleIcon = ResourceManager.getIcon('icon-resize-handle.svg');
        if (handleIcon) {
            resizeHandle.appendChild(handleIcon);
        }

        popup.appendChild(resizeHandle);

        // Force reflow to ensure handle renders correctly
        void resizeHandle.offsetWidth;

        // Window resize related variables
        let isResizing = false;
        let startX, startY, startWidth, startHeight;
        const minWidth = 300; // Minimum width
        const minHeight = 200; // Minimum height

        const handleResizeStart = (e) => {
            // Prevent event bubbling to drag handler
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            isResizing = true;
            startX = e.clientX;
            startY = e.clientY;

            // Force reflow to ensure accurate dimensions
            void popup.offsetWidth;
            const rect = popup.getBoundingClientRect();
            startWidth = rect.width;
            startHeight = rect.height;

            // Add resizing state class
            popup.classList.add('resizing');

            // Disable transition effects
            popup.style.transition = 'none';

            // Prevent text selection
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'nw-resize';

            // Add temporary global event listeners
            document.addEventListener('mousemove', handleResizeMove, { passive: false, capture: true });
            document.addEventListener('mouseup', handleResizeEnd, { once: true, capture: true });

            logger.debug('Started resizing window');
        };

        const handleResizeMove = (e) => {
            if (!isResizing) return;

            e.preventDefault();
            e.stopPropagation();

            // Calculate new dimensions
            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;

            let newWidth = Math.max(minWidth, startWidth + deltaX);
            let newHeight = Math.max(minHeight, startHeight + deltaY);

            // Ensure it does not exceed viewport bounds
            const rect = popup.getBoundingClientRect();
            const maxWidth = window.innerWidth - rect.left - 8;
            const maxHeight = window.innerHeight - rect.top - 8;

            newWidth = Math.min(newWidth, maxWidth);
            newHeight = Math.min(newHeight, maxHeight);

            // Apply new dimensions
            popup.style.width = `${newWidth}px`;
            popup.style.height = `${newHeight}px`;
        };

        const handleResizeEnd = (e) => {
            if (!isResizing) return;

            isResizing = false;

            // Remove resizing state class
            popup.classList.remove('resizing');

            // Restore transition effects
            popup.style.transition = '';

            // Restore default styles
            document.body.style.userSelect = '';
            document.body.style.cursor = '';

            // Remove temporary event listeners
            document.removeEventListener('mousemove', handleResizeMove, { capture: true });
            document.removeEventListener('mouseup', handleResizeEnd, { capture: true });

            // Save tag popup dimensions
            if (popup.classList.contains('tag_popup')) {
                const rect = popup.getBoundingClientRect();
                // Dynamically import TagManager and save dimensions
                import('../modules/tag.js').then(({ TagManager }) => {
                    TagManager.setPopupSize(rect.width, rect.height);
                }).catch(err => {
                    logger.error(`Failed to save window size: ${err.message}`);
                });
            }

            logger.debug('Finished resizing window');
        };

        // Add initial mousedown event listener, using capture mode to ensure priority handling
        resizeHandle.addEventListener('mousedown', handleResizeStart, { capture: true });

        // Add hover effect to improve visibility
        resizeHandle.addEventListener('mouseenter', () => {
            resizeHandle.style.opacity = '1';
        });

        resizeHandle.addEventListener('mouseleave', () => {
            if (!isResizing) {
                resizeHandle.style.opacity = '0.7';
            }
        });

        // Improved cleanup function storage to avoid overwriting
        if (!popup._cleanupFunctions) {
            popup._cleanupFunctions = [];
        }

        popup._cleanupFunctions.push(() => {
            resizeHandle.removeEventListener('mousedown', handleResizeStart, { capture: true });
            resizeHandle.removeEventListener('mouseenter', () => { });
            resizeHandle.removeEventListener('mouseleave', () => { });
            // Ensure cleanup of potentially lingering event listeners
            document.removeEventListener('mousemove', handleResizeMove, { capture: true });
            document.removeEventListener('mouseup', handleResizeEnd, { capture: true });

            // Restore default styles
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
        });

        // If there's no master cleanup function yet, create one
        if (!popup._cleanup) {
            popup._cleanup = () => {
                if (popup._cleanupFunctions) {
                    popup._cleanupFunctions.forEach(cleanup => cleanup());
                    popup._cleanupFunctions = [];
                }
            };
        }

        // logger.debug('Window resize functionality enabled');
    }

    /**
     * Position popup
     */
    static positionPopup(popup, anchorButton) {
        try {
            const buttonRect = anchorButton.getBoundingClientRect();
            const viewportHeight = window.innerHeight;
            const viewportWidth = window.innerWidth;

            // Set initial display to get dimensions
            popup.style.visibility = 'hidden';
            popup.style.display = 'flex'; // Use flex layout
            popup.style.flexDirection = 'column';
            document.body.appendChild(popup);

            // Force reflow to ensure accurate dimensions
            void popup.offsetWidth;
            const popupRect = popup.getBoundingClientRect();
            document.body.removeChild(popup);
            popup.style.visibility = 'visible';

            // Calculate vertical position
            const spaceAbove = buttonRect.top;
            const spaceBelow = viewportHeight - buttonRect.bottom;
            const showBelow = spaceBelow >= popupRect.height || spaceBelow > spaceAbove;

            // Set vertical position
            if (showBelow) {
                popup.style.top = `${buttonRect.bottom}px`;
                popup.classList.remove('popup-up');
                popup.classList.add('popup-down');
            } else {
                popup.style.top = `${buttonRect.top - popupRect.height}px`;
                popup.classList.remove('popup-down');
                popup.classList.add('popup-up');
            }

            // Calculate horizontal position
            const buttonCenterX = buttonRect.left + buttonRect.width / 2;
            const centeredLeftEdge = buttonCenterX - popupRect.width / 2;
            const centeredRightEdge = buttonCenterX + popupRect.width / 2;
            const canCenterHorizontally = centeredLeftEdge >= 0 && centeredRightEdge <= viewportWidth;

            if (showBelow) {
                // When showing below, still center horizontally
                if (canCenterHorizontally) {
                    popup.style.left = `${centeredLeftEdge}px`;
                } else if (centeredLeftEdge < 0) {
                    popup.style.left = '8px';
                } else {
                    popup.style.left = `${viewportWidth - popupRect.width - 8}px`;
                }
            } else {
                // When showing above, left-align (popup left edge aligns with button left edge), but ensure it doesn't exceed right or left bounds
                let left = buttonRect.left;
                if (left + popupRect.width > viewportWidth - 8) {
                    left = viewportWidth - popupRect.width - 8;
                }
                if (left < 8) {
                    left = 8;
                }
                popup.style.left = `${left}px`;
            }
        } catch (error) {
            logger.error(`Popup | Position calculation failed | Error: ${error.message}`);
        }
    }

    /**
     * Set up close events
     */
    static setupCloseEvents(popup, onClose) {
        // Clean up previous event listeners
        this.cleanupAllEventListeners();

        // Save original selection change event handler
        if (window.app?.canvas) {
            popup._originalOnSelectionChange = window.app.canvas.onSelectionChange;

            // Override selection change event handler
            window.app.canvas.onSelectionChange = (...args) => {
                // If popup no longer exists, restore original handler
                if (!popup.isConnected) {
                    if (popup._originalOnSelectionChange) {
                        window.app.canvas.onSelectionChange = popup._originalOnSelectionChange;
                    }
                    return;
                }

                // Call original handler
                if (popup._originalOnSelectionChange) {
                    popup._originalOnSelectionChange.apply(window.app.canvas, args);
                }

                // Get currently focused element
                const activeElement = document.activeElement;

                // Check if a tag-related input has focus
                const preventCloseTypes = this.activePopupInfo?.preventCloseOnElementTypes || [];
                const isSpecialInput = activeElement &&
                    preventCloseTypes.some(type => {
                        return activeElement.classList.contains(type) ||
                            activeElement.closest(`.${type}`) !== null;
                    });

                // Check if it is a target input
                const isTargetInput = activeElement && (
                    activeElement.classList.contains('comfy-multiline-input') ||
                    activeElement.closest('.comfy-multiline-input') !== null ||
                    activeElement.closest('.comfy-markdown') !== null ||
                    activeElement.closest('.widget-markdown') !== null ||
                    activeElement.closest('.tiptap') !== null ||
                    activeElement.closest('.ProseMirror') !== null
                );

                // Check if it is the current node's input
                const isCurrentNodeInput = this.activePopupInfo?.buttonInfo?.widget &&
                    Object.values(window.PromptAssistantInputWidgetMap || {}).some(mapping => {
                        return (mapping.inputEl === activeElement || mapping.inputEl?.contains(activeElement)) &&
                            mapping.widget === this.activePopupInfo.buttonInfo.widget;
                    });

                // Only prevent closing when it's a special input or current node's input
                if (isSpecialInput || isCurrentNodeInput || isTargetInput) {
                    logger.debug('Popup | Keeping open | Reason: ' + (isSpecialInput ? 'Special input focused' : (isCurrentNodeInput ? 'Current node input focused' : 'Target input focused')));
                    return;
                }

                // Otherwise close the popup
                if (typeof onClose === 'function') {
                    onClose();
                }
            };
        }

        // Record mouse click time to avoid double-click issues
        popup._lastClickTime = 0;

        // Click outside to close
        const handleOutsideClick = (e) => {
            // If popup no longer exists, remove event listener
            if (!popup.isConnected) {
                document.removeEventListener('mousedown', handleOutsideClick);
                return;
            }

            // Prevent issues caused by rapid consecutive clicks
            const now = Date.now();
            if (now - popup._lastClickTime < 200) {
                return;
            }
            popup._lastClickTime = now;

            // Check if click target is inside popup or is the trigger button
            const isInPopup = popup.contains(e.target);
            const isInButton = e.target.closest('.prompt-assistant-button');
            const isInActiveButton = this.activePopupInfo?.anchorButton === e.target ||
                this.activePopupInfo?.anchorButton?.contains(e.target);

            // Check if the clicked element type should prevent closing
            const preventCloseTypes = this.activePopupInfo?.preventCloseOnElementTypes || [];
            const isPreventCloseElement = preventCloseTypes.some(className => {
                return e.target.classList.contains(className) ||
                    e.target.closest(`.${className}`) !== null;
            });

            // Check if clicking on a context menu, confirm popup, or settings dialog
            const isContextMenu = e.target.closest('.pa-context-menu') || e.target.closest('.pa-confirm-popup');
            const isSettingsModal = e.target.closest('.settings-modal') || e.target.closest('.settings-modal-overlay');
            if (isContextMenu || isSettingsModal) return;

            // Check if clicking on a target input
            const isTargetInput = e.target.classList.contains('comfy-multiline-input') ||
                e.target.closest('.comfy-multiline-input') !== null ||
                e.target.closest('.comfy-markdown') !== null ||
                e.target.closest('.widget-markdown') !== null ||
                e.target.closest('.tiptap') !== null ||
                e.target.closest('.ProseMirror') !== null;

            // Check if it is the current node's input
            const isCurrentNodeInput = this.activePopupInfo?.buttonInfo?.widget &&
                Object.values(window.PromptAssistantInputWidgetMap || {}).some(mapping => {
                    return (mapping.inputEl === e.target || mapping.inputEl?.contains(e.target)) &&
                        mapping.widget === this.activePopupInfo.buttonInfo.widget;
                });

            // If click is outside popup, not on active button, not on prevent-close element, and not on current node's input/target input, close the popup
            if (!isInPopup && !(isInButton && isInActiveButton) &&
                !isPreventCloseElement && !isCurrentNodeInput && !isTargetInput) {
                if (typeof onClose === 'function') {
                    onClose();
                }
            }
        };

        // Add focus event listener to prevent tag-related input focus from closing the popup
        const handleFocus = (e) => {
            // If popup no longer exists, remove event listener
            if (!popup.isConnected) {
                document.removeEventListener('focus', handleFocus, true);
                return;
            }

            const preventCloseTypes = this.activePopupInfo?.preventCloseOnElementTypes || [];
            const isSpecialInput = preventCloseTypes.some(type => {
                return e.target.classList.contains(type) ||
                    e.target.closest(`.${type}`) !== null;
            });

            // Check if it is the current node's input
            const isCurrentNodeInput = this.activePopupInfo?.buttonInfo?.widget &&
                Object.values(window.PromptAssistantInputWidgetMap || {}).some(mapping => {
                    return (mapping.inputEl === e.target || mapping.inputEl?.contains(e.target)) &&
                        mapping.widget === this.activePopupInfo.buttonInfo.widget;
                });

            // Only prevent closing when a special input or current node's input gains focus
            if (isSpecialInput || isCurrentNodeInput) {
                e.stopPropagation();
                logger.debug('Popup | Preventing close | Reason: ' + (isSpecialInput ? 'Special input focused' : 'Current node input focused'));
            }
        };

        // ESC key to close
        const handleEscKey = (e) => {
            // If popup no longer exists, remove event listener
            if (!popup.isConnected) {
                document.removeEventListener('keydown', handleEscKey);
                return;
            }

            if (e.key === 'Escape') {
                // If settings dialog exists, don't close the tag popup (let settings dialog handle ESC)
                const settingsModal = document.querySelector('.settings-modal');
                if (settingsModal) return;

                if (typeof onClose === 'function') {
                    onClose();
                }
            }
        };

        // Save event handler references
        this.eventHandlers.mousedown = handleOutsideClick;
        this.eventHandlers.keydown = handleEscKey;
        this.eventHandlers.focus = handleFocus;

        // Ensure removal of potentially existing old event listeners
        try {
            document.removeEventListener('mousedown', this.eventHandlers.mousedown);
            document.removeEventListener('keydown', this.eventHandlers.keydown);
            document.removeEventListener('focus', this.eventHandlers.focus, true);
        } catch (error) {
            // Ignore possible errors
        }

        // Add event listeners
        document.addEventListener('mousedown', handleOutsideClick);
        document.addEventListener('keydown', handleEscKey);
        document.addEventListener('focus', handleFocus, true); // Use capture mode

        // Save cleanup function to popup instance
        popup._cleanup = () => {
            document.removeEventListener('mousedown', handleOutsideClick);
            document.removeEventListener('keydown', handleEscKey);
            document.removeEventListener('focus', handleFocus, true);

            // Restore original selection change event handler
            if (window.app?.canvas && popup._originalOnSelectionChange) {
                window.app.canvas.onSelectionChange = popup._originalOnSelectionChange;
                popup._originalOnSelectionChange = null;
            }
        };

        // logger.debug('Popup Manager | Action: Set up close events');
    }

    /**
     * Hide popup
     */
    static hidePopup(popup, onClose) {
        if (!popup) return;

        // If this is the currently active popup, clear references
        if (this.activePopup === popup) {
            // Save info for callback below
            const popupInfo = this.activePopupInfo;

            // Execute the popup's own cleanup function
            if (popup._cleanup && typeof popup._cleanup === 'function') {
                try {
                    popup._cleanup();
                    popup._cleanup = null; // Prevent duplicate calls
                } catch (error) {
                    logger.error(`Failed to execute popup cleanup function: ${error.message}`);
                }
            }

            // Clear active popup reference
            this.activePopup = null;
            this.activePopupInfo = null;

            // Clean up all event listeners
            this.cleanupAllEventListeners();

            // Reset central button state
            if (popupInfo && popupInfo.buttonInfo) {
                const { widget, buttonId } = popupInfo.buttonInfo;
                // Force reset regardless of button state
                UIToolkit.setActiveButton(null);
                // Force update visibility for all instances
                promptAssistant.updateAllInstancesVisibility();
                // Force update current widget's state
                if (widget) {
                    promptAssistant.updateAssistantVisibility(widget);
                }
            }

            // Even without buttonInfo, try to update all instance states
            if (!popupInfo || !popupInfo.buttonInfo) {
                UIToolkit.setActiveButton(null);
                promptAssistant.updateAllInstancesVisibility();
            }

            // Execute close callback
            if (typeof onClose === 'function') {
                try {
                    onClose();
                } catch (error) {
                    logger.error(`Failed to execute close callback: ${error.message}`);
                }
            }
        }

        // Add closing animation
        const isPopupUp = popup.classList.contains('popup-up');
        popup.classList.add(isPopupUp ? 'popup-closing-up' : 'popup-closing-down');

        // Remove element after animation ends
        return new Promise(resolve => {
            setTimeout(() => {
                if (popup.parentNode) {
                    popup.parentNode.removeChild(popup);
                }
                resolve();
            }, 200);
        });
    }

    /**
     * Close all open popups
     */
    static async closeAllPopups() {
        if (this.activePopup) {
            // Save current active popup info
            const popupInfo = this.activePopupInfo;
            const activePopup = this.activePopup;

            // Execute the popup's own cleanup function
            if (activePopup._cleanup && typeof activePopup._cleanup === 'function') {
                try {
                    activePopup._cleanup();
                    activePopup._cleanup = null; // Prevent duplicate calls
                } catch (error) {
                    logger.error(`Failed to execute popup cleanup function: ${error.message}`);
                }
            }

            // Clear active popup reference
            this.activePopup = null;
            this.activePopupInfo = null;

            // Clean up all event listeners
            this.cleanupAllEventListeners();

            // Reset central button state
            if (popupInfo && popupInfo.buttonInfo) {
                const { widget, buttonId } = popupInfo.buttonInfo;
                // Force reset regardless of button state
                UIToolkit.setActiveButton(null);
                // Force update visibility for all instances
                promptAssistant.updateAllInstancesVisibility();
                // Force update current widget's state
                if (widget) {
                    promptAssistant.updateAssistantVisibility(widget);
                }
            }

            // Even without buttonInfo, try to update all instance states
            if (!popupInfo || !popupInfo.buttonInfo) {
                UIToolkit.setActiveButton(null);
                promptAssistant.updateAllInstancesVisibility();
            }

            // Execute close callback
            if (popupInfo && popupInfo.onClose) {
                try {
                    popupInfo.onClose();
                } catch (error) {
                    logger.error(`Failed to execute close callback: ${error.message}`);
                }
            }
        }

        // Get all popups
        const popups = document.querySelectorAll('.popup_container');
        const closePromises = [];

        // Add closing animation to all popups
        popups.forEach(popup => {
            // Execute the popup's own cleanup function
            if (popup._cleanup && typeof popup._cleanup === 'function') {
                try {
                    popup._cleanup();
                    popup._cleanup = null; // Prevent duplicate calls
                } catch (error) {
                    logger.error(`Failed to execute popup cleanup function: ${error.message}`);
                }
            }

            const isPopupUp = popup.classList.contains('popup-up');
            popup.classList.add(isPopupUp ? 'popup-closing-up' : 'popup-closing-down');

            // Add to Promise array
            closePromises.push(new Promise(resolve => {
                setTimeout(() => {
                    if (popup.parentNode) {
                        popup.parentNode.removeChild(popup);
                    }
                    resolve();
                }, 200);
            }));
        });

        // Wait for all popups to finish closing
        await Promise.all(closePromises);

        logger.debug('Popup Manager | Action: Close all popups');
    }

    /**
     * Write content to input field
     */
    static writeToInput(content, nodeId, inputId) {
        return UIToolkit.writeToInput(content, nodeId, inputId, { highlight: true, focus: false });
    }

    /**
     * Insert content at cursor position
     */
    static insertAtCursor(content, nodeId, inputId) {
        return UIToolkit.insertAtCursor(content, nodeId, inputId, { highlight: true });
    }
}

export { PopupManager };