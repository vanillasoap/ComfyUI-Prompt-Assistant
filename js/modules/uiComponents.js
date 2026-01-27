/**
 * Common UI Component Library
 * Provides reusable UI components for the project
 */

import { app } from "../../../../scripts/app.js";
import { logger } from '../utils/logger.js';

// ---Dynamic Z-Index Calculation---
/**
 * Get the z-index value of the ComfyUI settings dialog
 * Only searches for ComfyUI's p-dialog elements to avoid performance issues from traversing all DOM elements
 * @returns {number} z-index value of the ComfyUI dialog, returns the base value if not found
 */
function getComfyUIDialogZIndex() {
    // ComfyUI uses PrimeVue, the settings dialog class name is .p-dialog
    const comfyDialog = document.querySelector('.p-dialog');
    if (comfyDialog) {
        const zIndex = parseInt(window.getComputedStyle(comfyDialog).zIndex, 10);
        if (!isNaN(zIndex)) {
            return zIndex;
        }
    }
    // If no ComfyUI dialog is found, return the base value defined by CSS variables
    return 10200;
}

/**
 * Create a common settings dialog
 * @param {Object} options Dialog configuration options
 * @param {string} options.title Dialog title
 * @param {Function} options.renderContent Function to render dialog content
 * @param {Function} options.renderNotice Function to render notice area (optional, displayed between title and content)
 * @param {Function} options.onSave Save button click callback
 * @param {Function} options.onCancel Cancel button click callback (optional)
 * @param {boolean} options.isConfirmDialog Whether it is a confirm dialog (optional)
 * @param {string} options.saveButtonText Save button text (optional)
 * @param {string} options.cancelButtonText Cancel button text (optional)
 * @param {string} options.saveButtonIcon Save button icon (optional)
 * @param {boolean} options.isDangerButton Whether the save button uses danger style (optional, red background)
 * @param {boolean} options.disableBackdropAndCloseOnClickOutside Disable backdrop and close on click outside (optional)
 */
export function createSettingsDialog(options) {
    try {
        const {
            title,
            renderContent,
            renderNotice = null,
            onSave,
            onCancel = null,
            onClose = null,  // Close callback (called regardless of save or cancel)
            isConfirmDialog = false,
            saveButtonText = 'Save',
            cancelButtonText = 'Cancel',
            saveButtonIcon = 'pi-check',
            isDangerButton = false,  // Whether it is a danger button
            dialogClassName = null,
            disableBackdropAndCloseOnClickOutside = false,
            hideFooter = false,  // Whether to hide the footer buttons
        } = options;

        let overlay = null;
        if (!disableBackdropAndCloseOnClickOutside) {
            // Create overlay
            overlay = document.createElement('div');
            overlay.className = 'settings-modal-overlay';
            document.body.appendChild(overlay);
        }


        // Create dialog
        const modal = document.createElement('div');
        modal.className = 'settings-modal';

        // If an additional dialog class name is provided, add it to modal
        if (dialogClassName) {
            modal.classList.add(dialogClassName);
        }

        // If it's a confirm dialog, set special styles
        if (isConfirmDialog) {
            // Only set default width if no custom class name is provided
            if (!dialogClassName) {
                modal.style.width = 'min(90vw, 400px)';
            }
            modal.style.minHeight = 'auto';
            // z-index is managed uniformly by CSS .settings-modal and .settings-modal-overlay, no need to set in JS
        }

        // Form modification state
        let isFormModified = false;

        // Internal close function: close the dialog and call the onClose callback
        const closeDialog = () => {
            closeModalWithAnimation(modal, overlay);
            // Call onClose callback after animation completes
            if (onClose) {
                setTimeout(() => {
                    onClose();
                }, 300); // Match animation duration
            }
        };

        // Handle dialog close logic
        const handleCloseModal = async (saveAction) => {
            // If it's a save action, save directly and close without showing a confirm dialog
            if (saveAction) {
                try {
                    await onSave(content);
                    closeDialog();
                } catch (error) {
                    app.extensionManager.toast.add({
                        severity: "error",
                        summary: "Save Failed",
                        detail: error.message,
                        life: 3000
                    });
                }
                return;
            }

            // Only show confirm dialog when form is modified, not a confirm dialog, and no onCancel is provided
            // If onCancel is provided, it means the caller chose to skip secondary confirmation
            if (isFormModified && !isConfirmDialog && !onCancel) {
                // Create confirm dialog
                createSettingsDialog({
                    title: 'Confirm Action',
                    isConfirmDialog: true,
                    saveButtonText: 'Back',
                    saveButtonIcon: 'pi-undo',
                    cancelButtonText: 'Close',
                    renderContent: (content) => {
                        content.style.textAlign = 'center';
                        content.style.padding = '1rem';

                        const confirmMessage = document.createElement('p');
                        confirmMessage.textContent = 'Configuration has been modified. Do you want to save?';
                        confirmMessage.style.margin = '0';
                        confirmMessage.style.fontSize = '1rem';

                        content.appendChild(confirmMessage);
                    },
                    onSave: () => {
                        // The back button only closes the confirm dialog, does not perform save
                        // No action needed here, as the default dialog close logic executes after button click
                    },
                    onCancel: () => {
                        // Close the main dialog
                        closeDialog();
                    }
                });
            } else {
                // No modifications, or is a confirm dialog, or has onCancel - close directly
                if (onCancel && !isConfirmDialog) {
                    onCancel();
                }
                closeDialog();
            }
        };

        if (!disableBackdropAndCloseOnClickOutside) {
            // Click overlay to close dialog
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    handleCloseModal(false);
                }
            });
        }

        // Create dialog header
        const header = document.createElement('div');
        header.className = 'p-dialog-header';

        const titleSpan = document.createElement('span');
        titleSpan.className = 'p-dialog-title';
        titleSpan.innerHTML = title;

        const closeButton = document.createElement('button');
        closeButton.className = 'p-dialog-header-icon p-dialog-header-close p-link';
        closeButton.setAttribute('aria-label', 'Close');
        closeButton.innerHTML = '<span class="pi pi-times"></span>';
        closeButton.onclick = () => {
            handleCloseModal(false);
        };

        const headerIcons = document.createElement('div');
        headerIcons.className = 'p-dialog-header-icons';
        headerIcons.appendChild(closeButton);

        header.appendChild(titleSpan);
        header.appendChild(headerIcons);

        // Create notice area (between title and content)
        let noticeArea = null;
        if (renderNotice) {
            noticeArea = document.createElement('div');
            noticeArea.className = 'p-dialog-notice';
            renderNotice(noticeArea);
        }

        // Create dialog content
        const content = document.createElement('div');
        content.className = 'p-dialog-content';

        // Track form changes
        const trackFormChanges = (formElement) => {
            // Add change listeners to all input elements
            const inputs = formElement.querySelectorAll('input, textarea, select');
            inputs.forEach(input => {
                const originalValue = input.type === 'checkbox' ? input.checked : input.value;

                input.addEventListener('change', () => {
                    const currentValue = input.type === 'checkbox' ? input.checked : input.value;
                    // Only mark as modified when the value actually changes
                    if (currentValue !== originalValue) {
                        isFormModified = true;
                    }
                });

                if (input.tagName.toLowerCase() === 'textarea' || input.type === 'text') {
                    input.addEventListener('input', () => {
                        const currentValue = input.value;
                        // Only mark as modified when the value actually changes
                        if (currentValue !== originalValue) {
                            isFormModified = true;
                        }
                    });
                }
            });

            // Track custom dropdown changes
            const dropdowns = formElement.querySelectorAll('.p-dropdown');
            dropdowns.forEach(dropdown => {
                // Store original selected value
                const hiddenSelect = dropdown.querySelector('select');
                const originalValue = hiddenSelect ? hiddenSelect.value : '';

                const observer = new MutationObserver(() => {
                    const currentValue = hiddenSelect ? hiddenSelect.value : '';
                    // Only mark as modified when the value actually changes
                    if (currentValue !== originalValue) {
                        isFormModified = true;
                    }
                });
                observer.observe(dropdown, { attributes: true, childList: true, subtree: true });
            });
        };

        // Render content and track changes
        renderContent(content, header);

        // If not a confirm dialog and content contains forms, add change tracking
        if (!isConfirmDialog) {
            const forms = content.querySelectorAll('form');
            forms.forEach(trackFormChanges);

            // If no forms found, watch the entire content area
            if (forms.length === 0) {
                trackFormChanges(content);
            }
        }

        // Create dialog footer
        const footer = document.createElement('div');
        footer.className = 'p-dialog-footer';

        const cancelButton = document.createElement('button');
        cancelButton.className = 'p-button p-component p-button-secondary';
        cancelButton.innerHTML = `<span class="p-button-icon-left pi pi-times"></span><span class="p-button-label">${cancelButtonText}</span>`;

        // Set different close behavior for different dialog types
        if (isConfirmDialog) {
            cancelButton.onclick = () => {
                // For confirm dialogs, the "Close" button should execute onCancel callback (which closes the main window), then close itself
                if (onCancel) {
                    onCancel();
                }
                closeModalWithAnimation(modal, overlay);
            };
        } else {
            cancelButton.onclick = () => {
                // For standard dialogs, use the standard close handling logic
                handleCloseModal(false);
            };
        }

        const saveButton = document.createElement('button');
        // Set button style based on isDangerButton parameter
        saveButton.className = isDangerButton
            ? 'p-button p-component p-button-danger'
            : 'p-button p-component';
        saveButton.innerHTML = `<span class="p-button-icon-left pi ${saveButtonIcon}"></span><span class="p-button-label">${saveButtonText}</span>`;
        saveButton.onclick = () => {
            // If it's the back button in a confirm dialog, close the confirm dialog directly
            if (isConfirmDialog) {
                try {
                    // For confirm dialogs, execute onSave callback first, then close the dialog
                    const result = onSave && onSave(content);
                    // If onSave returns a Promise, wait for it to complete
                    if (result instanceof Promise) {
                        result.then(() => {
                            closeModalWithAnimation(modal, overlay);
                        }).catch(error => {
                            logger.error(`Confirm dialog processing failed: ${error.message}`);
                            closeModalWithAnimation(modal, overlay);
                        });
                    } else {
                        // Normal return value, close directly
                        closeModalWithAnimation(modal, overlay);
                    }
                } catch (error) {
                    logger.error(`Confirm dialog processing failed: ${error.message}`);
                    closeModalWithAnimation(modal, overlay);
                }
            } else {
                handleCloseModal(true);
            }
        };

        footer.appendChild(cancelButton);
        footer.appendChild(saveButton);

        // Add drag functionality
        let isDragging = false;
        let startX = 0;
        let startY = 0;
        let offsetX = 0;
        let offsetY = 0;

        const startDragging = (e) => {
            if (e.target === closeButton || closeButton.contains(e.target)) return;

            e.preventDefault();
            isDragging = true;

            // Get mouse offset relative to the dialog
            const rect = modal.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;

            // Remove centered positioning
            modal.style.transform = 'none';
            modal.style.left = rect.left + 'px';
            modal.style.top = rect.top + 'px';

            // Add dragging state
            modal.classList.add('dragging');

            document.addEventListener('mousemove', onDrag);
            document.addEventListener('mouseup', stopDragging);
        };

        const onDrag = (e) => {
            if (!isDragging) return;
            e.preventDefault();

            // Calculate new position (considering mouse offset within the dialog)
            let newLeft = e.clientX - offsetX;
            let newTop = e.clientY - offsetY;

            // Get viewport and dialog dimensions
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            const modalRect = modal.getBoundingClientRect();
            const modalWidth = modalRect.width;
            const modalHeight = modalRect.height;

            // Boundary check (maintain 10px margin)
            const margin = 10;
            newLeft = Math.max(margin, Math.min(newLeft, viewportWidth - modalWidth - margin));
            newTop = Math.max(margin, Math.min(newTop, viewportHeight - modalHeight - margin));

            // Update position
            modal.style.left = `${newLeft}px`;
            modal.style.top = `${newTop}px`;
        };

        const stopDragging = () => {
            isDragging = false;
            modal.classList.remove('dragging');
            document.removeEventListener('mousemove', onDrag);
            document.removeEventListener('mouseup', stopDragging);
        };

        header.addEventListener('mousedown', startDragging);

        // Assemble dialog
        modal.appendChild(header);
        if (noticeArea) {
            modal.appendChild(noticeArea);
        }
        modal.appendChild(content);

        // Only add footer buttons when hideFooter is false
        if (!hideFooter) {
            modal.appendChild(footer);
        }

        // Dynamically calculate z-index to ensure it's always above ComfyUI dialogs
        // Must be set before appendChild, otherwise the animation start frame will use the CSS static value
        const baseZIndex = getComfyUIDialogZIndex() + 10;
        modal.style.zIndex = baseZIndex;
        if (overlay) {
            overlay.style.zIndex = baseZIndex - 1;
        }

        // Display dialog and overlay
        document.body.appendChild(modal);

        // Add show animation
        requestAnimationFrame(() => {
            modal.classList.add('modal-show');
            if (overlay) {
                overlay.classList.add('overlay-show');
            }
        });

        return modal;
    } catch (error) {
        logger.error(`Failed to create settings dialog: ${error.message}`);
        app.extensionManager.toast.add({
            severity: "error",
            summary: "Failed to Create Dialog",
            detail: error.message || "An error occurred while creating the settings dialog",
            life: 3000
        });
    }
}

