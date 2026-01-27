/**
 * UI Toolkit
 * Provides common UI utility functions shared across modules
 */

import { logger } from './logger.js';
import { ResourceManager } from "./resourceManager.js";
import { APIService } from "../services/api.js";

class UIToolkit {
    // Central button state manager - tracks the active button
    static #activeButtonInfo = null; // {widget, buttonId, popupInstance}

    // Status tip manager - tracks the status tip element for each button
    static #statusTips = new Map(); // Map<buttonElement, tipElement>

    // Supported input field IDs
    static VALID_INPUT_IDS = ["text", "text_positive", "text_negative", "text_g", "text_l"];

    // Status text management
    static STATUS_TEXTS = {
        translate: {
            loading: 'Translating',
            // success: (from, to) => `Translation complete (${from} → ${to})`,
            success: (from, to) => 'Translation complete',
            error: (msg) => msg || 'Translation failed'
        },
        expand: {
            loading: 'Optimizing prompt',
            success: 'Prompt optimization complete',
            error: (msg) => msg || 'Prompt optimization failed'
        }
    };

    /**
     * Check if the input widget is a valid text input
     * Supports traditional litegraph mode and Vue node2.0 mode
     */
    static isValidInput(widget, options = {}) {
        const { debug = false, node = null } = options;
        let isValid = false;
        let reason = '';

        // Method 1: Standard text input widget (traditional litegraph mode)
        if (widget.inputEl && widget.inputEl.tagName === "TEXTAREA" &&
            this.VALID_INPUT_IDS.includes(widget.name)) {
            isValid = true;
            reason = 'litegraph textarea matched';
        }
        // Method 2: Note node special input
        else if (widget.element && widget.element.tagName === "TEXTAREA") {
            isValid = true;
            reason = 'Note textarea matched';
        }
        // Method 3: Markdown Note node special input (Tiptap editor)
        else if (this.isMarkdownNoteInput(widget)) {
            isValid = true;
            reason = 'Markdown Note matched';
        }
        // Method 4: Vue node2.0 mode detection - determined by node type
        else if (this._isVueNodesModeWidget(widget, node)) {
            isValid = true;
            reason = 'Vue node2.0 mode widget';
        }

        // ---Visibility check fallback---
        // If basic detection passed but the element itself is hidden, treat as invalid
        if (isValid) {
            const element = widget.inputEl || widget.element;
            if (element && !this.isElementVisible(element)) {
                isValid = false;
                reason += ' (but element is hidden)';
            }
        }

        if (debug) {
            const widgetName = widget.name || widget.id || 'unknown';
            const nodeType = node?.type || widget.node?.type || 'unknown';
            logger.debug(`[isValidInput] Widget: ${widgetName} | Node type: ${nodeType} | Valid: ${isValid} | Reason: ${reason}`);
        }

        return isValid;
    }

    /**
     * Check if the widget is a valid text widget in Vue node2.0 mode
     * In Vue mode, the widget object may lack inputEl/element, but node type can determine validity
     */
    static _isVueNodesModeWidget(widget, node = null) {
        // Get node reference
        const nodeRef = node || widget.node;
        if (!nodeRef) return false;

        // Check if in Vue node mode
        if (typeof LiteGraph !== 'undefined' && LiteGraph.vueNodesMode !== true) {
            return false;
        }

        // Known supported node types
        const supportedNodeTypes = [
            'Note',
            'MarkdownNote',
            'PreviewAny',       // Preview as Text node (actual type)
            'PreviewTextNode',  // Possible alternative name for Preview node
            'Show any [Crystools]',
            // Add other supported node types
        ];

        // Check node type
        if (supportedNodeTypes.includes(nodeRef.type)) {
            return true;
        }

        // Check if widget name is a valid input
        if (this.VALID_INPUT_IDS.includes(widget.name)) {
            return true;
        }

        // Markdown type node detection (including Preview as Text and other nodes using comfy-markdown)
        const typeLower = nodeRef.type?.toLowerCase() || '';
        if (typeLower.includes('markdown') ||
            (typeLower.includes('preview') && typeLower.includes('text'))) {
            return true;
        }

        return false;
    }