/**
 * Add animation effect when closing dialog
 * @param {HTMLElement} modal Dialog element
 * @param {HTMLElement} overlay Overlay element
 */
export function closeModalWithAnimation(modal, overlay) {
    // Add close animation class
    modal.classList.remove('modal-show');
    modal.classList.add('modal-hide');
    if (overlay) {
        overlay.classList.remove('overlay-show');
        overlay.classList.add('overlay-hide');
    }

    // Wait for animation to complete before removing dialog and overlay
    setTimeout(() => {
        if (modal.parentNode) {
            modal.parentNode.removeChild(modal);
        }
        if (overlay && overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
        }
    }, 300); // Match CSS transition duration
}

/**
 * Create a form group
 * @param {string} title Form group title
 * @param {Array<{text: string, url: string}>} links Array of links on the right side of the title
 * @param {Object} [options] Additional options
 * @param {string} [options.prefixText] Prefix plain text before links (not wrapped in a link tag)
 * @returns {HTMLElement} Form group container
 */
export function createFormGroup(title, links = [], options = {}) {
    const { prefixText = null } = options;

    const group = document.createElement('div');
    group.className = 'settings-form-section';

    const titleContainer = document.createElement('div');
    titleContainer.className = 'settings-form-section-header';
    titleContainer.style.display = 'flex';
    titleContainer.style.alignItems = 'center';
    titleContainer.style.justifyContent = 'space-between';
    titleContainer.style.marginBottom = '10px';

    const titleElem = document.createElement('h3');
    titleElem.className = 'settings-form-section-title';
    titleElem.textContent = title;
    titleElem.style.margin = '0';

    const linksContainer = document.createElement('div');
    linksContainer.style.display = 'flex';
    linksContainer.style.gap = '8px';
    linksContainer.style.alignItems = 'center';

    if (links.length > 0) {
        const serviceLinksContainer = document.createElement('div');
        serviceLinksContainer.className = 'settings-service-links';

        // Optional prefix text, same font size as links (not wrapped in <a> tag)
        if (prefixText) {
            const prefix = document.createElement('span');
            prefix.className = 'settings-service-prefix';
            prefix.textContent = prefixText;
            serviceLinksContainer.appendChild(prefix);
        }

        links.forEach((linkInfo, index) => {
            if (index > 0) {
                // Add separator
                const separator = document.createElement('span');
                separator.textContent = '｜';
                separator.className = 'settings-service-separator';
                serviceLinksContainer.appendChild(separator);
            }

            const link = document.createElement('a');
            link.href = linkInfo.url;
            link.target = '_blank';
            link.textContent = linkInfo.text;
            link.className = 'settings-service-link';

            serviceLinksContainer.appendChild(link);
        });

        linksContainer.appendChild(serviceLinksContainer);
    }

    titleContainer.appendChild(titleElem);
    titleContainer.appendChild(linksContainer);
    group.appendChild(titleContainer);

    return group;
}

/**
 * Create a floating label input group (PrimeVue FloatLabel variant="on" style)
 * @param {string} label Label text
 * @param {string} placeholder Placeholder text
 * @param {string} type Input type
 * @returns {Object} Object containing group and input
 */
export function createInputGroup(label, placeholder, type = 'text') {
    const group = document.createElement('div');
    group.className = 'settings-form-group';

    // Create floating label container
    const floatContainer = document.createElement('div');
    floatContainer.className = 'float-label-container';

    // Create input
    const input = document.createElement('input');
    input.className = 'p-inputtext p-component';
    input.type = type;
    // Use space as placeholder to trigger :not(:placeholder-shown) selector
    input.placeholder = ' ';

    // Create floating label
    const floatLabel = document.createElement('label');
    floatLabel.textContent = label;

    // Assemble structure: input first, label after (using ~ selector)
    floatContainer.appendChild(input);
    floatContainer.appendChild(floatLabel);

    // If number input, add custom up/down adjustment buttons
    if (type === 'number') {
        const buttonsContainer = document.createElement('div');
        buttonsContainer.className = 'number-input-buttons';

        // Increase button
        const increaseBtn = document.createElement('button');
        increaseBtn.className = 'number-input-button';
        increaseBtn.type = 'button';
        increaseBtn.innerHTML = '<i class="pi pi-chevron-up"></i>';
        increaseBtn.addEventListener('click', () => {
            const step = parseFloat(input.step) || 1;
            const max = input.max ? parseFloat(input.max) : Infinity;
            const currentValue = parseFloat(input.value) || 0;
            const newValue = Math.min(currentValue + step, max);
            input.value = newValue;
            // Trigger change event to save data
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });

        // Decrease button
        const decreaseBtn = document.createElement('button');
        decreaseBtn.className = 'number-input-button';
        decreaseBtn.type = 'button';
        decreaseBtn.innerHTML = '<i class="pi pi-chevron-down"></i>';
        decreaseBtn.addEventListener('click', () => {
            const step = parseFloat(input.step) || 1;
            const min = input.min ? parseFloat(input.min) : -Infinity;
            const currentValue = parseFloat(input.value) || 0;
            const newValue = Math.max(currentValue - step, min);
            input.value = newValue;
            // Trigger change event to save data
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });

        buttonsContainer.appendChild(increaseBtn);
        buttonsContainer.appendChild(decreaseBtn);
        floatContainer.appendChild(buttonsContainer);
    }

    group.appendChild(floatContainer);

    return { group, input };
}

/**
 * Create a dropdown select group (PrimeVue FloatLabel variant="on" style)
 * @param {string} label Label text
 * @param {Array<{value: string, text: string}>} options Options list
 * @param {string} [initialValue=null] Initially selected value
 * @param {Object} [config={}] Configuration options
 * @param {boolean} [config.showLabel=true] Whether to show floating label
 * @returns {Object} Object containing group and select
 */
export function createSelectGroup(label, options, initialValue = null, config = {}) {
    const { showLabel = true } = config;

    const group = document.createElement('div');
    group.className = 'settings-form-group';

    // Create floating label container
    const floatContainer = document.createElement('div');
    floatContainer.className = 'float-label-container';

    // Main Container
    const dropdownContainer = document.createElement('div');
    // Add custom style class pa-dropdown, keep p-dropdown for compatibility with existing logic (e.g. dirty check and layout selectors)
    dropdownContainer.className = 'pa-dropdown p-dropdown p-component w-full';
    dropdownContainer.style.position = 'relative'; // Needed for panel positioning

    // Hidden select for form data and accessibility
    const select = document.createElement('select');
    const hiddenContainer = document.createElement('div');
    hiddenContainer.className = 'p-hidden-accessible';
    hiddenContainer.appendChild(select);

    // Visible Part: Label and Trigger
    const dropdownLabel = document.createElement('span');
    dropdownLabel.className = 'pa-dropdown-label p-dropdown-label p-inputtext';

    const dropdownTrigger = document.createElement('div');
    dropdownTrigger.className = 'pa-dropdown-trigger p-dropdown-trigger';
    dropdownTrigger.innerHTML = '<span class="p-dropdown-trigger-icon pi pi-chevron-down"></span>';

    // Dropdown Panel (the menu)
    const dropdownPanel = document.createElement('div');
    dropdownPanel.className = 'pa-dropdown-panel p-dropdown-panel p-component settings-modal-dropdown-panel';
    dropdownPanel.style.display = 'none'; // Initially hidden
    // z-index is managed by the CSS --settings-dropdown-z-index variable

    const dropdownItemsWrapper = document.createElement('div');
    dropdownItemsWrapper.className = 'p-dropdown-items-wrapper';

    const dropdownList = document.createElement('ul');
    dropdownList.className = 'p-dropdown-items';
    dropdownList.setAttribute('role', 'listbox');

    /**
     * Update dropdown options
     * @param {Array<{value: string, text: string}>} newOptions - New options list
     * @param {string} [newValue=null] - New selected value
     */
    const updateOptions = (newOptions, newValue = null) => {
        // Clear existing options
        select.innerHTML = '';
        dropdownList.innerHTML = '';

        if (!newOptions || newOptions.length === 0) {
            dropdownLabel.textContent = 'No options available';
            return;
        }

        // Populate new options
        newOptions.forEach(opt => {
            const optionEl = document.createElement('option');
            optionEl.value = opt.value;
            optionEl.textContent = opt.text;
            select.appendChild(optionEl);

            const itemEl = document.createElement('li');
            itemEl.className = 'p-dropdown-item';
            itemEl.textContent = opt.text;
            itemEl.dataset.value = opt.value;
            itemEl.setAttribute('role', 'option');

            itemEl.addEventListener('click', (e) => {
                e.stopPropagation();
                // Update highlight
                dropdownList.querySelectorAll('.p-dropdown-item').forEach(el => el.classList.remove('p-highlight'));
                itemEl.classList.add('p-highlight');

                select.value = opt.value;
                dropdownLabel.textContent = opt.text;
                closePanel();
                select.dispatchEvent(new Event('change', { bubbles: true }));
            });

            dropdownList.appendChild(itemEl);
        });

        // Set selected value
        // If newValue is provided and exists in options, use it; otherwise try to keep current value; finally default to first item
        const currentVal = select.value;
        const valToSet = (newValue !== null && newOptions.some(o => o.value === newValue))
            ? newValue
            : (newOptions.some(o => o.value === currentVal) ? currentVal : newOptions[0].value);

        if (valToSet !== null) {
            const selectedOption = newOptions.find(o => o.value === valToSet);
            if (selectedOption) {
                dropdownLabel.textContent = selectedOption.text;
                select.value = selectedOption.value;
                // Set highlight
                const initialItem = dropdownList.querySelector(`.p-dropdown-item[data-value="${valToSet}"]`);
                if (initialItem) {
                    initialItem.classList.add('p-highlight');
                }
            }
        }
    };

    // Initialize and render options
    updateOptions(options, initialValue);

    // Assemble dropdown
    dropdownItemsWrapper.appendChild(dropdownList);
    dropdownPanel.appendChild(dropdownItemsWrapper);

    dropdownContainer.appendChild(hiddenContainer);
    dropdownContainer.appendChild(dropdownLabel);
    dropdownContainer.appendChild(dropdownTrigger);

    // Decide whether to create floating label based on showLabel
    if (showLabel) {
        // Create floating label
        const floatLabel = document.createElement('label');
        floatLabel.textContent = label;

        // Assemble floating label structure: dropdown first, label after
        floatContainer.appendChild(dropdownContainer);
        floatContainer.appendChild(floatLabel);
    } else {
        // No floating label, add dropdown directly
        floatContainer.appendChild(dropdownContainer);
    }

    group.appendChild(floatContainer);

    // --- Event Handling ---
    let isOpen = false;

    // Function to update panel position
    const updatePanelPosition = () => {
        if (!isOpen) return;

        const rect = dropdownContainer.getBoundingClientRect();
        dropdownPanel.style.top = rect.bottom + 'px';
        dropdownPanel.style.left = rect.left + 'px';
        dropdownPanel.style.width = rect.width + 'px';
    };

    const closePanel = () => {
        if (!isOpen) return;
        isOpen = false;

        dropdownPanel.classList.add('p-hidden');
        dropdownPanel.classList.remove('p-enter-active');
        dropdownContainer.classList.remove('p-dropdown-open', 'p-focus');

        // Remove event listeners
        window.removeEventListener('resize', updatePanelPosition);
        window.removeEventListener('scroll', updatePanelPosition, true);

        // Wait for animation to complete before removing panel and event listeners
        setTimeout(() => {
            if (dropdownPanel.parentNode === document.body) {
                document.body.removeChild(dropdownPanel);
            }
            document.removeEventListener('click', handleOutsideClick, true);
        }, 120); // Match CSS transition duration
    };

    const openPanel = () => {
        isOpen = true;

        // Temporarily append panel to body to avoid clipping
        document.body.appendChild(dropdownPanel);

        // Calculate dropdown position relative to viewport
        const rect = dropdownContainer.getBoundingClientRect();

        // 设置面板样式
        dropdownPanel.style.position = 'fixed';
        dropdownPanel.style.display = 'block';
        dropdownPanel.style.top = rect.bottom + 'px';
        dropdownPanel.style.left = rect.left + 'px';
        dropdownPanel.style.width = rect.width + 'px';
        // 动态计算 z-index，确保在 ComfyUI 弹窗之上
        dropdownPanel.style.zIndex = getComfyUIDialogZIndex() + 15;

        dropdownPanel.classList.remove('p-hidden');
        // 强制重排，确保动画生效
        dropdownPanel.offsetHeight;
        dropdownPanel.classList.add('p-enter-active');
        dropdownContainer.classList.add('p-dropdown-open', 'p-focus');

        document.addEventListener('click', handleOutsideClick, true);

        // 添加窗口大小变化和滚动事件监听器，以便重新定位面板
        window.addEventListener('resize', updatePanelPosition);
        window.addEventListener('scroll', updatePanelPosition, true);
    };

    const handleOutsideClick = (e) => {
        // 如果点击的是下拉框本身，切换状态
        if (dropdownContainer.contains(e.target)) {
            e.stopPropagation();
            if (isOpen) {
                closePanel();
            } else {
                openPanel();
            }
            return;
        }
        // 如果点击的是其他区域，关闭面板
        closePanel();
    };

    // 初始化面板状态
    dropdownPanel.classList.add('p-hidden');
    dropdownContainer.addEventListener('click', handleOutsideClick);

    select.addEventListener('change', () => {
        const selectedOption = options.find(o => o.value === select.value);
        if (selectedOption) {
            dropdownLabel.textContent = selectedOption.text;
            // Update highlight
            dropdownList.querySelectorAll('.p-dropdown-item').forEach(el => {
                if (el.dataset.value === select.value) {
                    el.classList.add('p-highlight');
                } else {
                    el.classList.remove('p-highlight');
                }
            });
        }
    });

    return { group, select, updateOptions };
}

/**
 * 创建可输入下拉框组（Combo Box）
 * 支持从下拉列表选择或自定义输入
 * @param {string} label 标签文本
 * @param {Array<{value: string, text: string}>} options 选项列表（动态传入）
 * @param {string} [initialValue=''] 初始值
 * @param {Object} [config={}] 配置选项
 * @param {string} [config.placeholder=''] 输入框占位符
 * @param {string} [config.emptyText='No options available'] 无选项时的提示文本
 * @param {boolean} [config.showLabel=true] 是否显示浮动标签
 * @returns {Object} 包含 group, input, setValue, getValue, updateOptions 的对象
 */