    /**
     * Check if the input is a node using comfy-markdown
     * Includes MarkdownNote, Preview as Text, and other nodes using Tiptap/ProseMirror editor
     */
    static isMarkdownNoteInput(widget) {
        // Method 1: Check node type
        const nodeRef = widget.node;
        if (nodeRef) {
            // Supported node types using comfy-markdown
            const markdownNodeTypes = ['MarkdownNote', 'PreviewAny', 'PreviewTextNode'];
            if (markdownNodeTypes.includes(nodeRef.type)) {
                return true;
            }

            // Check if node type name contains relevant keywords
            const typeLower = nodeRef.type?.toLowerCase() || '';
            if (typeLower.includes('markdown') ||
                (typeLower.includes('preview') && typeLower.includes('text'))) {
                return true;
            }
        }

        // Method 2: Check widget name (Vue mode may only have name)
        if (widget.name === 'text' && nodeRef && nodeRef.type?.toLowerCase().includes('markdown')) {
            return true;
        }

        // Method 3: Detect through DOM structure
        let element = widget.element || widget.inputEl;
        if (!element) return false;

        // Search upward for .comfy-markdown container
        let parent = element.parentElement;
        while (parent) {
            if (parent.classList && parent.classList.contains('comfy-markdown')) {
                return true;
            }
            // Detect widget-markdown class in Vue mode
            if (parent.classList && parent.classList.contains('widget-markdown')) {
                return true;
            }
            parent = parent.parentElement;
        }

        // Check if element itself is a Tiptap editor
        if (element.classList &&
            (element.classList.contains('tiptap') || element.classList.contains('ProseMirror'))) {
            return true;
        }

        return false;
    }