export function createComboBoxGroup(label, options = [], initialValue = '', config = {}) {
    const {
        placeholder = '',
        emptyText = 'No options available',
        showLabel = true
    } = config;

    const group = document.createElement('div');
    group.className = 'settings-form-group';

    // 创建浮动标签容器
    const floatContainer = document.createElement('div');
    floatContainer.className = 'float-label-container';

    // ---主容器---
    const comboContainer = document.createElement('div');
    comboContainer.className = 'pa-combobox pa-dropdown p-dropdown p-component w-full';
    comboContainer.style.position = 'relative';

    // ---输入框（可见且可编辑）---
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pa-combobox-input pa-dropdown-label p-dropdown-label p-inputtext';
    input.placeholder = placeholder || ' ';
    input.value = initialValue;

    // ---下拉触发器（箭头图标）---
    const dropdownTrigger = document.createElement('div');
    dropdownTrigger.className = 'pa-dropdown-trigger p-dropdown-trigger';
    dropdownTrigger.innerHTML = '<span class="p-dropdown-trigger-icon pi pi-chevron-down"></span>';

    // ---下拉面板---
    const dropdownPanel = document.createElement('div');
    dropdownPanel.className = 'pa-dropdown-panel pa-combobox-panel p-dropdown-panel p-component settings-modal-dropdown-panel';
    dropdownPanel.style.display = 'none';

    const dropdownItemsWrapper = document.createElement('div');
    dropdownItemsWrapper.className = 'p-dropdown-items-wrapper';

    const dropdownList = document.createElement('ul');
    dropdownList.className = 'p-dropdown-items';
    dropdownList.setAttribute('role', 'listbox');

    // ---状态变量---
    let isOpen = false;
    let currentOptions = [...options];

    // ---渲染选项列表---
    const renderOptions = (optionsList) => {
        dropdownList.innerHTML = '';

        if (optionsList.length === 0) {
            // 显示空状态提示
            const emptyItem = document.createElement('li');
            emptyItem.className = 'p-dropdown-item pa-combobox-empty';
            emptyItem.textContent = emptyText;
            emptyItem.style.color = 'var(--p-text-muted-color)';
            emptyItem.style.fontStyle = 'italic';
            emptyItem.style.pointerEvents = 'none';
            dropdownList.appendChild(emptyItem);
            return;
        }

        optionsList.forEach(opt => {
            const itemEl = document.createElement('li');
            itemEl.className = 'p-dropdown-item';
            itemEl.textContent = opt.text;
            itemEl.dataset.value = opt.value;
            itemEl.setAttribute('role', 'option');

            // 高亮当前选中项
            if (input.value === opt.value) {
                itemEl.classList.add('p-highlight');
            }

            itemEl.addEventListener('click', (e) => {
                e.stopPropagation();
                // 更新输入框值
                input.value = opt.value;
                // 更新高亮
                dropdownList.querySelectorAll('.p-dropdown-item').forEach(el => el.classList.remove('p-highlight'));
                itemEl.classList.add('p-highlight');
                // 关闭面板
                closePanel();
                // 触发 change 事件
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });

            dropdownList.appendChild(itemEl);
        });
    };

    // 初始渲染
    renderOptions(currentOptions);

    // ---组装下拉面板---
    dropdownItemsWrapper.appendChild(dropdownList);
    dropdownPanel.appendChild(dropdownItemsWrapper);

    // ---组装主容器---
    comboContainer.appendChild(input);
    comboContainer.appendChild(dropdownTrigger);

    // ---根据 showLabel 决定是否创建浮动标签---
    if (showLabel) {
        const floatLabel = document.createElement('label');
        floatLabel.textContent = label;
        floatContainer.appendChild(comboContainer);
        floatContainer.appendChild(floatLabel);
    } else {
        floatContainer.appendChild(comboContainer);
    }

    group.appendChild(floatContainer);

    // ---更新面板位置---
    const updatePanelPosition = () => {
        if (!isOpen) return;
        const rect = comboContainer.getBoundingClientRect();
        dropdownPanel.style.top = rect.bottom + 'px';
        dropdownPanel.style.left = rect.left + 'px';
        dropdownPanel.style.width = rect.width + 'px';
    };

    // ---关闭面板---
    const closePanel = () => {
        if (!isOpen) return;
        isOpen = false;

        dropdownPanel.classList.add('p-hidden');
        dropdownPanel.classList.remove('p-enter-active');
        comboContainer.classList.remove('p-dropdown-open', 'p-focus');

        window.removeEventListener('resize', updatePanelPosition);
        window.removeEventListener('scroll', updatePanelPosition, true);

        setTimeout(() => {
            if (dropdownPanel.parentNode === document.body) {
                document.body.removeChild(dropdownPanel);
            }
            document.removeEventListener('click', handleOutsideClick, true);
        }, 120);
    };

    // ---打开面板---
    const openPanel = () => {
        if (isOpen) return;
        isOpen = true;

        document.body.appendChild(dropdownPanel);

        const rect = comboContainer.getBoundingClientRect();
        dropdownPanel.style.position = 'fixed';
        dropdownPanel.style.display = 'block';
        dropdownPanel.style.top = rect.bottom + 'px';
        dropdownPanel.style.left = rect.left + 'px';
        dropdownPanel.style.width = rect.width + 'px';
        // 动态计算 z-index，确保在 ComfyUI 弹窗之上
        dropdownPanel.style.zIndex = getComfyUIDialogZIndex() + 15;

        dropdownPanel.classList.remove('p-hidden');
        dropdownPanel.offsetHeight; // 强制重排
        dropdownPanel.classList.add('p-enter-active');
        comboContainer.classList.add('p-dropdown-open', 'p-focus');

        document.addEventListener('click', handleOutsideClick, true);
        window.addEventListener('resize', updatePanelPosition);
        window.addEventListener('scroll', updatePanelPosition, true);

        // 更新高亮状态
        dropdownList.querySelectorAll('.p-dropdown-item').forEach(el => {
            if (el.dataset.value === input.value) {
                el.classList.add('p-highlight');
            } else {
                el.classList.remove('p-highlight');
            }
        });
    };

    // ---处理外部点击---
    const handleOutsideClick = (e) => {
        // 点击面板内部不关闭
        if (dropdownPanel.contains(e.target)) {
            return;
        }
        // 点击输入框或触发器时切换状态
        if (comboContainer.contains(e.target)) {
            return; // 由输入框或触发器的事件处理
        }
        closePanel();
    };

    // ---输入框事件---
    input.addEventListener('focus', () => {
        openPanel();
        comboContainer.classList.add('p-focus');
    });

    input.addEventListener('blur', () => {
        // 延迟关闭，允许点击选项
        setTimeout(() => {
            if (!dropdownPanel.contains(document.activeElement)) {
                comboContainer.classList.remove('p-focus');
            }
        }, 150);
    });

    // ---触发器点击事件---
    dropdownTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isOpen) {
            closePanel();
        } else {
            openPanel();
            input.focus();
        }
    });

    // ---初始化面板状态---
    dropdownPanel.classList.add('p-hidden');

    // ---公开方法---
    const setValue = (value) => {
        input.value = value;
        // 更新高亮
        dropdownList.querySelectorAll('.p-dropdown-item').forEach(el => {
            if (el.dataset.value === value) {
                el.classList.add('p-highlight');
            } else {
                el.classList.remove('p-highlight');
            }
        });
    };

    const getValue = () => {
        return input.value;
    };

    const updateOptions = (newOptions) => {
        currentOptions = [...newOptions];
        renderOptions(currentOptions);
    };

    return { group, input, setValue, getValue, updateOptions };
}

/**
 * 创建水平布局的表单组
 * @param {Array<{label: string, element: HTMLElement}>} items 表单项数组
 * @returns {HTMLElement} 水平布局的表单组
 */
export function createHorizontalFormGroup(items) {
    const group = document.createElement('div');
    group.className = 'settings-form-group horizontal';

    items.forEach(item => {
        const container = document.createElement('div');

        const label = document.createElement('label');
        label.className = 'settings-form-label';
        label.textContent = item.label;

        container.appendChild(label);
        container.appendChild(item.element);

        group.appendChild(container);
    });

    return group;
}

/**
 * 创建多行文本输入框组 (PrimeVue FloatLabel variant="on" 风格)
 * @param {string} label 标签文本
 * @param {string} placeholder 占位符文本（未使用，保留参数以兼容旧代码）
 * @param {number} rows 默认行数
 * @returns {Object} 包含 group 和 textarea 的对象
 */
export function createTextareaGroup(label, placeholder, rows = 8) {
    const group = document.createElement('div');
    group.className = 'settings-form-group';

    // 创建浮动标签容器
    const floatContainer = document.createElement('div');
    floatContainer.className = 'float-label-container';

    // 创建文本域
    const textarea = document.createElement('textarea');
    textarea.className = 'p-inputtext p-component settings-form-textarea';
    // 使用空格作为 placeholder 以触发 :not(:placeholder-shown) 选择器
    textarea.placeholder = ' ';
    textarea.rows = rows;
    textarea.style.resize = 'vertical';
    textarea.style.minHeight = '150px';

    // 创建浮动标签
    const floatLabel = document.createElement('label');
    floatLabel.textContent = label;

    // 组装结构: textarea 在前, label 在后 (使用 ~ 选择器)
    floatContainer.appendChild(textarea);
    floatContainer.appendChild(floatLabel);

    group.appendChild(floatContainer);

    return { group, textarea };
}

/**
 * 创建开关控制组件
 * @param {string} label 标签文本
 * @param {string} description 描述文本
 * @param {boolean} defaultChecked 默认选中状态
 * @param {Function} onChange 变化回调函数
 * @returns {HTMLElement} 开关容器元素
 */
export function createSwitchControl(label, description, defaultChecked, onChange) {
    const container = document.createElement('div');
    container.className = 'switch-control-container';

    const textContainer = document.createElement('div');
    textContainer.className = 'switch-control-text';

    const labelEl = document.createElement('div');
    labelEl.className = 'switch-control-label';
    labelEl.textContent = label;
    textContainer.appendChild(labelEl);

    if (description) {
        const descEl = document.createElement('div');
        descEl.className = 'switch-control-desc';
        descEl.textContent = description;
        textContainer.appendChild(descEl);
    }

    container.appendChild(textContainer);

    // 创建开关
    const switchWrapper = document.createElement('label');
    switchWrapper.className = 'switch-wrapper';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = defaultChecked;

    const slider = document.createElement('span');
    slider.className = `switch-slider${defaultChecked ? ' checked' : ''}`;

    const sliderButton = document.createElement('span');
    sliderButton.className = `switch-button${defaultChecked ? ' checked' : ''}`;
    slider.appendChild(sliderButton);

    input.addEventListener('change', async (e) => {
        const isChecked = e.target.checked;
        if (isChecked) {
            slider.classList.add('checked');
            sliderButton.classList.add('checked');
        } else {
            slider.classList.remove('checked');
            sliderButton.classList.remove('checked');
        }
        if (onChange) {
            await onChange(isChecked);
        }
    });

    switchWrapper.appendChild(input);
    switchWrapper.appendChild(slider);
    container.appendChild(switchWrapper);

    return container;
}

/**
 * 创建加载按钮
 * @param {string} text 按钮文本
 * @param {Function} onClick 点击回调函数
 * @param {boolean} showSuccessToast 是否显示成功提示
 * @returns {HTMLElement} 按钮元素
 */
export function createLoadingButton(text, onClick, showSuccessToast = true) {
    const button = document.createElement('button');
    button.className = 'p-button p-component p-button-primary';
    button.style.width = '208px'; // 相当于w-52
    button.innerHTML = `<span class="p-button-label">${text}</span>`;

    button.addEventListener('click', async () => {
        if (button.disabled) return;

        // 开始加载状态
        button.disabled = true;
        button.classList.add('p-disabled');

        try {
            await onClick();

            // 只有在 showSuccessToast 为 true 时才显示成功提示
            if (showSuccessToast) {
                app.extensionManager.toast.add({
                    severity: "success",
                    summary: "清理已清理完成",
                    life: 3000
                });
            }

        } catch (error) {
            // 显示错误提示
            app.extensionManager.toast.add({
                severity: "error",
                summary: "操作失败",
                detail: error.message || "操作过程中发生错误",
                life: 3000
            });
            logger.error(`按钮操作失败: ${error.message}`);
        } finally {
            // 恢复按钮状态
            button.disabled = false;
            button.classList.remove('p-disabled');
        }
    });

    return button;
}

/**
 * 创建确认气泡框 (参考 PrimeVue ConfirmPopup)
 * @param {Object} options 配置选项
 * @param {HTMLElement} options.target 触发元素，气泡框的指针会指向它
 * @param {string} options.message 确认消息文本
 * @param {string} [options.icon] 消息图标类名（可选，默认为 'pi-info-circle'）
 * @param {Function} options.renderFormContent 渲染表单内容的函数（可选）
 * @param {Function} options.onConfirm 确认回调函数
 * @param {Function} [options.onCancel] 取消回调函数（可选）
 * @param {string} [options.confirmLabel='确认'] 确认按钮文本
 * @param {string} [options.cancelLabel='取消'] 取消按钮文本
 * @param {string} [options.position='bottom'] 气泡相对于触发元素的位置 ('top', 'bottom', 'left', 'right')
 * @param {boolean} [options.autoPosition=true] 是否自动计算最佳弹出位置（基于元素在窗口中的位置）
 * @param {boolean} [options.singleButton=false] 是否只显示单个确认按钮（适用于信息提示场景）
 * @returns {Object} 包含 popup 元素和 close 方法的对象
 */
export function createConfirmPopup(options) {
    const {
        target,
        message,
        icon = 'pi-info-circle',
        iconColor = null,
        renderFormContent = null,
        onConfirm,
        onCancel = null,
        confirmLabel = '确认',
        cancelLabel = '取消',
        position = 'bottom',
        autoPosition = true,
        singleButton = false,
        confirmDanger = false
    } = options;

    // 创建气泡框容器
    const popup = document.createElement('div');
    popup.className = 'pa-confirm-popup';

    // 创建气泡框内容
    const content = document.createElement('div');
    content.className = 'pa-confirm-popup-content';

    // 创建消息区域
    const messageContainer = document.createElement('div');
    messageContainer.className = 'pa-confirm-popup-message';

    const iconElement = document.createElement('i');
    iconElement.className = `pi ${icon} pa-confirm-popup-icon`;
    if (iconColor) {
        iconElement.style.color = iconColor;
    }
    messageContainer.appendChild(iconElement);

    const messageText = document.createElement('span');
    messageText.textContent = message;
    messageContainer.appendChild(messageText);

    content.appendChild(messageContainer);

    // 如果提供了表单渲染函数，创建表单区域
    let formContainer = null;
    if (renderFormContent) {
        // 调整消息区域的下边距
        messageContainer.style.marginBottom = '12px';

        // 添加分割线
        const divider = document.createElement('div');
        divider.className = 'pa-confirm-popup-divider';
        content.appendChild(divider);

        formContainer = document.createElement('div');
        formContainer.className = 'pa-confirm-popup-form';
        renderFormContent(formContainer);
        content.appendChild(formContainer);
    }

    // 创建按钮组
    const footer = document.createElement('div');
    footer.className = 'pa-confirm-popup-footer';

    // 单按钮模式：只显示确认按钮
    if (singleButton) {
        const confirmButton = document.createElement('button');
        confirmButton.className = confirmDanger
            ? 'p-button p-component p-button-sm p-button-danger'
            : 'p-button p-component p-button-sm';
        confirmButton.innerHTML = `<span class="p-button-icon-left pi pi-check"></span><span class="p-button-label">${confirmLabel}</span>`;
        confirmButton.onclick = async () => {
            try {
                if (onConfirm) {
                    await onConfirm(formContainer);
                }
                closePopup();
            } catch (error) {
                logger.error('确认操作失败', error);
                // 如果确认操作失败，不关闭气泡框
            }
        };
        footer.appendChild(confirmButton);
    } else {
        // 双按钮模式：显示取消和确认按钮
        const cancelButton = document.createElement('button');
        cancelButton.className = 'p-button p-component p-button-secondary p-button-sm';
        cancelButton.innerHTML = `<span class="p-button-icon-left pi pi-times"></span><span class="p-button-label">${cancelLabel}</span>`;
        cancelButton.onclick = () => {
            if (onCancel) {
                onCancel();
            }
            closePopup();
        };

        const confirmButton = document.createElement('button');
        confirmButton.className = confirmDanger
            ? 'p-button p-component p-button-sm p-button-danger'
            : 'p-button p-component p-button-sm';
        confirmButton.innerHTML = `<span class="p-button-icon-left pi pi-check"></span><span class="p-button-label">${confirmLabel}</span>`;
        confirmButton.onclick = async () => {
            try {
                // 将表单容器传递给 onConfirm 回调
                await onConfirm(formContainer);
                closePopup();
            } catch (error) {
                logger.error('确认操作失败', error);
                // 如果确认操作失败，不关闭气泡框
            }
        };

        footer.appendChild(cancelButton);
        footer.appendChild(confirmButton);
    }
    content.appendChild(footer);

    // 创建指针（箭头）
    const arrow = document.createElement('div');
    arrow.className = 'pa-confirm-popup-arrow';

    popup.appendChild(arrow);
    popup.appendChild(content);

    // 关闭气泡框的函数
    const closePopup = () => {
        popup.classList.add('pa-confirm-popup-hide');
        setTimeout(() => {
            if (popup.parentNode) {
                popup.parentNode.removeChild(popup);
            }
            // 移除点击外部关闭的事件监听
            document.removeEventListener('click', handleOutsideClick, true);
        }, 200);
    };

    // 点击外部关闭
    const handleOutsideClick = (e) => {
        if (!popup.contains(e.target) && !target.contains(e.target)) {
            if (onCancel) {
                onCancel();
            }
            closePopup();
        }
    };

    // ---定位气泡框---
    const positionPopup = () => {
        const targetRect = target.getBoundingClientRect();
        const popupRect = popup.getBoundingClientRect();
        const margin = 10;
        const gap = 12; // 气泡与目标之间的间隙
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        let top, left;
        let arrowPosition = '';
        let finalPosition = position;

        // 如果开启自动定位，根据目标元素位置计算最佳方向
        if (autoPosition) {
            // 计算各方向可用空间
            const spaceTop = targetRect.top - margin;
            const spaceBottom = viewportHeight - targetRect.bottom - margin;
            const spaceLeft = targetRect.left - margin;
            const spaceRight = viewportWidth - targetRect.right - margin;

            // 判断各方向是否能容纳气泡
            const canFitTop = spaceTop >= popupRect.height + gap;
            const canFitBottom = spaceBottom >= popupRect.height + gap;
            const canFitLeft = spaceLeft >= popupRect.width + gap;
            const canFitRight = spaceRight >= popupRect.width + gap;

            // 根据目标元素位置选择最佳方向
            // 优先级：用户指定的方向 > 相反方向 > 垂直/水平替代方向
            const preferHorizontal = (position === 'left' || position === 'right');

            if (preferHorizontal) {
                // 用户偏好水平方向
                if (position === 'left' && canFitLeft) {
                    finalPosition = 'left';
                } else if (position === 'right' && canFitRight) {
                    finalPosition = 'right';
                } else if (canFitRight) {
                    finalPosition = 'right';
                } else if (canFitLeft) {
                    finalPosition = 'left';
                } else if (canFitBottom) {
                    finalPosition = 'bottom';
                } else if (canFitTop) {
                    finalPosition = 'top';
                } else {
                    // 空间都不够，选择垂直空间最大的方向
                    finalPosition = spaceBottom >= spaceTop ? 'bottom' : 'top';
                }
            } else {
                // 用户偏好垂直方向（默认）
                if (position === 'bottom' && canFitBottom) {
                    finalPosition = 'bottom';
                } else if (position === 'top' && canFitTop) {
                    finalPosition = 'top';
                } else if (canFitBottom) {
                    finalPosition = 'bottom';
                } else if (canFitTop) {
                    finalPosition = 'top';
                } else if (canFitRight) {
                    finalPosition = 'right';
                } else if (canFitLeft) {
                    finalPosition = 'left';
                } else {
                    // 空间都不够，选择垂直空间最大的方向
                    finalPosition = spaceBottom >= spaceTop ? 'bottom' : 'top';
                }
            }
        }

        // 根据最终方向计算位置
        switch (finalPosition) {
            case 'top':
                top = targetRect.top - popupRect.height - gap;
                left = targetRect.left + (targetRect.width / 2) - (popupRect.width / 2);
                arrowPosition = 'bottom';
                break;
            case 'left':
                top = targetRect.top + (targetRect.height / 2) - (popupRect.height / 2);
                left = targetRect.left - popupRect.width - gap;
                arrowPosition = 'right';
                break;
            case 'right':
                top = targetRect.top + (targetRect.height / 2) - (popupRect.height / 2);
                left = targetRect.right + gap;
                arrowPosition = 'left';
                break;
            case 'bottom':
            default:
                top = targetRect.bottom + gap;
                left = targetRect.left + (targetRect.width / 2) - (popupRect.width / 2);
                arrowPosition = 'top';
                break;
        }

        // 水平边界检查（确保气泡不超出视口）
        if (left < margin) {
            left = margin;
        } else if (left + popupRect.width > viewportWidth - margin) {
            left = viewportWidth - popupRect.width - margin;
        }

        // 垂直边界检查
        if (top < margin) {
            top = margin;
        } else if (top + popupRect.height > viewportHeight - margin) {
            top = viewportHeight - popupRect.height - margin;
        }

        popup.style.top = `${top}px`;
        popup.style.left = `${left}px`;

        // 设置箭头位置
        arrow.className = `pa-confirm-popup-arrow ${arrowPosition}`;

        // 计算箭头的偏移，使其指向触发元素的中心
        if (arrowPosition === 'top' || arrowPosition === 'bottom') {
            let arrowLeft = targetRect.left + (targetRect.width / 2) - left;
            // 确保箭头不超出气泡边界
            arrowLeft = Math.max(16, Math.min(arrowLeft, popupRect.width - 16));
            arrow.style.left = `${arrowLeft}px`;
            arrow.style.top = '';
        } else if (arrowPosition === 'left' || arrowPosition === 'right') {
            let arrowTop = targetRect.top + (targetRect.height / 2) - top;
            // 确保箭头不超出气泡边界
            arrowTop = Math.max(16, Math.min(arrowTop, popupRect.height - 16));
            arrow.style.top = `${arrowTop}px`;
            arrow.style.left = '';
        }
    };

    // 将气泡框添加到 body
    document.body.appendChild(popup);

    // 定位气泡框
    requestAnimationFrame(() => {
        positionPopup();
        popup.classList.add('pa-confirm-popup-show');

        // 延迟添加外部点击监听，防止立即触发
        setTimeout(() => {
            document.addEventListener('click', handleOutsideClick, true);
        }, 100);
    });

    return {
        popup,
        close: closePopup
    };
}

/**
 * 创建右键菜单组件 (参考 PrimeVue Menu)
 * @param {Object} options 配置选项
 * @param {HTMLElement} options.target 触发元素，右键菜单会在此元素上触发
 * @param {Array<Object>} options.items 菜单项列表
 * @param {string} options.items[].label 菜单项文本
 * @param {string} [options.items[].icon] 菜单项图标类名（可选）
 * @param {Function} options.items[].onClick 菜单项点击回调
 * @param {boolean} [options.items[].separator] 是否为分隔符（可选）
 * @param {boolean} [options.items[].disabled] 是否禁用（可选）
 * @returns {Object} 包含 destroy 方法的对象
 */