    /**
     * Get Tiptap editor instance for Markdown Note
     * @param {HTMLElement} element - Input element or related element
     * @returns {Object|null} Tiptap editor instance, or null if not found
     */
    static getMarkdownNoteEditor(element) {
        if (!element) return null;

        // Find .comfy-markdown container
        let container = element;
        if (!container.classList || !container.classList.contains('comfy-markdown')) {
            container = element.closest('.comfy-markdown');
        }

        if (!container) return null;

        // Find Tiptap editor element
        const editorElement = container.querySelector('.tiptap.ProseMirror, .ProseMirror.tiptap');
        if (!editorElement) return null;

        // Try to get Tiptap editor instance from element
        // Tiptap usually stores editor instance in an element property
        if (editorElement.__tiptap_editor) {
            return editorElement.__tiptap_editor;
        }

        // Try to find from global or parent element
        if (container.__tiptap_editor) {
            return container.__tiptap_editor;
        }

        // If instance not found, return editor element itself for later DOM operation
        return {
            element: editorElement,
            getHTML: () => editorElement.innerHTML,
            getText: () => editorElement.textContent || editorElement.innerText,
            setContent: (content) => {
                if (editorElement.__tiptap_editor) {
                    editorElement.__tiptap_editor.commands.setContent(content);
                } else {
                    // Fallback: directly operate DOM
                    editorElement.innerHTML = content;
                    // Trigger update event
                    editorElement.dispatchEvent(new Event('input', { bubbles: true }));
                    editorElement.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        };
    }

    /**
     * Show status tip
     */
    static showStatusTip(anchorElement, type, message, position = null) {
        // Remove old tip from same button
        this.removeStatusTip(anchorElement);

        // Create tip element
        const tipElement = document.createElement('div');
        tipElement.className = `statustip ${type}`;
        tipElement.textContent = message;
        document.body.appendChild(tipElement);

        // Set position and style
        const { posX, posY } = this._calculateTipPosition(anchorElement, position);
        tipElement.style.left = `${posX}px`;
        tipElement.style.top = `${posY}px`;

        // Adjust transform based on position type
        if (position === 'top') {
            tipElement.style.transform = 'translate(-50%, -100%) translateY(-12px)';
        } else {
            tipElement.style.transform = 'translate(-50%, -100%) translateY(-8px)';
        }

        tipElement.classList.add('statustip-show');

        // Record tip element
        this.#statusTips.set(anchorElement, tipElement);

        // Set auto-dismiss
        this._setupTipAutoHide(tipElement, anchorElement);

        return tipElement;
    }

    /**
     * Remove status tip for specified button
     */
    static removeStatusTip(anchorElement) {
        const existingTip = this.#statusTips.get(anchorElement);
        if (existingTip) {
            // Remove animation class
            existingTip.classList.remove('statustip-show');
            // Remove element immediately
            existingTip.parentNode?.removeChild(existingTip);
            // Remove record from manager
            this.#statusTips.delete(anchorElement);
        }
    }

    /**
     * Calculate tip bubble position
     */
    static _calculateTipPosition(anchorElement, position) {
        let posX, posY;

        if (typeof position === 'object' && position !== null) {
            // If position is an object, use its x,y values directly
            posX = position.x;
            posY = position.y;
        } else if (position === 'top') {
            // If position is 'top', place tip above element center
            const rect = anchorElement.getBoundingClientRect();
            posX = rect.left + rect.width / 2;
            posY = rect.top;
        } else {
            // Default case, use element position
            const rect = anchorElement.getBoundingClientRect();
            posX = rect.left + rect.width / 2;
            posY = rect.top;
        }

        return { posX, posY };
    }

    /**
     * Set tip auto-hide
     */
    static _setupTipAutoHide(tipElement, anchorElement) {
        // Increase display time to 2 seconds
        setTimeout(() => {
            // Check if tip still exists
            if (this.#statusTips.get(anchorElement) === tipElement) {
                tipElement.classList.remove('statustip-show');
                tipElement.classList.add('statustip-hide');

                setTimeout(() => {
                    // Check again if tip still exists
                    if (this.#statusTips.get(anchorElement) === tipElement) {
                        tipElement.parentNode?.removeChild(tipElement);
                        this.#statusTips.delete(anchorElement);
                    }
                }, 400); // This is the tip fade-out animation duration
            }
        }, 1000); // Display for 1 second
    }

    /**
     * Add icon to button
     * @param {HTMLElement} button Button element
     * @param {string} icon Icon name, supports SVG or PrimeIcons, e.g. 'icon-history.svg' or 'pi-times'
     * @param {string} alt Alternative text
     */
    static addIconToButton(button, icon, alt) {
        if (!icon) return;

        try {
            button.innerHTML = '';

            // Check if it's a PrimeIcon
            if (icon.startsWith('pi-')) {
                const iconSpan = document.createElement('span');
                iconSpan.className = `pi ${icon}`;
                iconSpan.title = alt || '';
                button.appendChild(iconSpan);
                return;
            }

            // Get icon name (ensure .svg suffix)
            const iconName = icon.endsWith('.svg') ? icon : `${icon}.svg`;

            // Get icon from ResourceManager
            const cachedImg = ResourceManager.getIcon(iconName);
            if (cachedImg) {
                button.appendChild(cachedImg);
                cachedImg.alt = alt || '';
                cachedImg.draggable = false;
            } else {
                logger.warn(`Icon load | Result: Failed | Icon: ${icon}, Reason: Cache not found`);
            }
        } catch (error) {
            logger.warn(`Icon load | Result: Failed | Icon: ${icon}, Error: ${error.message}`);
        }
    }

    /**
     * Check if element is visible
     */
    static isElementVisible(element) {
        return element &&
            element.style.display !== 'none' &&
            element.style.visibility !== 'hidden';
    }

    /**
     * Create and add DOM element
     */
    static createElement(tagName, props = {}, parent = null) {
        const element = document.createElement(tagName);

        // Set attributes
        Object.entries(props).forEach(([key, value]) => {
            if (key === 'className') {
                element.className = value;
            } else if (key === 'style') {
                Object.assign(element.style, value);
            } else if (key === 'content') {
                element.textContent = value;
            } else {
                element[key] = value;
            }
        });

        // Add to parent element
        if (parent) {
            parent.appendChild(element);
        }

        return element;
    }

    // ====================== Button State Management ======================

    /**
     * Get current active button info
     */
    static getActiveButtonInfo() {
        return this.#activeButtonInfo;
    }

    /**
     * Set current active button info
     */
    static setActiveButton(buttonInfo) {
        // If old and new button info are the same, do nothing
        if (this.#activeButtonInfo && buttonInfo &&
            this.#activeButtonInfo.widget === buttonInfo.widget &&
            this.#activeButtonInfo.buttonId === buttonInfo.buttonId) {
            return;
        }

        // Clean up old active button state
        if (this.#activeButtonInfo) {
            const oldInfo = this.#activeButtonInfo;
            // Reset old button state
            this.setButtonState(oldInfo.widget, oldInfo.buttonId, 'active', false);
            // logger.debug(`Button state reset | Button:${oldInfo.buttonId} | Node:${oldInfo.widget.nodeId}`);
        }

        // Set new active button
        this.#activeButtonInfo = buttonInfo;

        // If there's new button info, set its state to active
        if (buttonInfo) {
            this.setButtonState(buttonInfo.widget, buttonInfo.buttonId, 'active', true);
            // logger.debug(`Button activated | Button:${buttonInfo.buttonId} | Node:${buttonInfo.widget.nodeId}`);
        }
    }

    /**
     * Check if button is currently active
     */
    static isActiveButton(widget, buttonId) {
        return this.#activeButtonInfo &&
            this.#activeButtonInfo.widget === widget &&
            this.#activeButtonInfo.buttonId === buttonId;
    }

    /**
     * Handle popup-related button click
     */
    static handlePopupButtonClick(e, widget, buttonId, showPopupFn, hidePopupFn) {
        e.preventDefault();
        e.stopPropagation();

        // logger.debug(`Popup button click | Button: ${buttonId} | Node: ${widget.nodeId}`);

        // Check current button state
        const isCurrentActive = this.isActiveButton(widget, buttonId);

        // If current button is active, close popup
        if (isCurrentActive) {
            // Reset button state and hide popup
            this.setActiveButton(null);
            hidePopupFn();
            return;
        }

        // Set new active button state
        const buttonInfo = {
            widget,
            buttonId,
            timestamp: Date.now()
        };

        // **Do not** set active button here, let popup manager set it after cleaning up other windows
        // this.setActiveButton(buttonInfo);

        // Show popup
        showPopupFn({
            anchorButton: e.currentTarget,
            nodeId: widget.nodeId,
            inputId: widget.inputId,
            buttonInfo: buttonInfo,
            onClose: () => {
                // When popup closes, reset if current button is still active
                if (this.isActiveButton(widget, buttonId)) {
                    this.setActiveButton(null);
                }

                // Ensure button state returns to default
                this.setButtonState(widget, buttonId, 'active', false);

                // Trigger additional callback
                if (typeof widget.onPopupClosed === 'function') {
                    widget.onPopupClosed(buttonId);
                }
            }
        });
    }

    /**
     * Get button current state
     */
    static getButtonState(widget, buttonId) {
        if (!widget || !widget.buttons || !widget.buttons[buttonId]) {
            logger.error(`Button state get | Result: Failed | Reason: Button not found | ButtonID:${buttonId}`);
            return null;
        }

        const button = widget.buttons[buttonId];

        return {
            active: button.classList.contains('button-active'),
            processing: button.classList.contains('button-processing'),
            disabled: button.classList.contains('button-disabled')
        };
    }

    /**
     * Set button state
     */
    static setButtonState(widget, buttonId, stateType, value = true) {
        try {
            const button = widget.buttons[buttonId];
            if (!button) return;

            const stateClass = `button-${stateType}`;

            if (value) {
                button.classList.add(stateClass);
                // If disabled, add disabled attribute
                if (stateType === 'disabled') {
                    button.setAttribute('disabled', 'disabled');
                }
            } else {
                button.classList.remove(stateClass);
                // If un-disabling, remove disabled attribute
                if (stateType === 'disabled') {
                    button.removeAttribute('disabled');
                }
            }

            // Update button clickable state
            this._updateButtonClickability(button);

        } catch (error) {
            logger.error(`Button state | Set failed | Button:${buttonId} | State:${stateType} | Error:${error.message}`);
        }
    }

    /**
     * Update button clickable state
     */
    static _updateButtonClickability(button) {
        // Check if button is in disabled state
        const isDisabled = button.classList.contains('button-disabled');

        if (isDisabled) {
            // If button is disabled, prevent click event
            button.style.pointerEvents = 'none';
        } else {
            // All other cases (including processing) allow clicking,
            // Specific actions determined by event listener internal logic
            button.style.pointerEvents = 'auto';
        }
    }

    /**
     * Reset button state
     */
    static resetButtonState(widget, buttonId = null) {
        try {
            const resetButton = (button, id) => {
                if (button) {
                    // Remove all state classes
                    button.classList.remove('button-active', 'button-processing', 'button-disabled');
                    // Remove disabled attribute
                    button.removeAttribute('disabled');
                    // Restore click events
                    button.style.pointerEvents = 'auto';
                }
            };

            if (buttonId) {
                // Reset specified button
                const button = widget.buttons[buttonId];
                resetButton(button, buttonId);
            } else {
                // Reset all buttons
                Object.entries(widget.buttons).forEach(([id, button]) => {
                    resetButton(button, id);
                });
            }
        } catch (error) {
            logger.error(`Button state | Reset failed | Button:${buttonId || 'all'} | Error:${error.message}`);
        }
    }

    /**
     * Update undo/redo button state
     */
    static updateUndoRedoButtonState(widget, LocalHistoryService) {
        // Update undo button state
        const undoButton = widget.buttons['undo'];
        if (undoButton) {
            const canUndo = LocalHistoryService.canUndo(widget.nodeId, widget.inputId);
            this.setButtonState(widget, 'undo', 'disabled', !canUndo);
        }

        // Update redo button state
        const redoButton = widget.buttons['redo'];
        if (redoButton) {
            const canRedo = LocalHistoryService.canRedo(widget.nodeId, widget.inputId);
            this.setButtonState(widget, 'redo', 'disabled', !canRedo);
        }
    }

    /**
     * Handle button click operation
     */
    static handleButtonOperation(e, widget, buttonId, operation, LocalHistoryService) {
        e.preventDefault();
        e.stopPropagation();

        // Get button state
        const state = this.getButtonState(widget, buttonId);

        // If button is disabled or processing, don't execute operation
        if (!state || state.disabled || state.processing) {
            logger.debug(`Button op | Result: Skipped | Button:${buttonId} | Reason:${state.disabled ? 'Disabled' : 'Processing'}`);
            return;
        }

        // Set button to processing state
        this.setButtonState(widget, buttonId, 'processing', true);
        // logger.debug(`Button op | Action: Start | Button:${buttonId}`);

        // Execute operation (receives a callback for post-operation logic)
        try {
            const callback = (success = true, error = null) => {
                // Reset button state
                this.setButtonState(widget, buttonId, 'processing', false);

                // If operation succeeds with result, write to history
                if (success && widget.inputEl && widget.inputEl.value) {
                    // Add to history
                    // logger.debug(`Preparing to write history｜ ${buttonId}Operation complete｜ node_id=${widget.nodeId}`);
                    LocalHistoryService.addHistory({
                        workflow_id: '',
                        node_id: widget.nodeId,
                        input_id: widget.inputId,
                        content: widget.inputEl.value,
                        operation_type: buttonId, // Use button ID as operation type
                    });
                }

                if (error) {
                    logger.error(`Button op complete | Result: Failed | Button:${buttonId} | Error:${error}`);
                    this.showStatusTip(
                        e.currentTarget,
                        'error',
                        `Operation failed: ${error?.message || 'Unknown error'}`,
                        null
                    );
                } else {
                    // logger.debug(`Button op complete | Result:${success ? 'Success' : 'Failed'} | Button:${buttonId}`);
                    this.showStatusTip(
                        e.currentTarget,
                        'success',
                        `${e.currentTarget.title || buttonId} Operation complete`,
                        null
                    );
                }
            };

            // Execute operation and pass callback
            // logger.debug(`History cache | Button operation ready to execute node_id=${widget.nodeId} input_id=${widget.inputId} type=${buttonId}`);
            operation(callback);
        } catch (error) {
            // Reset button state when exception occurs
            this.setButtonState(widget, buttonId, 'processing', false);
            logger.error(`Button op | Result: Exception | Button:${buttonId} | Error:${error.message}`);
            this.showStatusTip(
                e.currentTarget,
                'error',
                `Operation exception: ${error.message}`,
                null
            );
        }
    }

    /**
     * Handle button click
     * Show status tip message
     */
    static handleButtonClick(e, widget, message, type) {
        const btnRect = e.target.getBoundingClientRect();
        this.showStatusTip(
            e.target,
            type,
            message,
            { x: btnRect.left + btnRect.width / 2, y: btnRect.top }
        );
    }

    /**
     * Write content to input
     */
    static writeToInput(content, nodeId, inputId, options = { highlight: true, focus: false }) {
        const mappingKey = `${nodeId}_${inputId}`;
        const mapping = window.PromptAssistantInputWidgetMap?.[mappingKey];

        if (mapping && mapping.inputEl) {
            const inputEl = mapping.inputEl;

            // Check if Markdown Note
            const editor = this.getMarkdownNoteEditor(inputEl);
            if (editor) {
                // Write content using Tiptap editor
                editor.setContent(content);

                // Add highlight effect (to editor element)
                if (options.highlight && editor.element) {
                    this._highlightInput(editor.element);
                }

                // Focus editor
                if (options.focus && editor.element) {
                    editor.element.focus();
                }

                logger.debug(`Content write | Result: Success | Node:${nodeId} | Input:${inputId} | Type: Markdown Note`);
                return true;
            }

            // Standard input handling
            // Write content to input
            inputEl.value = content;

            // Trigger input event to ensure UI and data sync
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            inputEl.dispatchEvent(new Event('change', { bubbles: true }));

            // Add highlight effect
            if (options.highlight) {
                this._highlightInput(inputEl);
            }

            // Focus input
            if (options.focus) {
                inputEl.focus();
            }

            logger.debug(`Content write | Result: Success | Node:${nodeId} | Input:${inputId}`);
            return true;
        } else {
            logger.error(`Content write | Result: Failed | Node:${nodeId} | Input:${inputId} | Reason: Input not found`);
            return false;
        }
    }

    /**
     * Insert content at cursor position
     */
    static insertAtCursor(content, nodeId, inputId, options = { highlight: true, keepFocus: true }) {
        const mappingKey = `${nodeId}_${inputId}`;
        const mapping = window.PromptAssistantInputWidgetMap?.[mappingKey];

        if (mapping && mapping.inputEl) {
            const inputEl = mapping.inputEl;

            // Check if Markdown Note
            const editor = this.getMarkdownNoteEditor(inputEl);
            if (editor) {
                // For Markdown Note, use Tiptap insert command
                if (editor.element && editor.element.__tiptap_editor) {
                    const tiptapEditor = editor.element.__tiptap_editor;
                    // Use Tiptap's insertContent command
                    tiptapEditor.commands.insertContent(content);
                } else {
                    // Fallback: get current text, insert content, then set back
                    const currentText = editor.getText();
                    const selection = window.getSelection();
                    let cursorPos = 0;
                    if (selection && selection.rangeCount > 0) {
                        const range = selection.getRangeAt(0);
                        const preCaretRange = range.cloneRange();
                        preCaretRange.selectNodeContents(editor.element);
                        preCaretRange.setEnd(range.endContainer, range.endOffset);
                        cursorPos = preCaretRange.toString().length;
                    }
                    const beforeText = currentText.substring(0, cursorPos);
                    const afterText = currentText.substring(cursorPos);
                    const newContent = beforeText + content + afterText;
                    editor.setContent(newContent);
                }

                // Add highlight effect
                if (options.highlight && editor.element) {
                    this._highlightInput(editor.element);
                }

                // Keep focus
                if (options.keepFocus && editor.element) {
                    editor.element.focus();
                }

                logger.debug(`Content insert | Result: Success | Node:${nodeId} | Input:${inputId} | Type: Markdown Note`);
                return true;
            }

            // Standard input handling
            const currentValue = inputEl.value;
            const cursorPos = inputEl.selectionStart;
            const beforeText = currentValue.substring(0, cursorPos);
            const afterText = currentValue.substring(inputEl.selectionEnd);

            // Insert content
            const newValue = beforeText + content + afterText;
            inputEl.value = newValue;

            // Trigger event
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            inputEl.dispatchEvent(new Event('change', { bubbles: true }));

            // Update cursor position
            const newPos = cursorPos + content.length;
            inputEl.setSelectionRange(newPos, newPos);

            // Add highlight effect
            if (options.highlight) {
                this._highlightInput(inputEl);
            }

            // Decide whether to keep focus based on parameters
            if (options.keepFocus) {
                inputEl.focus();
            }

            logger.debug(`Content insert | Result: Success | Node:${nodeId} | Input:${inputId}`);
            return true;
        } else {
            logger.error(`Content insert | Result: Failed | Node:${nodeId} | Input:${inputId} | Reason: Input not found`);
            return false;
        }
    }

    /**
     * Add highlight animation effect to input
     */
    static _highlightInput(inputEl) {
        if (!inputEl) return;

        // Remove old highlight state
        this.removeHighlight(inputEl);

        // Force repaint to ensure animation can restart
        void inputEl.offsetWidth;

        // Add animation class
        inputEl.classList.add('input-highlight');

        // Remove class after animation ends
        // Use 200ms to match CSS animation duration (common.css: L181)
        inputEl._highlightTimer = setTimeout(() => {
            this.removeHighlight(inputEl);
        }, 200);
    }

    /**
     * Explicitly remove element highlight state and clean up timers
     * Used to clean up rendering load before layout reflow (e.g. scrollbar appearing)
     * @param {HTMLElement} inputEl Target element
     */
    static removeHighlight(inputEl) {
        if (!inputEl) return;

        // Remove animation class
        inputEl.classList.remove('input-highlight');

        // Clean up timers
        if (inputEl._highlightTimer) {
            clearTimeout(inputEl._highlightTimer);
            inputEl._highlightTimer = null;
        }
    }

    /**
     * Handle async button operation
     */
    static async handleAsyncButtonOperation(widget, buttonId, buttonElement, asyncOperation) {
        const statusConfig = this.STATUS_TEXTS[buttonId] || {
            loading: 'Processing',
            success: 'Complete',
            error: (msg) => msg || 'Operation failed'
        };

        let currentRequestId = null;
        let cancellationTimer = null;
        let cancelClickHandler = null;

        try {
            // Set current button to processing state
            this.setButtonState(widget, buttonId, 'processing', true);
            // Disable other buttons
            Object.keys(widget.buttons).forEach(id => {
                if (id !== buttonId) {
                    this.setButtonState(widget, id, 'disabled', true);
                }
            });

            // Execute async operation and capture request ID
            const result = await asyncOperation((requestId) => {
                currentRequestId = requestId;

                // 0.5seconds later allow cancel
                cancellationTimer = setTimeout(() => {
                    // Check if button is still processing
                    const currentState = this.getButtonState(widget, buttonId);
                    if (currentState && currentState.processing) {
                        buttonElement.classList.add('cancellable');
                        // Temporarily add cancel event
                        cancelClickHandler = async (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (currentRequestId) {
                                logger.debug(`User cancelled request | ID: ${currentRequestId}`);
                                await APIService.cancelRequest(currentRequestId);

                                // Show different cancel tips based on button ID
                                let cancelMessage = 'Request cancelled';
                                if (buttonId === 'expand') {
                                    cancelMessage = 'Prompt enhance cancelled';
                                } else if (buttonId === 'translate') {
                                    cancelMessage = 'Translation cancelled';
                                }

                                // Show cancel tip
                                this.showStatusTip(buttonElement, 'info', cancelMessage);
                            }
                        };
                        buttonElement.addEventListener('click', cancelClickHandler);
                    }
                }, 500);
            });

            // Show different tips based on operation result
            if (result && result.success) {
                const btnRect = buttonElement.getBoundingClientRect();
                const tipPosition = { x: btnRect.left + btnRect.width / 2, y: btnRect.top };

                if (result.useCache && result.tipType && result.tipMessage) {
                    this.showStatusTip(
                        result.buttonElement || buttonElement,
                        result.tipType,
                        result.tipMessage,
                        tipPosition
                    );
                } else if (!result.useCache) {
                    this.showStatusTip(
                        buttonElement,
                        'success',
                        typeof statusConfig.success === 'function' ? statusConfig.success(result.from, result.to) : statusConfig.success,
                        tipPosition
                    );
                }
            } else {
                // If cancelled by user, don't show error
                if (!result?.cancelled) {
                    throw new Error(statusConfig.error(result?.error));
                }
            }

        } catch (error) {
            // If cancelled by user, error already handled at API layer, not shown here
            if (error.name !== 'AbortError' && !error.message.includes('aborted')) {
                const btnRect = buttonElement.getBoundingClientRect();
                this.showStatusTip(
                    buttonElement,
                    'error',
                    error.message,
                    { x: btnRect.left + btnRect.width / 2, y: btnRect.top }
                );
                logger.error(`Button op failed | Button:${buttonId} | Error:${error.message}`);
            }

        } finally {
            // Clean up
            if (cancellationTimer) clearTimeout(cancellationTimer);
            if (cancelClickHandler) buttonElement.removeEventListener('click', cancelClickHandler);
            buttonElement.classList.remove('cancellable');

            // Restore to old, reliable reset logic
            // Reset current button state
            this.setButtonState(widget, buttonId, 'processing', false);
            // Restore other button states
            Object.keys(widget.buttons).forEach(id => {
                if (id !== buttonId) {
                    this.setButtonState(widget, id, 'disabled', false);
                }
            });

            // After operation, trigger assistant auto-collapse
            setTimeout(() => {
                if (window.promptAssistant && typeof window.promptAssistant.triggerAutoCollapse === 'function') {
                    window.promptAssistant.triggerAutoCollapse(widget);
                    logger.debug(`Async op complete | Trigger auto-collapse | Button:${buttonId}`);
                }
            }, 1500);
        }
    }
}

export { UIToolkit };