/**
 * 显示右键菜单 (动态显示，不需要绑定特定元素)
 * @param {Object} options 配置选项
 * @param {number} options.x 显示位置 X 坐标
 * @param {number} options.y 显示位置 Y 坐标
 * @param {Array<Object>} options.items 菜单项列表
 * @param {Function} [options.onClose] 菜单关闭回调
 */
export function showContextMenu(options) {
    const {
        x,
        y,
        items = [],
        onClose
    } = options;

    // 移除现有的右键菜单（但不移除 Split Button 的菜单和下拉菜单）
    const existingMenu = document.querySelector('.pa-context-menu:not(.pa-split-button-menu):not(.pa-dropdown-menu)');
    if (existingMenu) {
        existingMenu.remove();
    }

    const menu = document.createElement('div');
    menu.className = 'pa-context-menu pa-context-menu-show'; // 直接显示

    // 我们需要手动设置样式以确保它立即可见但可以被定位
    menu.style.display = 'block';

    const menuList = document.createElement('ul');
    menuList.className = 'pa-context-menu-list';

    const closeMenu = () => {
        menu.classList.remove('pa-context-menu-show');
        menu.classList.add('pa-context-menu-hide');

        setTimeout(() => {
            if (menu && menu.parentNode) {
                menu.parentNode.removeChild(menu);
            }
        }, 150);

        document.removeEventListener('click', handleOutsideClick, true);
        document.removeEventListener('contextmenu', handleOutsideClick, true);

        if (onClose) {
            onClose();
        }
    };

    items.forEach(item => {
        if (item.separator) {
            const separator = document.createElement('li');
            separator.className = 'pa-context-menu-separator';
            menuList.appendChild(separator);
        } else {
            const menuItem = document.createElement('li');
            menuItem.className = 'pa-context-menu-item';

            if (item.disabled) {
                menuItem.classList.add('disabled');
            }

            if (item.danger) {
                menuItem.classList.add('danger');
            }

            const menuItemContent = document.createElement('div');
            menuItemContent.className = 'pa-context-menu-item-content';

            if (item.icon) {
                const icon = document.createElement('i');
                icon.className = `pi ${item.icon} pa-context-menu-item-icon`;
                menuItemContent.appendChild(icon);
            }

            const label = document.createElement('span');
            label.className = 'pa-context-menu-item-label';
            label.textContent = item.label;
            menuItemContent.appendChild(label);

            menuItem.appendChild(menuItemContent);

            if (!item.disabled && item.onClick) {
                menuItem.addEventListener('click', (e) => {
                    e.stopPropagation();
                    item.onClick(e);
                    closeMenu();
                });
            }

            menuList.appendChild(menuItem);
        }
    });

    menu.appendChild(menuList);
    document.body.appendChild(menu);

    // 定位菜单
    const menuRect = menu.getBoundingClientRect();
    let left = x;
    let top = y;

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    if (left + menuRect.width > viewportWidth) {
        left = viewportWidth - menuRect.width - 10;
    }

    if (top + menuRect.height > viewportHeight) {
        top = viewportHeight - menuRect.height - 10;
    }

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    // 点击外部关闭
    const handleOutsideClick = (e) => {
        if (menu && !menu.contains(e.target)) {
            closeMenu();
        }
    };

    // 延迟添加外部点击监听
    setTimeout(() => {
        document.addEventListener('click', handleOutsideClick, true);
        document.addEventListener('contextmenu', handleOutsideClick, true);
    }, 100);

    return {
        close: closeMenu
    };
}

/**
 * 创建右键菜单组件 (参考 PrimeVue Menu)
 * @param {Object} options 配置选项
 * @param {HTMLElement} options.target 触发元素,右键菜单会在此元素上触发
 * @param {Array<Object>|Function} options.items 菜单项列表或返回菜单项列表的函数
 * @returns {Object} 包含 destroy 方法的对象
 */
export function createContextMenu(options) {
    const {
        target,
        items = []
    } = options;

    const handleContextMenu = (e) => {
        e.preventDefault();
        e.stopPropagation();

        // 如果 items 是函数,则调用它获取最新的菜单项列表
        const menuItems = typeof items === 'function' ? items() : items;

        showContextMenu({
            x: e.clientX,
            y: e.clientY,
            items: menuItems
        });
    };

    target.addEventListener('contextmenu', handleContextMenu);

    const destroy = () => {
        target.removeEventListener('contextmenu', handleContextMenu);
    };

    return {
        destroy
    };
}

/**
 * 创建 Tooltip 提示框 (参考 PrimeVue Tooltip)
 * @param {Object} options 配置选项
 * @param {HTMLElement} options.target 触发元素
 * @param {string} options.content 提示内容
 * @param {string} [options.position='top'] 提示框位置 ('top', 'bottom', 'left', 'right')
 * @returns {Object} 包含 destroy 方法的对象
 */
export function createTooltip(options) {
    const {
        target,
        content,
        position = 'top'
    } = options;

    let tooltip = null;
    let showTimeout = null;
    let hideTimeout = null;

    // 创建 tooltip 元素
    const createTooltipElement = () => {
        tooltip = document.createElement('div');
        tooltip.className = 'pa-tooltip';
        tooltip.textContent = content;

        // 创建箭头
        const arrow = document.createElement('div');
        arrow.className = 'pa-tooltip-arrow';
        tooltip.appendChild(arrow);

        document.body.appendChild(tooltip);
    };

    // 定位 tooltip
    const positionTooltip = () => {
        if (!tooltip) return;

        const targetRect = target.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();

        let top, left;
        let arrowClass = '';

        switch (position) {
            case 'top':
                top = targetRect.top - tooltipRect.height - 8;
                left = targetRect.left + (targetRect.width / 2) - (tooltipRect.width / 2);
                arrowClass = 'bottom';
                break;
            case 'bottom':
                top = targetRect.bottom + 8;
                left = targetRect.left + (targetRect.width / 2) - (tooltipRect.width / 2);
                arrowClass = 'top';
                break;
            case 'left':
                top = targetRect.top + (targetRect.height / 2) - (tooltipRect.height / 2);
                left = targetRect.left - tooltipRect.width - 8;
                arrowClass = 'right';
                break;
            case 'right':
                top = targetRect.top + (targetRect.height / 2) - (tooltipRect.height / 2);
                left = targetRect.right + 8;
                arrowClass = 'left';
                break;
        }

        // 边界检查
        const margin = 10;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        if (left < margin) {
            left = margin;
        } else if (left + tooltipRect.width > viewportWidth - margin) {
            left = viewportWidth - tooltipRect.width - margin;
        }

        if (top < margin) {
            top = margin;
        } else if (top + tooltipRect.height > viewportHeight - margin) {
            top = viewportHeight - tooltipRect.height - margin;
        }

        tooltip.style.top = `${top}px`;
        tooltip.style.left = `${left}px`;

        const arrow = tooltip.querySelector('.pa-tooltip-arrow');
        if (arrow) {
            arrow.className = `pa-tooltip-arrow ${arrowClass}`;
        }
    };

    // 显示 tooltip
    const showTooltip = () => {
        clearTimeout(hideTimeout);
        showTimeout = setTimeout(() => {
            if (!tooltip) {
                createTooltipElement();
            }
            positionTooltip();
            requestAnimationFrame(() => {
                tooltip.classList.add('pa-tooltip-show');
            });
        }, 200); // 延迟 200ms 显示
    };

    // 隐藏 tooltip
    const hideTooltip = () => {
        clearTimeout(showTimeout);
        if (tooltip) {
            tooltip.classList.remove('pa-tooltip-show');
            hideTimeout = setTimeout(() => {
                if (tooltip && tooltip.parentNode) {
                    tooltip.parentNode.removeChild(tooltip);
                    tooltip = null;
                }
            }, 150);
        }
    };

    // 绑定事件
    target.addEventListener('mouseenter', showTooltip);
    target.addEventListener('mouseleave', hideTooltip);

    // 销毁方法
    const destroy = () => {
        clearTimeout(showTimeout);
        clearTimeout(hideTimeout);
        target.removeEventListener('mouseenter', showTooltip);
        target.removeEventListener('mouseleave', hideTooltip);
        if (tooltip && tooltip.parentNode) {
            tooltip.parentNode.removeChild(tooltip);
        }
        tooltip = null;
    };

    return {
        destroy
    };
}

/**
 * 创建多选 Listbox 组件
 * @param {Object} options 配置选项
 * @param {HTMLElement} options.triggerElement 触发元素（按钮），用于定位
 * @param {string} options.placeholder 搜索框占位符
 * @param {Function} options.fetchItems 异步获取数据的函数，返回 Promise<Array>
 * @param {Function} options.onConfirm 确认选择回调，参数为选中项数组
 * @param {Function} options.onCancel 取消回调（可选）
 * @returns {void}
 */
export function createMultiSelectListbox(options) {
    const {
        triggerElement,
        placeholder = '搜索...',
        fetchItems,
        onConfirm,
        onCancel = null
    } = options;

    // 获取触发按钮的位置
    const btnRect = triggerElement.getBoundingClientRect();

    // 创建listbox容器
    const listbox = document.createElement('div');
    listbox.className = 'pa-multi-listbox';

    // 创建搜索框容器
    const searchContainer = document.createElement('div');
    searchContainer.className = 'pa-multi-listbox-search';

    const searchWrapper = document.createElement('div');
    searchWrapper.className = 'pa-multi-listbox-search-wrapper';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = placeholder;
    searchInput.className = 'pa-multi-listbox-search-input';

    const searchIcon = document.createElement('i');
    searchIcon.className = 'pi pi-search pa-multi-listbox-search-icon';

    searchWrapper.appendChild(searchInput);
    searchWrapper.appendChild(searchIcon);
    searchContainer.appendChild(searchWrapper);
    listbox.appendChild(searchContainer);

    // 创建列表容器
    const listContainer = document.createElement('div');
    listContainer.className = 'pa-multi-listbox-content';
    listbox.appendChild(listContainer);

    // 创建底部操作栏
    const footer = document.createElement('div');
    footer.className = 'pa-multi-listbox-footer';

    const countLabel = document.createElement('span');
    countLabel.className = 'pa-multi-listbox-count';
    countLabel.textContent = '已选 0 项';

    const actions = document.createElement('div');
    actions.className = 'pa-multi-listbox-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'p-button p-component p-button-secondary p-button-sm';
    cancelBtn.innerHTML = '<span class="p-button-icon-left pi pi-times"></span><span class="p-button-label">取消</span>';

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'p-button p-component p-button-sm';
    confirmBtn.innerHTML = '<span class="p-button-icon-left pi pi-check"></span><span class="p-button-label">确定</span>';
    confirmBtn.disabled = true;

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);

    footer.appendChild(countLabel);
    footer.appendChild(actions);
    listbox.appendChild(footer);

    // 数据存储
    let allItems = [];
    let selectedItems = new Set();

    // 显示loading状态
    const showLoading = () => {
        listContainer.innerHTML = `
            <div class="loading-container">
                <div class="loading-spinner"></div>
                <div class="loading-text">加载中...</div>
            </div>
        `;
    };

    // 显示错误信息
    const showError = (message) => {
        listContainer.innerHTML = `
            <div style="text-align: center; padding: 40px 20px;">
                <div style="font-size: 48px; margin-bottom: 16px;">⚠️</div>
                <div style="font-size: 14px; color: var(--p-text-color); margin-bottom: 8px;">加载失败</div>
                <div style="font-size: 13px; color: var(--p-red-500);">${message}</div>
                <div style="font-size: 12px; color: var(--p-text-muted-color); margin-top: 12px;">你仍然可以在搜索框中手动输入模型名称</div>
            </div>
        `;
        // 不禁用搜索框,允许用户手动输入模型名称
    };

    // 更新选中计数
    const updateCount = () => {
        countLabel.textContent = `已选 ${selectedItems.size} 项`;
        // 如果有选中项或搜索框有内容,则启用确认按钮
        const hasInput = searchInput.value.trim().length > 0;
        confirmBtn.disabled = selectedItems.size === 0 && !hasInput;
    };

    // 渲染列表
    const renderList = (searchTerm = '') => {
        listContainer.innerHTML = '';

        const filteredItems = searchTerm
            ? allItems.filter(item => item.toLowerCase().includes(searchTerm.toLowerCase()))
            : allItems;

        if (filteredItems.length === 0) {
            const emptyHint = document.createElement('div');
            emptyHint.className = 'pa-multi-listbox-empty';
            emptyHint.textContent = searchTerm ? '未找到匹配项' : '暂无可用项';
            listContainer.appendChild(emptyHint);
            return;
        }

        filteredItems.forEach(itemName => {
            const item = document.createElement('div');
            item.className = 'pa-multi-listbox-item';
            if (selectedItems.has(itemName)) {
                item.classList.add('selected');
            }

            const checkbox = document.createElement('div');
            checkbox.className = 'pa-multi-listbox-checkbox';

            const label = document.createElement('span');
            label.textContent = itemName;

            item.appendChild(checkbox);
            item.appendChild(label);

            // 点击切换选中状态
            item.addEventListener('click', () => {
                if (selectedItems.has(itemName)) {
                    selectedItems.delete(itemName);
                    item.classList.remove('selected');
                } else {
                    selectedItems.add(itemName);
                    item.classList.add('selected');
                }
                updateCount();
            });

            listContainer.appendChild(item);
        });
    };

    // 初始化数据
    const initialize = async () => {
        showLoading();
        try {
            const items = await fetchItems();
            if (!items || !Array.isArray(items)) {
                throw new Error('数据格式错误');
            }
            allItems = items;
            renderList();
        } catch (error) {
            showError(error.message || '未知错误');
        }
    };

    // 搜索框事件
    searchInput.addEventListener('input', (e) => {
        renderList(e.target.value);
        updateCount(); // 输入时更新按钮状态
    });

    // 取消按钮
    cancelBtn.addEventListener('click', () => {
        if (onCancel) {
            onCancel();
        }
        close();
    });

    // 确定按钮
    confirmBtn.addEventListener('click', () => {
        const selected = Array.from(selectedItems);
        const searchValue = searchInput.value; // 获取搜索框的值
        onConfirm(selected, searchValue); // 将搜索框的值作为第二个参数传递
        close();
    });

    // 创建透明背景层
    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        z-index: var(--settings-multi-listbox-z-index);
    `;

    overlay.appendChild(listbox);
    document.body.appendChild(overlay);

    // 计算并设置位置（右对齐按钮，自适应上下）
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const listboxHeight = 400; // max-height
    const spaceBelow = viewportHeight - btnRect.bottom;
    const spaceAbove = btnRect.top;

    if (spaceBelow >= listboxHeight || spaceBelow > spaceAbove) {
        // 显示在按钮下方
        listbox.style.top = `${btnRect.bottom + 4}px`;
    } else {
        // 显示在按钮上方
        listbox.style.bottom = `${viewportHeight - btnRect.top + 4}px`;
    }

    // 右对齐按钮
    listbox.style.right = `${viewportWidth - btnRect.right}px`;

    // 关闭函数
    const close = () => {
        if (overlay.parentNode) {
            document.body.removeChild(overlay);
        }
    };

    // 点击背景关闭
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            if (onCancel) {
                onCancel();
            }
            close();
        }
    });

    // 初始化数据
    initialize();

    // 聚焦搜索框
    setTimeout(() => searchInput.focus(), 100);
}

/**
 * 创建 SplitButton 组件 (参考 PrimeVue SplitButton)
 * @param {Object} options 配置选项
 * @param {string} options.label 按钮文本
 * @param {string} options.icon 按钮图标
 * @param {string} options.className 自定义类名
 * @param {Function} options.onClick 主按钮点击回调
 * @param {Array} options.items 下拉菜单项 [{label, icon, command, separator, checked, disabled}]
 * @returns {Object} { container, updateLabel, updateIcon, updateMenu, setMainButtonDisabled, setMenuButtonDisabled }
 */
export function createSplitButton(options) {
    const { label = '', icon = '', className = '', onClick = () => { }, items = [], align = 'left' } = options;

    const container = document.createElement('div');
    container.className = `p-splitbutton p-component${className ? ' ' + className : ''}`;
    container.style.display = 'inline-flex';
    container.style.position = 'relative';

    // 1. 主按钮
    const mainKey = document.createElement('button');
    mainKey.className = 'p-button p-component p-button-text p-button-sm';
    mainKey.type = 'button';
    mainKey.style.borderTopRightRadius = '0';
    mainKey.style.borderBottomRightRadius = '0';
    mainKey.style.borderRight = '0 none';

    // 内容容器
    const mainContent = document.createElement('span');
    mainContent.className = 'p-button-label p-c';
    mainContent.style.display = 'flex';
    mainContent.style.alignItems = 'center';
    mainContent.style.gap = '0.5rem';

    const renderMainButton = (text, iconClass, spinning = false) => {
        mainContent.innerHTML = '';
        if (iconClass) {
            const i = document.createElement('span');
            i.className = `p-button-icon p-button-icon-left ${iconClass} ${spinning ? 'spinning' : ''}`;
            mainContent.appendChild(i);
        }
        const span = document.createElement('span');
        span.className = 'p-button-label';
        span.textContent = text;
        mainContent.appendChild(span);

        // 更新 stored data for subsequent updates via updateIcon
        mainKey.dataset.label = text;
        mainKey.dataset.icon = iconClass || '';
    };

    renderMainButton(label, icon);
    mainKey.appendChild(mainContent);
    mainKey.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick(e);
    });

    // 2. 下拉触发按钮
    const menuBtn = document.createElement('button');
    menuBtn.className = 'p-button p-component p-button-icon-only p-button-text p-button-sm p-splitbutton-menubutton';
    menuBtn.type = 'button';
    menuBtn.style.borderTopLeftRadius = '0';
    menuBtn.style.borderBottomLeftRadius = '0';
    menuBtn.innerHTML = '<span class="p-button-icon pi pi-chevron-down"></span>';

    container.appendChild(mainKey);
    container.appendChild(menuBtn);

    // 3. 下拉菜单
    const menuPanel = document.createElement('div');
    menuPanel.className = 'pa-context-menu pa-split-button-menu';
    menuPanel.style.display = 'none';
    menuPanel.style.position = 'fixed';
    menuPanel.style.minWidth = '12rem';
    // z-index 由 CSS 的 --settings-context-menu-z-index 变量管理

    const menuList = document.createElement('ul');
    menuList.className = 'pa-context-menu-list';
    menuList.setAttribute('role', 'menu');
    menuPanel.appendChild(menuList);
    document.body.appendChild(menuPanel);

    let currentItems = items;
    let isOpen = false;
    let submenuPanels = []; // 存储所有子菜单面板，用于关闭时清理

    // 创建单个菜单项（支持二级子菜单）
    const createMenuItem = (item, parentPanel) => {
        if (item.separator) {
            const sep = document.createElement('li');
            sep.className = 'pa-context-menu-separator';
            sep.setAttribute('role', 'separator');
            return sep;
        }

        const li = document.createElement('li');
        li.className = 'pa-context-menu-item';
        li.setAttribute('role', 'menuitem');
        if (item.disabled) li.classList.add('disabled');

        const itemContent = document.createElement('div');
        itemContent.className = 'pa-context-menu-item-content';

        // Icon logic
        let iconHtml = '';
        if (typeof item.checked === 'boolean') {
            const checkIcon = item.checked ? 'pi pi-check' : '';
            iconHtml = `<span class="pa-context-menu-item-icon ${checkIcon}"></span>`;
        } else if (item.icon) {
            iconHtml = `<span class="pa-context-menu-item-icon ${item.icon}"></span>`;
        } else {
            iconHtml = '<span class="pa-context-menu-item-icon"></span>';
        }

        // 检查是否有子菜单
        const hasSubmenu = item.items && item.items.length > 0;

        itemContent.innerHTML = `
            ${iconHtml}
            <span class="pa-context-menu-item-label">${item.label}</span>
            ${hasSubmenu ? '<span class="pa-context-menu-submenu-icon pi pi-chevron-right"></span>' : ''}
        `;

        li.appendChild(itemContent);

        // 如果有子菜单
        if (hasSubmenu) {
            li.classList.add('pa-context-menu-item-has-submenu');

            // 创建子菜单面板
            const submenuPanel = document.createElement('div');
            submenuPanel.className = 'pa-context-menu pa-context-submenu';
            submenuPanel.style.display = 'none';
            submenuPanel.style.position = 'fixed';

            const submenuList = document.createElement('ul');
            submenuList.className = 'pa-context-menu-list';
            submenuList.setAttribute('role', 'menu');

            item.items.forEach(subItem => {
                const subLi = createMenuItem(subItem, submenuPanel);
                submenuList.appendChild(subLi);
            });

            submenuPanel.appendChild(submenuList);
            document.body.appendChild(submenuPanel);

            // 将子菜单面板添加到列表中，用于关闭时清理
            submenuPanels.push(submenuPanel);

            let submenuTimeout = null;

            // 显示子菜单
            const showSubmenu = () => {
                clearTimeout(submenuTimeout);
                submenuPanel.style.display = 'block';
                submenuPanel.style.zIndex = parseInt(menuPanel.style.zIndex || getComfyUIDialogZIndex()) + 5;
                submenuPanel.classList.add('pa-context-menu-show');

                // 定位子菜单
                const liRect = li.getBoundingClientRect();
                const submenuRect = submenuPanel.getBoundingClientRect();
                const viewportWidth = window.innerWidth;
                const viewportHeight = window.innerHeight;

                let left = liRect.right + 2;
                let top = liRect.top;

                // 如果右边空间不够，显示在左边
                if (left + submenuRect.width > viewportWidth - 10) {
                    left = liRect.left - submenuRect.width - 2;
                }

                // 垂直边界检查
                if (top + submenuRect.height > viewportHeight - 10) {
                    top = viewportHeight - submenuRect.height - 10;
                }
                if (top < 10) top = 10;

                submenuPanel.style.left = `${left}px`;
                submenuPanel.style.top = `${top}px`;
            };

            // 隐藏子菜单
            const hideSubmenu = () => {
                submenuTimeout = setTimeout(() => {
                    submenuPanel.classList.remove('pa-context-menu-show');
                    submenuPanel.classList.add('pa-context-menu-hide');
                    setTimeout(() => {
                        submenuPanel.style.display = 'none';
                        submenuPanel.classList.remove('pa-context-menu-hide');
                    }, 150);
                }, 100);
            };

            // 鼠标进入父项显示子菜单
            li.addEventListener('mouseenter', showSubmenu);
            li.addEventListener('mouseleave', hideSubmenu);

            // 保持子菜单打开（当鼠标在子菜单上时）
            submenuPanel.addEventListener('mouseenter', () => {
                clearTimeout(submenuTimeout);
            });
            submenuPanel.addEventListener('mouseleave', hideSubmenu);

        } else if (!item.disabled) {
            // 无子菜单且未禁用，绑定点击事件
            li.addEventListener('click', (e) => {
                e.stopPropagation();
                if (item.command) {
                    item.command({ originalEvent: e, item });
                }
                closeMenu();
            });
        }

        return li;
    };

    const renderMenu = () => {
        // 先清理之前的子菜单面板
        submenuPanels.forEach(panel => {
            if (panel.parentNode) {
                panel.parentNode.removeChild(panel);
            }
        });
        submenuPanels = [];

        menuList.innerHTML = '';
        currentItems.forEach(item => {
            const li = createMenuItem(item, menuPanel);
            menuList.appendChild(li);
        });
    };

    const updatePosition = () => {
        if (!isOpen) return;
        const containerRect = container.getBoundingClientRect();

        // 先确保面板是显示的以便获取宽度
        menuPanel.style.display = 'block';
        const panelRect = menuPanel.getBoundingClientRect();

        let left = containerRect.left;
        let top = containerRect.bottom + 2;

        if (align === 'right') {
            left = containerRect.right - panelRect.width;
        }

        // 边界检查：防止溢出屏幕右侧
        if (left + panelRect.width > window.innerWidth) {
            left = window.innerWidth - panelRect.width - 5;
        }
        // 边界检查：防止溢出屏幕左侧
        if (left < 0) left = 5;

        menuPanel.style.top = `${top}px`;
        menuPanel.style.left = `${left}px`;
    };

    const closeMenu = () => {
        if (!isOpen) return;
        isOpen = false;

        // 清理所有子菜单面板
        submenuPanels.forEach(panel => {
            if (panel.parentNode) {
                panel.parentNode.removeChild(panel);
            }
        });
        submenuPanels = [];

        menuPanel.classList.remove('pa-context-menu-show');
        menuPanel.classList.add('pa-context-menu-hide');

        setTimeout(() => {
            menuPanel.style.display = 'none';
            menuPanel.classList.remove('pa-context-menu-hide');
        }, 150);

        window.removeEventListener('resize', updatePosition);
        window.removeEventListener('scroll', updatePosition, true);
        document.removeEventListener('click', outsideClickListener);
    };

    const openMenu = () => {
        if (isOpen) {
            closeMenu();
            return;
        }
        isOpen = true;

        // 支持动态获取菜单项 (如果 items 是函数)
        if (typeof options.items === 'function') {
            currentItems = options.items();
        }

        renderMenu(); // Render fresh on open to catch state changes
        menuPanel.style.display = 'block';
        // 动态计算 z-index，确保在 ComfyUI 弹窗之上
        menuPanel.style.zIndex = getComfyUIDialogZIndex() + 20;
        menuPanel.classList.add('pa-context-menu-show');
        updatePosition();

        window.addEventListener('resize', updatePosition);
        window.addEventListener('scroll', updatePosition, true);
        setTimeout(() => document.addEventListener('click', outsideClickListener), 0);
    };

    const outsideClickListener = (e) => {
        if (!menuPanel.contains(e.target) && !menuBtn.contains(e.target) && !container.contains(e.target)) {
            closeMenu();
        }
    };

    menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openMenu();
    });

    return {
        container,
        updateLabel: (text) => renderMainButton(text, mainKey.dataset.icon),
        updateIcon: (newIcon, spinning) => renderMainButton(mainKey.dataset.label, newIcon, spinning),
        updateMainButton: (text, newIcon, spinning) => renderMainButton(text, newIcon, spinning),
        updateMenu: (newItems) => {
            currentItems = newItems;
            if (isOpen) renderMenu();
        },
        setMainButtonDisabled: (disabled) => { mainKey.disabled = disabled; },
        setMenuButtonDisabled: (disabled) => { menuBtn.disabled = disabled; },
        destroy: () => {
            // Cleanup if needed
            if (menuPanel && menuPanel.parentNode) menuPanel.parentNode.removeChild(menuPanel);
            // Remove listeners... (handled by closure mostly, but good practice if needed)
        }
    };
}

/**
 * 创建 SelectButton 组件 (参考 PrimeVue SelectButton)
 * 支持单选、多选、切换三种模式
 * @param {string} label 标签文本
 * @param {Array<Object>} options 选项数组，每个选项包含 { value: string, label: string, icon?: string, disabled?: boolean }
 * @param {string|Array<string>} initialValue 初始值，单选为字符串，多选为数组
 * @param {Object} config 配置选项
 * @param {string} config.mode 模式：'single'(单选), 'multiple'(多选), 'toggle'(切换，相当于开关)
 * @param {string} config.size 尺寸：'small', 'normal', 'large'
 * @param {boolean} config.allowEmpty 是否允许全部不选（仅多选模式有效）
 * @param {Function} config.onChange 值变化回调函数
 * @returns {Object} { group: HTMLElement, getValue: Function, setValue: Function }
 */
export function createSelectButtonGroup(label, options, initialValue, config = {}) {
    const {
        mode = 'multiple',
        size = 'normal',
        allowEmpty = true,
        onChange = null
    } = config;

    // ---创建容器---
    const group = document.createElement('div');
    group.className = 'pa-form-group pa-select-button-group';

    // 标签
    if (label) {
        const labelEl = document.createElement('label');
        labelEl.className = 'pa-form-label';
        labelEl.textContent = label;
        group.appendChild(labelEl);
    }

    // 按钮容器
    const buttonContainer = document.createElement('div');
    buttonContainer.className = `pa-select-button pa-select-button-${size}`;

    // 当前选中值
    let currentValue = mode === 'multiple'
        ? (Array.isArray(initialValue) ? [...initialValue] : [])
        : initialValue;

    // 渲染选项按钮
    const renderButtons = () => {
        buttonContainer.innerHTML = '';

        options.forEach((option, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'pa-select-button-item';

            // 判断是否选中
            const isSelected = mode === 'multiple'
                ? currentValue.includes(option.value)
                : currentValue === option.value;

            if (isSelected) {
                button.classList.add('pa-select-button-item-selected');
            }

            if (option.disabled) {
                button.classList.add('pa-select-button-item-disabled');
                button.disabled = true;
            }

            // 图标
            if (option.icon) {
                const icon = document.createElement('span');
                icon.className = `pa-select-button-icon pi ${option.icon}`;
                button.appendChild(icon);
            }

            // 标签
            if (option.label) {
                const labelSpan = document.createElement('span');
                labelSpan.className = 'pa-select-button-label';
                labelSpan.textContent = option.label;
                button.appendChild(labelSpan);
            }

            // 点击事件
            if (!option.disabled) {
                button.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleClick(option.value);
                });
            }

            buttonContainer.appendChild(button);
        });
    };

    // 处理点击事件
    const handleClick = (value) => {
        const prevValue = mode === 'multiple' ? [...currentValue] : currentValue;

        if (mode === 'multiple') {
            // 多选模式：切换选中状态
            const index = currentValue.indexOf(value);
            if (index === -1) {
                currentValue.push(value);
            } else {
                // 检查是否允许取消选择
                if (allowEmpty || currentValue.length > 1) {
                    currentValue.splice(index, 1);
                }
            }
        } else if (mode === 'toggle') {
            // 切换模式：点击切换开关状态
            currentValue = currentValue === value ? null : value;
        } else {
            // 单选模式：直接选中
            currentValue = value;
        }

        // 重新渲染按钮
        renderButtons();

        // 触发回调
        if (onChange) {
            onChange(currentValue, prevValue);
        }
    };

    // 初始渲染
    renderButtons();
    group.appendChild(buttonContainer);

    // ---返回组件API---
    return {
        group,
        getValue: () => mode === 'multiple' ? [...currentValue] : currentValue,
        setValue: (newValue) => {
            currentValue = mode === 'multiple'
                ? (Array.isArray(newValue) ? [...newValue] : [])
                : newValue;
            renderButtons();
        },
        setOptions: (newOptions) => {
            options = newOptions;
            renderButtons();
        }
    };
}
