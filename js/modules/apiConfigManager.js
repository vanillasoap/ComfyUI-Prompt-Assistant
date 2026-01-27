/**
 * API Configuration Manager v2.0
 * Supports dynamic service provider management and multi-model configuration
 */

import { app } from "../../../../scripts/app.js";
import { logger } from '../utils/logger.js';
import {
    createSettingsDialog,
    createFormGroup,
    createInputGroup,
    createSelectGroup,
    createHorizontalFormGroup,
    createSwitchControl,
    createConfirmPopup,
    createContextMenu,
    createTooltip,
    createMultiSelectListbox
} from "./uiComponents.js";
import { APIService } from "../services/api.js";

// Sortable library loaded via script tag, using global variable directly

class APIConfigManager {
    // Preset service provider ID list (cannot be edited/deleted)
    static PRESET_SERVICE_IDS = ['zhipu', 'xFlow', 'ollama'];

    constructor() {
        // Service provider data
        this.services = [];
        this.currentServices = { llm: null, vlm: null };

        // Baidu Translate configuration
        this.baiduConfig = { app_id: '', secret_key: '' };
    }

    /**
     * Notify system that API configuration has been updated
     * Triggers pa-config-updated event to notify settings.js and other modules to refresh
     */
    notifyConfigChange() {
        logger.debug('Dispatching API configuration update event: pa-config-updated');
        window.dispatchEvent(new CustomEvent('pa-config-updated'));
    }

    /**
     * Show API configuration dialog
     */
    async showAPIConfigModal() {
        try {
            logger.debug('Opening API configuration dialog v2.0');

            createSettingsDialog({
                title: '<i class="pi pi-cog" style="margin-right: 8px;"></i>API Manager',
                dialogClassName: 'api-config-dialog-v2',
                disableBackdropAndCloseOnClickOutside: true,
                hideFooter: true,  // Hide footer save/cancel buttons
                renderNotice: (noticeArea) => {
                    const subtitle = document.createElement('div');
                    subtitle.className = 'api-config-warning';
                    subtitle.textContent = '*Disclaimer: This plugin only provides API calling tools. Third-party service responsibilities are unrelated to this plugin. All user configuration data is stored locally. This plugin assumes no responsibility for any issues arising from account usage!';
                    noticeArea.appendChild(subtitle);
                },
                renderContent: async (container) => {
                    await this._loadAllConfigs();
                    this._createAPIConfigUI(container);
                },
                onSave: async () => {
                    // No longer need manual save since it saves in real-time
                }
            });
        } catch (error) {
            logger.error(`Failed to open API configuration dialog: ${error.message}`);
            app.extensionManager.toast.add({
                severity: "error",
                summary: "Failed to open configuration",
                detail: error.message,
                life: 3000
            });
        }
    }

    /**
     * Load all configurations
     */
    async _loadAllConfigs() {
        try {
            // Load service provider list
            const servicesRes = await fetch(APIService.getApiUrl('/services'));
            const servicesData = await servicesRes.json();

            if (servicesData.success) {
                this.services = servicesData.services || [];
            }

            // Load Baidu Translate configuration
            const baiduRes = await fetch(APIService.getApiUrl('/config/baidu_translate'));
            this.baiduConfig = await baiduRes.json();

            // Load current service configuration to get current_services
            const llmRes = await fetch(APIService.getApiUrl('/config/llm'));
            const llmConfig = await llmRes.json();
            if (llmConfig.provider) {
                this.currentServices.llm = llmConfig.provider;
            }

            const vlmRes = await fetch(APIService.getApiUrl('/config/vision'));
            const vlmConfig = await vlmRes.json();
            if (vlmConfig.provider) {
                this.currentServices.vlm = vlmConfig.provider;
            }

            logger.debug('Configuration loaded successfully', {
                services: this.services.length,
                currentLLM: this.currentServices.llm,
                currentVLM: this.currentServices.vlm
            });
        } catch (error) {
            logger.error('Failed to load configuration', error);
            throw error;
        }
    }

    /**
     * Save all configurations
     */
    async _saveAllConfigs() {
        try {
            // Save Baidu Translate configuration
            await fetch(APIService.getApiUrl('/config/baidu_translate'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.baiduConfig)
            });

            app.extensionManager.toast.add({
                severity: "success",
                summary: "Configuration saved",
                life: 3000
            });
        } catch (error) {
            logger.error('Failed to save configuration', error);
            app.extensionManager.toast.add({
                severity: "error",
                summary: "Save failed",
                detail: error.message,
                life: 3000
            });
            throw error;
        }
    }

    /**
     * Save Baidu Translate configuration
     */
    async _saveBaiduConfig() {
        try {
            await fetch(APIService.getApiUrl('/config/baidu_translate'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.baiduConfig)
            });

            logger.debug('Baidu Translate configuration saved');

            // Trigger configuration sync event
            this.notifyConfigChange();

            // Show success notification
            app.extensionManager.toast.add({
                severity: "success",
                summary: "Baidu Translate configuration saved",
                life: 2000
            });
        } catch (error) {
            logger.error('Failed to save Baidu Translate configuration', error);
            app.extensionManager.toast.add({
                severity: "error",
                summary: "Save failed",
                detail: error.message,
                life: 3000
            });
        }
    }

    /**
     * Create API configuration UI
     */
    _createAPIConfigUI(container) {
        // Create tab container
        const tabContainer = document.createElement('div');
        tabContainer.className = 'api-config-tabs';

        // Create tab header (dynamically generate all service provider tabs)
        const tabHeader = this._createTabHeader();
        tabContainer.appendChild(tabHeader);

        // Create tab content container
        const tabContent = document.createElement('div');
        tabContent.className = 'tab-content';

        // Create Baidu Translate tab
        const baiduContent = this._createBaiduTab();
        tabContent.appendChild(baiduContent);

        // Dynamically create tab content for each service provider
        this.services.forEach(service => {
            const serviceContent = this._createServiceContentTab(service);
            tabContent.appendChild(serviceContent);
        });

        tabContainer.appendChild(tabContent);
        container.appendChild(tabContainer);

        // Show first tab by default
        this._switchTab('baidu', tabHeader, tabContent);
    }

    /**
     * Create tab header (including all service providers)
     */
    _createTabHeader() {
        const header = document.createElement('div');
        header.className = 'tab-header';

        // Baidu Translate tab
        const baiduTab = this._createTabButton('baidu', 'Baidu Translate', 'Machine Translation');
        header.appendChild(baiduTab);

        // Dynamically create service provider tabs
        this.services.forEach(service => {
            const tabButton = this._createTabButton(
                service.id,
                service.name || 'Unnamed Service',
                service.description || ''
            );
            header.appendChild(tabButton);
        });

        // Create "+" add tab button
        const addButton = document.createElement('button');
        addButton.className = 'service-tab-add';
        addButton.innerHTML = '<i class="pi pi-plus"></i>';
        addButton.addEventListener('click', () => this._addNewService(header, header.nextElementSibling));
        header.appendChild(addButton);

        // Initialize drag-and-drop sorting
        new Sortable(header, {
            handle: '.tab-button',
            draggable: '.tab-button',
            filter: '.service-tab-add',  // Exclude "+" button
            animation: 150,
            onEnd: async (evt) => {
                await this._updateServicesOrder();
            }
        });

        return header;
    }

    /**
     * Update service provider order
     */
    async _updateServicesOrder() {
        try {
            // Read current tab order from DOM
            const header = document.querySelector('.tab-header');
            const buttons = header.querySelectorAll('.tab-button');
            const serviceIds = [];

            buttons.forEach(btn => {
                const tabId = btn.dataset.tab;
                // Exclude special tabs (e.g., Baidu Translate)
                if (tabId && tabId !== 'baidu') {
                    serviceIds.push(tabId);
                }
            });

            // Call backend API to save order
            const res = await fetch(APIService.getApiUrl('/services/order'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ service_ids: serviceIds })
            });

            const result = await res.json();

            if (result.success) {
                // Update local service list order
                const orderedServices = [];
                serviceIds.forEach(id => {
                    const service = this.services.find(s => s.id === id);
                    if (service) {
                        orderedServices.push(service);
                    }
                });

                // Add services not in orderedServices
                this.services.forEach(s => {
                    if (!orderedServices.find(os => os.id === s.id)) {
                        orderedServices.push(s);
                    }
                });

                this.services = orderedServices;

                logger.debug('Service provider order updated', { order: serviceIds });

                // Trigger configuration sync event
                this.notifyConfigChange();
            } else {
                throw new Error(result.error || 'Failed to update order');
            }
        } catch (error) {
            logger.error('Failed to update service provider order', error);
            app.extensionManager.toast.add({
                severity: "error",
                summary: "Failed to update order",
                detail: error.message,
                life: 3000
            });
        }
    }


    /**
     * Create a single tab button
     */
    _createTabButton(tabId, title, subtitle) {
        const button = document.createElement('button');
        button.className = 'tab-button';
        button.dataset.tab = tabId;

        // Tab title
        const titleEl = document.createElement('div');
        titleEl.className = 'tab-title';
        titleEl.textContent = title;
        button.appendChild(titleEl);

        // Tab subtitle (description)
        if (subtitle) {
            const subtitleEl = document.createElement('div');
            subtitleEl.className = 'tab-subtitle';
            subtitleEl.textContent = subtitle;
            button.appendChild(subtitleEl);
        }

        // Click to switch tab
        button.addEventListener('click', () => {
            this._switchTab(tabId, button.parentElement, button.parentElement.nextElementSibling);
        });

        // Add context menu for service provider tabs (except Baidu Translate and preset providers)
        // Preset providers cannot be edited/deleted; only user-defined providers can use the context menu
        const isPresetService = APIConfigManager.PRESET_SERVICE_IDS.includes(tabId);
        if (tabId !== 'baidu' && !isPresetService) {
            this._attachServiceContextMenu(button, tabId, title);
        }

        return button;
    }

    /**
     * Switch tab
     */
    _switchTab(tabId, header, contentContainer) {
        // Update tab button state
        header.querySelectorAll('.tab-button').forEach(btn => {
            if (btn.dataset.tab === tabId) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });

        // Show corresponding content
        contentContainer.querySelectorAll('.tab-pane').forEach(pane => {
            pane.style.display = pane.dataset.tab === tabId ? 'block' : 'none';
        });
    }

    /**
     * Attach context menu to service tab
     */
    _attachServiceContextMenu(button, serviceId, serviceName) {
        createContextMenu({
            target: button,
            items: [
                {
                    label: 'Edit Service Provider Name',
                    icon: 'pi-pencil',
                    onClick: () => {
                        this._editServiceName(button, serviceId, serviceName);
                    }
                },
                {
                    separator: true
                },
                {
                    label: 'Delete Service',
                    icon: 'pi-trash',
                    danger: true,  // Mark as dangerous action, icon displayed in red
                    onClick: () => {
                        this._deleteService(serviceId, serviceName);
                    }
                }
            ]
        });
    }

    /**
     * Edit service provider name
     */
    _editServiceName(triggerButton, serviceId, currentName) {
        const service = this.services.find(s => s.id === serviceId);
        if (!service) return;

        createConfirmPopup({
            target: triggerButton,
            message: 'Edit Service Provider Info',
            icon: 'pi-pencil',
            position: 'bottom',
            confirmLabel: 'Save',
            cancelLabel: 'Cancel',
            renderFormContent: (formContainer) => {
                // Service provider name input
                const nameInput = createInputGroup('Service Provider Name', 'Enter service provider name');
                nameInput.input.value = service.name || currentName;
                nameInput.input.dataset.fieldName = 'serviceName';
                formContainer.appendChild(nameInput.group);

                // Service provider description input
                const descInput = createInputGroup('Service Provider Description', 'Enter service provider description (optional)');
                descInput.input.value = service.description || '';
                descInput.input.dataset.fieldName = 'serviceDescription';
                formContainer.appendChild(descInput.group);
            },
            onConfirm: async (formContainer) => {
                try {
                    const nameInput = formContainer.querySelector('[data-field-name="serviceName"]');
                    const descInput = formContainer.querySelector('[data-field-name="serviceDescription"]');

                    const newName = nameInput.value.trim();
                    const newDescription = descInput.value.trim();

                    if (!newName) {
                        app.extensionManager.toast.add({
                            severity: "warn",
                            summary: "Please enter a service provider name",
                            life: 2000
                        });
                        throw new Error('Service provider name cannot be empty');
                    }

                    // Update service provider info
                    await this._updateService(serviceId, {
                        name: newName,
                        description: newDescription
                    });

                    // Update button display
                    const titleEl = triggerButton.querySelector('.tab-title');
                    const subtitleEl = triggerButton.querySelector('.tab-subtitle');

                    if (titleEl) {
                        titleEl.textContent = newName;
                    }

                    if (subtitleEl) {
                        subtitleEl.textContent = newDescription;
                    } else if (newDescription) {
                        // If there was no subtitle before, add one now
                        const newSubtitleEl = document.createElement('div');
                        newSubtitleEl.className = 'tab-subtitle';
                        newSubtitleEl.textContent = newDescription;
                        triggerButton.appendChild(newSubtitleEl);
                    }

                    app.extensionManager.toast.add({
                        severity: "success",
                        summary: "Service provider info updated",
                        detail: `${newName} updated successfully`,
                        life: 2000
                    });
                } catch (error) {
                    logger.error('Failed to update service provider info', error);
                    app.extensionManager.toast.add({
                        severity: "error",
                        summary: "Update failed",
                        detail: error.message,
                        life: 3000
                    });
                    throw error;
                }
            }
        });
    }


    /**
     * Create service provider content tab
     */
    _createServiceContentTab(service) {
        const pane = document.createElement('div');
        pane.className = 'tab-pane';
        pane.dataset.tab = service.id;
        pane.style.display = 'none';
        pane.style.padding = '16px';

        // Service provider configuration card (reuse existing card creation logic)
        const card = this._createServiceCard(service);
        pane.appendChild(card);

        return pane;
    }

    /**
     * Add new service provider
     */
    async _addNewService(headerElement, contentElement) {
        // Get trigger button as positioning reference
        const triggerButton = headerElement.querySelector('.service-tab-add');

        // Show confirmation popup
        createConfirmPopup({
            target: triggerButton,
            message: 'Create New Service Provider',
            icon: 'pi-plus-circle',
            position: 'left',
            confirmLabel: 'Create',
            cancelLabel: 'Cancel',
            renderFormContent: (formContainer) => {
                // Service provider name input
                const nameInput = createInputGroup('Service Provider Name', 'Enter service provider name');
                nameInput.input.value = 'New Service Provider';
                nameInput.input.dataset.fieldName = 'serviceName';
                formContainer.appendChild(nameInput.group);

                // Service provider description input
                const descInput = createInputGroup('Service Provider Description', 'Enter service provider description (optional)');
                descInput.input.dataset.fieldName = 'serviceDescription';
                formContainer.appendChild(descInput.group);
            },
            onConfirm: async (formContainer) => {
                try {
                    // Get form data
                    const nameInput = formContainer.querySelector('[data-field-name="serviceName"]');
                    const descInput = formContainer.querySelector('[data-field-name="serviceDescription"]');

                    const serviceName = nameInput.value.trim();
                    const serviceDescription = descInput.value.trim();

                    if (!serviceName) {
                        app.extensionManager.toast.add({
                            severity: "warn",
                            summary: "Please enter a service provider name",
                            life: 2000
                        });
                        throw new Error('Service provider name cannot be empty');
                    }

                    // Create service provider
                    const res = await fetch(APIService.getApiUrl('/services'), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            type: 'openai_compatible',
                            name: serviceName,
                            description: serviceDescription,
                            base_url: 'https://api.example.com/v1',
                            api_key: ''
                        })
                    });

                    const result = await res.json();

                    if (result.success) {
                        app.extensionManager.toast.add({
                            severity: "success",
                            summary: "New service provider created",
                            detail: `${serviceName} created successfully`,
                            life: 3000
                        });

                        // Reload configuration
                        await this._loadAllConfigs();

                        // Get newly created service
                        const newService = this.services.find(s => s.id === result.service_id);
                        if (newService) {
                            // Create new tab button (insert before "+" button)
                            const addButton = headerElement.querySelector('.service-tab-add');
                            const newTabButton = this._createTabButton(
                                newService.id,
                                newService.name || 'Unnamed Service',
                                newService.description || ''
                            );
                            headerElement.insertBefore(newTabButton, addButton);

                            // Create new content tab
                            const newContentPane = this._createServiceContentTab(newService);
                            contentElement.appendChild(newContentPane);

                            // Switch to new tab
                            this._switchTab(newService.id, headerElement, contentElement);
                        }

                        // Trigger configuration sync event
                        this.notifyConfigChange();
                    } else {
                        throw new Error(result.error || 'Creation failed');
                    }
                } catch (error) {
                    logger.error('Failed to create service provider', error);
                    app.extensionManager.toast.add({
                        severity: "error",
                        summary: "Creation failed",
                        detail: error.message,
                        life: 3000
                    });
                    throw error;
                }
            }
        });
    }

    /**
     * Create Baidu Translate tab
     */
    _createBaiduTab() {
        const pane = document.createElement('div');
        pane.className = 'tab-pane';
        pane.dataset.tab = 'baidu';

        const section = createFormGroup('Baidu Translate Configuration', [
            { text: 'Activate Baidu Translate Service', url: 'https://fanyi-api.baidu.com/' }
        ]);
        section.classList.add('baidu-translate-section');

        // Add icon to link for consistency with other services
        const linkElement = section.querySelector('.settings-service-link');
        if (linkElement) {
            const icon = document.createElement('i');
            icon.className = 'pi pi-star';
            icon.style.marginRight = '4px';
            linkElement.insertBefore(icon, linkElement.firstChild);
        }

        const appIdInput = createInputGroup('AppID', 'Enter Baidu Translate AppID');
        appIdInput.input.value = this.baiduConfig.app_id || '';
        appIdInput.input.addEventListener('input', (e) => {
            this.baiduConfig.app_id = e.target.value;
        });
        // Save on blur
        appIdInput.input.addEventListener('blur', async () => {
            await this._saveBaiduConfig();
        });

        const secretInput = createInputGroup('Secret Key', 'Enter Baidu Translate Secret Key');
        secretInput.input.type = 'password';
        secretInput.input.value = this.baiduConfig.secret_key || '';
        secretInput.input.addEventListener('input', (e) => {
            this.baiduConfig.secret_key = e.target.value;
        });
        // Save on blur
        secretInput.input.addEventListener('blur', async () => {
            await this._saveBaiduConfig();
        });

        section.appendChild(appIdInput.group);
        section.appendChild(secretInput.group);
        pane.appendChild(section);

        return pane;
    }

    /**
     * Create generic service provider tab (sub-tab structure)
     */
    _createServicesTab() {
        const pane = document.createElement('div');
        pane.className = 'tab-pane services-tab-pane';
        pane.dataset.tab = 'services';
        // Styles moved to CSS

        // Sub-tab navigation
        const subTabNav = document.createElement('div');
        subTabNav.className = 'service-sub-tabs';
        // Styles moved to CSS

        // Sub-tab content container
        const subTabContent = document.createElement('div');
        subTabContent.className = 'service-sub-content';

        // Get generic service providers
        const genericServices = this.services.filter(s => s.type === 'openai_compatible');

        // Create service provider tabs
        genericServices.forEach((service, index) => {
            // Create tab button
            const tabButton = this._createServiceTabButton(service);
            subTabNav.appendChild(tabButton);

            // Create tab content
            const tabContentPane = this._createServiceTabContent(service);
            subTabContent.appendChild(tabContentPane);

            // Select first by default
            if (index === 0) {
                tabButton.classList.add('active');
                tabContentPane.style.display = 'block';
            }
        });

        // Create "+" add tab button
        const addTabButton = document.createElement('button');
        addTabButton.className = 'service-tab-add';
        addTabButton.textContent = '+';
        addTabButton.addEventListener('click', () => this._addNewServiceTab(subTabNav, subTabContent));
        subTabNav.appendChild(addTabButton);

        // If no service providers exist, show empty state
        if (genericServices.length === 0) {
            const emptyHint = document.createElement('div');
            emptyHint.className = 'empty-state-hint';
            emptyHint.innerHTML = `
                <div style="font-size: 48px; margin-bottom: 16px;">📦</div>
                <div style="font-size: 16px; margin-bottom: 8px;">No Service Providers</div>
                <div style="font-size: 14px;">Click the "+" button in the top right to add your first service provider</div>
            `;
            subTabContent.appendChild(emptyHint);
        }

        pane.appendChild(subTabNav);
        pane.appendChild(subTabContent);
        return pane;
    }

    /**
     * Create service provider tab button
     */
    _createServiceTabButton(service) {
        const button = document.createElement('button');
        button.className = 'service-tab-button';
        button.dataset.serviceId = service.id;

        // Tab title
        const title = document.createElement('div');
        title.className = 'service-tab-title';
        title.textContent = service.name || 'Unnamed Service';

        // Tab subtitle (description)
        const subtitle = document.createElement('div');
        subtitle.className = 'service-tab-subtitle';
        subtitle.textContent = service.description || '';

        button.appendChild(title);
        if (service.description) {
            button.appendChild(subtitle);
        }

        // Click to switch
        button.addEventListener('click', () => {
            this._switchServiceTab(service.id);
        });

        return button;
    }

    /**
     * Switch service provider tab
     */
    _switchServiceTab(serviceId) {
        const container = document.querySelector('.services-tab-pane');
        if (!container) return;

        // Update tab button state
        const buttons = container.querySelectorAll('.service-tab-button');
        buttons.forEach(btn => {
            if (btn.dataset.serviceId === serviceId) {
                btn.classList.add('active');
                btn.style.background = 'var(--p-primary-500)';
                btn.style.color = 'white';
                btn.querySelector('.service-tab-title').style.color = 'white';
                const subtitle = btn.querySelector('.service-tab-subtitle');
                if (subtitle) {
                    subtitle.style.color = 'rgba(255, 255, 255, 0.8)';
                }
            } else {
                btn.classList.remove('active');
                btn.style.background = 'transparent';
                btn.style.color = 'var(--p-text-color)';
                btn.querySelector('.service-tab-title').style.color = 'var(--p-text-color)';
                const subtitle = btn.querySelector('.service-tab-subtitle');
                if (subtitle) {
                    subtitle.style.color = 'var(--p-text-muted-color)';
                }
            }
        });

        // Update content display
        const panes = container.querySelectorAll('.service-content-pane');
        panes.forEach(pane => {
            pane.style.display = pane.dataset.serviceId === serviceId ? 'block' : 'none';
        });
    }

    /**
     * Create service provider tab content
     */
    _createServiceTabContent(service) {
        const contentPane = document.createElement('div');
        contentPane.className = 'service-content-pane';
        contentPane.dataset.serviceId = service.id;
        contentPane.style.cssText = `
            display: none;
        `;

        // Create simple placeholder content here, will be refined later
        const card = this._createServiceCard(service);
        contentPane.appendChild(card);

        return contentPane;
    }

    /**
     * Add new service provider tab
     */
    async _addNewServiceTab(navContainer, contentContainer) {
        // Call backend API to create new service provider
        try {
            const res = await fetch(APIService.getApiUrl('/services'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'openai_compatible',
                    name: 'New Service Provider',
                    description: '',
                    base_url: 'https://api.example.com/v1',
                    api_key: ''
                })
            });

            const result = await res.json();

            if (result.success) {
                app.extensionManager.toast.add({
                    severity: "success",
                    summary: "New service provider created",
                    detail: "Please fill in the configuration",
                    life: 3000
                });

                // Reload configuration
                await this._loadAllConfigs();

                // Get newly created service
                const newService = this.services.find(s => s.id === result.service_id);
                if (newService) {
                    // Create new tab button (insert before "+" button)
                    const newTabButton = this._createServiceTabButton(newService);
                    const addButton = navContainer.querySelector('.service-tab-add');
                    navContainer.insertBefore(newTabButton, addButton);

                    // Create new content
                    const newContentPane = this._createServiceTabContent(newService);
                    contentContainer.appendChild(newContentPane);

                    // Remove empty state hint (if exists)
                    const emptyHint = contentContainer.querySelector('div[style*="No Service Providers"]');
                    if (emptyHint) {
                        emptyHint.remove();
                    }

                    // Switch to new tab
                    this._switchServiceTab(newService.id);
                }
            } else {
                throw new Error(result.error || 'Creation failed');
            }
        } catch (error) {
            logger.error('Failed to create service provider', error);
            app.extensionManager.toast.add({
                severity: "error",
                summary: "Creation failed",
                detail: error.message,
                life: 3000
            });
        }
    }

    /**
     * Create Ollama tab
     */
    _createOllamaTab() {
        const pane = document.createElement('div');
        pane.className = 'tab-pane';
        pane.dataset.tab = 'ollama';
        // Styles moved to CSS

        const ollamaService = this.services.find(s => s.type === 'ollama');

        if (ollamaService) {
            const card = this._createServiceCard(ollamaService);
            pane.appendChild(card);
        } else {
            const hint = document.createElement('div');
            hint.className = 'empty-state-hint-small';
            hint.textContent = 'Ollama service not configured';
            pane.appendChild(hint);
        }

        return pane;
    }

    /**
     * Create service provider card
     */
    _createServiceCard(service) {
        const card = document.createElement('div');
        card.className = 'service-card';
        card.dataset.serviceId = service.id;  // Add serviceId to dataset

        // Service provider title - detect whether to add external link based on service name
        const titleText = service.name || service.id;
        const descText = service.description ? ' Configuration' : '';
        const fullTitle = `1️⃣ ${titleText}${descText}`;

        // Detect service name and add corresponding registration link
        const links = [];
        const serviceName = (service.name || '').toLowerCase();
        const serviceId = (service.id || '').toLowerCase();
        const searchText = `${serviceName} ${serviceId}`.toLowerCase();

        // Zhipu service detection
        if (searchText.includes('智谱') || searchText.includes('zhipu')) {
            links.push({
                text: 'Activate Zhipu API Service',
                url: 'https://www.bigmodel.cn/invite?icode=Wz1tQAT40T9M8vwp%2F1db7nHEaazDlIZGj9HxftzTbt4%3D',
                icon: 'pi-star'
            });
        }

        // SiliconFlow service detection
        if (searchText.includes('硅基') || searchText.includes('siliconflow') || searchText.includes('silicon')) {
            links.push({
                text: 'Activate SiliconFlow API Service',
                url: 'https://cloud.siliconflow.cn/i/FCDL2zBQ',
                icon: 'pi-star'
            });
        }

        // xflow service detection
        if (searchText.includes('xflow')) {
            links.push({
                text: 'Activate xflow API Service',
                url: 'https://api.xflow.cc/register?aff=Z063',
                icon: 'pi-star'
            });
        }

        // Use createFormGroup to create title with links, or plain title
        let titleSection;
        if (links.length > 0) {
            titleSection = createFormGroup(fullTitle, links.map(link => ({
                text: link.text,
                url: link.url
            })));
            // Add icons to links
            const linkElements = titleSection.querySelectorAll('.settings-service-link');
            linkElements.forEach((linkElem, index) => {
                if (links[index] && links[index].icon) {
                    const icon = document.createElement('i');
                    icon.className = `pi ${links[index].icon}`;
                    icon.style.marginRight = '4px';
                    linkElem.insertBefore(icon, linkElem.firstChild);
                }
            });
        } else {
            // No links, create plain title
            titleSection = document.createElement('div');
            titleSection.className = 'settings-form-section';
            const titleElement = document.createElement('h3');
            titleElement.className = 'settings-form-section-title';
            titleElement.textContent = fullTitle;
            titleSection.appendChild(titleElement);
        }

        card.appendChild(titleSection);

        // Basic information
        const baseUrlInput = createInputGroup('Base URL', 'https://api.example.com/v1');
        baseUrlInput.input.value = service.base_url || '';
        baseUrlInput.input.addEventListener('change', async (e) => {
            await this._updateService(service.id, { base_url: e.target.value });
        });

        // API Key input (simplified, using plain text)
        const apiKeyInput = createInputGroup('API Key', 'Enter API Key');
        apiKeyInput.input.type = 'password';
        apiKeyInput.input.value = service.api_key || '';

        // Save on blur
        apiKeyInput.input.addEventListener('blur', async (e) => {
            const newApiKey = e.target.value.trim();
            if (newApiKey !== service.api_key) {
                await this._updateService(service.id, { api_key: newApiKey });
                service.api_key = newApiKey;
            }
        });

        card.appendChild(baseUrlInput.group);
        card.appendChild(apiKeyInput.group);

        // === Service settings area (simplified) ===
        // Create settings item container
        const settingsInlineContainer = document.createElement('div');
        settingsInlineContainer.className = 'service-settings-inline';

        // Chain-of-thought control switch
        const thinkingContainer = document.createElement('div');
        thinkingContainer.className = 'service-setting-item';

        const thinkingLabel = document.createElement('span');
        thinkingLabel.className = 'service-setting-label';
        thinkingLabel.textContent = 'Disable Chain-of-Thought';

        const thinkingIcon = document.createElement('i');
        thinkingIcon.className = 'pi pi-info-circle service-setting-info-icon';

        // Add tooltip
        createTooltip({
            target: thinkingIcon,
            content: 'Disables chain-of-thought for models that support it. Note: Not all models support this. Models with chain-of-thought disabled will show a pencil symbol after the model info in the log.',
            position: 'top'
        });

        const thinkingLabelWrapper = document.createElement('div');
        thinkingLabelWrapper.className = 'service-setting-label-wrapper';
        thinkingLabelWrapper.appendChild(thinkingLabel);
        thinkingLabelWrapper.appendChild(thinkingIcon);

        // Create switch
        const thinkingSwitchWrapper = document.createElement('label');
        thinkingSwitchWrapper.className = 'switch-wrapper';

        const thinkingInput = document.createElement('input');
        thinkingInput.type = 'checkbox';
        thinkingInput.checked = service.disable_thinking ?? true;

        const thinkingSlider = document.createElement('span');
        thinkingSlider.className = `switch-slider${thinkingInput.checked ? ' checked' : ''}`;

        const thinkingButton = document.createElement('span');
        thinkingButton.className = `switch-button${thinkingInput.checked ? ' checked' : ''}`;
        thinkingSlider.appendChild(thinkingButton);

        thinkingInput.addEventListener('change', async (e) => {
            const isChecked = e.target.checked;
            if (isChecked) {
                thinkingSlider.classList.add('checked');
                thinkingButton.classList.add('checked');
            } else {
                thinkingSlider.classList.remove('checked');
                thinkingButton.classList.remove('checked');
            }
            await this._updateService(service.id, { disable_thinking: isChecked });
            service.disable_thinking = isChecked;
        });

        thinkingSwitchWrapper.appendChild(thinkingInput);
        thinkingSwitchWrapper.appendChild(thinkingSlider);

        thinkingContainer.appendChild(thinkingLabelWrapper);
        thinkingContainer.appendChild(thinkingSwitchWrapper);
        settingsInlineContainer.appendChild(thinkingContainer);

        // --- Enable advanced parameters switch ---
        const advancedParamsContainer = document.createElement('div');
        advancedParamsContainer.className = 'service-setting-item';

        const advancedParamsLabel = document.createElement('span');
        advancedParamsLabel.className = 'service-setting-label';
        advancedParamsLabel.textContent = 'Enable Advanced Parameters';

        const advancedParamsIcon = document.createElement('i');
        advancedParamsIcon.className = 'pi pi-info-circle service-setting-info-icon';

        // Add tooltip
        createTooltip({
            target: advancedParamsIcon,
            content: 'When enabled, temperature, top_p, and max_tokens parameters will be sent for fine-grained control of model behavior and limiting max tokens to improve speed. Disabling this can improve compatibility.',
            position: 'top'
        });

        const advancedParamsLabelWrapper = document.createElement('div');
        advancedParamsLabelWrapper.className = 'service-setting-label-wrapper';
        advancedParamsLabelWrapper.appendChild(advancedParamsLabel);
        advancedParamsLabelWrapper.appendChild(advancedParamsIcon);

        // Create switch
        const advancedParamsSwitchWrapper = document.createElement('label');
        advancedParamsSwitchWrapper.className = 'switch-wrapper';

        const advancedParamsInput = document.createElement('input');
        advancedParamsInput.type = 'checkbox';
        advancedParamsInput.checked = service.enable_advanced_params ?? false;

        const advancedParamsSlider = document.createElement('span');
        advancedParamsSlider.className = `switch-slider${advancedParamsInput.checked ? ' checked' : ''}`;

        const advancedParamsButton = document.createElement('span');
        advancedParamsButton.className = `switch-button${advancedParamsInput.checked ? ' checked' : ''}`;
        advancedParamsSlider.appendChild(advancedParamsButton);

        advancedParamsInput.addEventListener('change', async (e) => {
            const isChecked = e.target.checked;
            if (isChecked) {
                advancedParamsSlider.classList.add('checked');
                advancedParamsButton.classList.add('checked');
            } else {
                advancedParamsSlider.classList.remove('checked');
                advancedParamsButton.classList.remove('checked');
            }
            await this._updateService(service.id, { enable_advanced_params: isChecked });
            service.enable_advanced_params = isChecked;
        });

        advancedParamsSwitchWrapper.appendChild(advancedParamsInput);
        advancedParamsSwitchWrapper.appendChild(advancedParamsSlider);

        advancedParamsContainer.appendChild(advancedParamsLabelWrapper);
        advancedParamsContainer.appendChild(advancedParamsSwitchWrapper);
        settingsInlineContainer.appendChild(advancedParamsContainer);

        // --- Filter chain-of-thought output switch ---
        const filterThinkingContainer = document.createElement('div');
        filterThinkingContainer.className = 'service-setting-item';

        const filterThinkingLabel = document.createElement('span');
        filterThinkingLabel.className = 'service-setting-label';
        filterThinkingLabel.textContent = 'Filter Chain-of-Thought Output';

        const filterThinkingIcon = document.createElement('i');
        filterThinkingIcon.className = 'pi pi-info-circle service-setting-info-icon';

        // Add tooltip
        createTooltip({
            target: filterThinkingIcon,
            content: 'For models that cannot disable chain-of-thought, removes thinking process content. Enabled by default.',
            position: 'top'
        });

        const filterThinkingLabelWrapper = document.createElement('div');
        filterThinkingLabelWrapper.className = 'service-setting-label-wrapper';
        filterThinkingLabelWrapper.appendChild(filterThinkingLabel);
        filterThinkingLabelWrapper.appendChild(filterThinkingIcon);

        // Create switch
        const filterThinkingSwitchWrapper = document.createElement('label');
        filterThinkingSwitchWrapper.className = 'switch-wrapper';

        const filterThinkingInput = document.createElement('input');
        filterThinkingInput.type = 'checkbox';
        filterThinkingInput.checked = service.filter_thinking_output ?? true;

        const filterThinkingSlider = document.createElement('span');
        filterThinkingSlider.className = `switch-slider${filterThinkingInput.checked ? ' checked' : ''}`;

        const filterThinkingButton = document.createElement('span');
        filterThinkingButton.className = `switch-button${filterThinkingInput.checked ? ' checked' : ''}`;
        filterThinkingSlider.appendChild(filterThinkingButton);

        filterThinkingInput.addEventListener('change', async (e) => {
            const isChecked = e.target.checked;
            if (isChecked) {
                filterThinkingSlider.classList.add('checked');
                filterThinkingButton.classList.add('checked');
            } else {
                filterThinkingSlider.classList.remove('checked');
                filterThinkingButton.classList.remove('checked');
            }
            await this._updateService(service.id, { filter_thinking_output: isChecked });
            service.filter_thinking_output = isChecked;
        });

        filterThinkingSwitchWrapper.appendChild(filterThinkingInput);
        filterThinkingSwitchWrapper.appendChild(filterThinkingSlider);

        filterThinkingContainer.appendChild(filterThinkingLabelWrapper);
        filterThinkingContainer.appendChild(filterThinkingSwitchWrapper);
        settingsInlineContainer.appendChild(filterThinkingContainer);

        // Ollama exclusive: auto-unload model switch (frontend UI only)
        if (service.type === 'ollama') {
            const autoUnloadContainer = document.createElement('div');
            autoUnloadContainer.className = 'service-setting-item';

            const autoUnloadLabel = document.createElement('span');
            autoUnloadLabel.className = 'service-setting-label';
            autoUnloadLabel.textContent = 'Auto-Unload Model';

            const autoUnloadIcon = document.createElement('i');
            autoUnloadIcon.className = 'pi pi-info-circle service-setting-info-icon';

            // Add tooltip
            createTooltip({
                target: autoUnloadIcon,
                content: 'Automatically unloads the model after request completion to free VRAM. Note: This option applies to the frontend assistant only; nodes have their own separate option.',
                position: 'top'
            });

            const autoUnloadLabelWrapper = document.createElement('div');
            autoUnloadLabelWrapper.className = 'service-setting-label-wrapper';
            autoUnloadLabelWrapper.appendChild(autoUnloadLabel);
            autoUnloadLabelWrapper.appendChild(autoUnloadIcon);

            // Create switch
            const autoUnloadSwitchWrapper = document.createElement('label');
            autoUnloadSwitchWrapper.className = 'switch-wrapper';

            const autoUnloadInput = document.createElement('input');
            autoUnloadInput.type = 'checkbox';
            autoUnloadInput.checked = service.auto_unload !== false;

            const autoUnloadSlider = document.createElement('span');
            autoUnloadSlider.className = `switch-slider${autoUnloadInput.checked ? ' checked' : ''}`;

            const autoUnloadButton = document.createElement('span');
            autoUnloadButton.className = `switch-button${autoUnloadInput.checked ? ' checked' : ''}`;
            autoUnloadSlider.appendChild(autoUnloadButton);

            autoUnloadInput.addEventListener('change', async (e) => {
                const isChecked = e.target.checked;
                if (isChecked) {
                    autoUnloadSlider.classList.add('checked');
                    autoUnloadButton.classList.add('checked');
                } else {
                    autoUnloadSlider.classList.remove('checked');
                    autoUnloadButton.classList.remove('checked');
                }
                await this._updateService(service.id, { auto_unload: isChecked });
                service.auto_unload = isChecked;
            });

            autoUnloadSwitchWrapper.appendChild(autoUnloadInput);
            autoUnloadSwitchWrapper.appendChild(autoUnloadSlider);

            autoUnloadContainer.appendChild(autoUnloadLabelWrapper);
            autoUnloadContainer.appendChild(autoUnloadSwitchWrapper);
            settingsInlineContainer.appendChild(autoUnloadContainer);
        }

        card.appendChild(settingsInlineContainer);

        // LLM models section
        const llmSection = this._createModelSection(service, 'llm');
        card.appendChild(llmSection);

        // VLM models section
        const vlmSection = this._createModelSection(service, 'vlm');
        card.appendChild(vlmSection);

        return card;
    }


    /**
     * Create model configuration section
     */
    _createModelSection(service, modelType) {
        const section = document.createElement('div');
        section.className = 'settings-form-section';
        section.style.marginTop = '16px';

        // Title row (includes model type and + button)
        const titleRow = document.createElement('div');
        titleRow.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
        `;

        const title = document.createElement('h5');
        title.className = 'settings-form-section-title';
        title.textContent = modelType === 'llm' ? '2️⃣ Add LLM for Translation & Prompt Optimization' : '3️⃣ Add VLM for Image & Video Captioning';
        title.style.margin = '0';

        // Add model button
        const addButton = document.createElement('button');
        addButton.className = 'p-button p-component p-button-sm';
        addButton.innerHTML = '<span class="p-button-icon-left pi pi-plus"></span><span class="p-button-label">Add Model</span>';
        addButton.addEventListener('click', () => this._showAddModelDialog(service, modelType, modelsContainer));

        titleRow.appendChild(title);
        titleRow.appendChild(addButton);
        section.appendChild(titleRow);

        // Model tags container (drag-and-drop sortable)
        const modelsContainer = document.createElement('div');
        modelsContainer.className = 'models-container';
        modelsContainer.dataset.serviceId = service.id;
        modelsContainer.dataset.modelType = modelType;

        const models = modelType === 'llm' ? service.llm_models : service.vlm_models;

        if (models && models.length > 0) {
            models.forEach((model) => {
                const modelTag = this._createModelTag(model, service, modelType);
                modelsContainer.appendChild(modelTag);
            });

            // Initialize Sortable drag-and-drop sorting and save instance
            modelsContainer.sortableInstance = new Sortable(modelsContainer, {
                animation: 150,
                ghostClass: 'sortable-ghost',
                handle: '.model-tag',  // Entire tag is draggable
                onEnd: async (evt) => {
                    // Update model order after drag ends
                    await this._updateModelOrder(service.id, modelType, modelsContainer);
                }
            });
        } else {
            const emptyHint = document.createElement('div');
            emptyHint.className = 'empty-hint';
            emptyHint.textContent = 'No models configured. Click "+ Add Model" to get started';
            emptyHint.style.cssText = `
                font-size: 12px;
                color: var(--p-text-muted-color);
                padding: 8px;
            `;
            modelsContainer.appendChild(emptyHint);
        }

        section.appendChild(modelsContainer);

        // Removed fixed advanced settings area - now shows popup when clicking model tag

        return section;
    }

    /**
     * Create model tag
     */
    _createModelTag(model, service, modelType) {
        const tag = document.createElement('div');
        tag.className = `model-tag${model.is_default ? ' default' : ''}`;
        tag.dataset.modelName = model.name;
        tag.dataset.selected = 'false';

        // Model icon
        const iconSpan = document.createElement('i');
        iconSpan.className = 'pi pi-sparkles model-tag-icon';
        tag.appendChild(iconSpan);

        // Model name
        const nameSpan = document.createElement('span');
        nameSpan.className = 'model-tag-name';
        nameSpan.textContent = model.name;
        tag.appendChild(nameSpan);

        // Default badge
        if (model.is_default) {
            const defaultBadge = document.createElement('span');
            defaultBadge.className = 'model-tag-badge';
            defaultBadge.textContent = 'Default';
            tag.appendChild(defaultBadge);
        }

        // Delete button
        const deleteBtn = document.createElement('button');
        deleteBtn.innerHTML = '×';
        deleteBtn.className = 'model-delete-btn';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._deleteModel(service, modelType, model.name, tag);
        });
        tag.appendChild(deleteBtn);

        // --- Click selection state ---
        tag.addEventListener('click', (e) => {
            // If delete button was clicked, do not trigger selection
            if (e.target.closest('.model-delete-btn')) {
                return;
            }
            // Remove selected state from other tags in the same container
            const container = tag.parentElement;
            if (container) {
                container.querySelectorAll('.model-tag.selected').forEach(t => {
                    t.classList.remove('selected');
                });
            }
            // Add selected state to current tag
            tag.classList.add('selected');
        });

        // --- Context menu ---
        // Use function form to dynamically get menu items, ensuring latest model state on each menu display
        const getMenuItems = () => {
            // Get latest model state from local data
            const models = modelType === 'llm' ? service.llm_models : service.vlm_models;
            const currentModel = models.find(m => m.name === model.name);
            const isDefault = currentModel ? currentModel.is_default : false;

            return [
                {
                    label: 'Set as Default Model',
                    icon: 'pi-star',
                    disabled: isDefault, // Dynamically check if already default
                    onClick: () => {
                        this._setDefaultModel(service, modelType, model.name, tag);
                    }
                },
                { separator: true }, // Separator
                {
                    label: 'Edit Model Parameter Settings',
                    icon: 'pi-cog',
                    onClick: () => {
                        this._selectModelForEdit(service, modelType, model.name, tag);
                    }
                }
            ];
        };

        createContextMenu({
            target: tag,
            items: getMenuItems
        });

        return tag;
    }

    /**
     * Select model for editing (show popup)
     */
    _selectModelForEdit(service, modelType, modelName, tagElement) {
        // Save this reference
        const self = this;

        // Get model data
        const models = modelType === 'llm' ? service.llm_models : service.vlm_models;
        const selectedModel = models.find(m => m.name === modelName);

        if (!selectedModel) return;

        // Show popup for parameter editing
        createConfirmPopup({
            target: tagElement,
            message: `Model Parameter Settings`,
            icon: 'pi-cog',
            position: 'top',
            confirmLabel: 'Save',
            cancelLabel: 'Cancel',
            renderFormContent: (formContainer) => {
                // Add horizontal layout class to form container
                formContainer.classList.add('model-params-form');

                // Temperature
                const tempInput = createInputGroup('Temperature', '0.0 - 2.0', 'number');
                tempInput.input.min = '0';
                tempInput.input.max = '2';
                tempInput.input.step = '0.1';
                tempInput.input.value = selectedModel.temperature ?? 0.7;
                tempInput.input.dataset.fieldName = 'temperature';
                tempInput.group.style.width = '135px';
                formContainer.appendChild(tempInput.group);

                // Top-P (Nucleus Sampling)
                const topPInput = createInputGroup('Top-P', '0.0 - 1.0', 'number');
                topPInput.input.min = '0';
                topPInput.input.max = '1';
                topPInput.input.step = '0.1';
                topPInput.input.value = selectedModel.top_p ?? 0.9;
                topPInput.input.dataset.fieldName = 'top_p';
                topPInput.group.style.width = '135px';
                formContainer.appendChild(topPInput.group);

                // Max Tokens
                const maxTokensInput = createInputGroup('Max Tokens', '1 - 8192', 'number');
                maxTokensInput.input.min = '1';
                maxTokensInput.input.max = '8192';
                maxTokensInput.input.step = '1';
                maxTokensInput.input.value = selectedModel.max_tokens ?? 1024;
                maxTokensInput.input.dataset.fieldName = 'max_tokens';
                maxTokensInput.group.style.width = '135px';
                formContainer.appendChild(maxTokensInput.group);
            },
            onConfirm: async (formContainer) => {
                try {
                    // Get form data
                    const temperature = parseFloat(formContainer.querySelector('[data-field-name="temperature"]').value);
                    const top_p = parseFloat(formContainer.querySelector('[data-field-name="top_p"]').value);
                    const max_tokens = parseInt(formContainer.querySelector('[data-field-name="max_tokens"]').value);

                    // Validate data
                    if (isNaN(temperature) || temperature < 0 || temperature > 2) {
                        app.extensionManager.toast.add({
                            severity: "warn",
                            summary: "Invalid temperature value",
                            detail: "Temperature should be between 0 and 2",
                            life: 2000
                        });
                        throw new Error('Invalid temperature value');
                    }

                    if (isNaN(top_p) || top_p < 0 || top_p > 1) {
                        app.extensionManager.toast.add({
                            severity: "warn",
                            summary: "Invalid Top-P value",
                            detail: "Top-P should be between 0 and 1",
                            life: 2000
                        });
                        throw new Error('Invalid Top-P value');
                    }

                    if (isNaN(max_tokens) || max_tokens < 1 || max_tokens > 8192) {
                        app.extensionManager.toast.add({
                            severity: "warn",
                            summary: "Invalid Max Tokens value",
                            detail: "Max Tokens should be between 1 and 8192",
                            life: 2000
                        });
                        throw new Error('Invalid Max Tokens value');
                    }

                    // Use self instead of this to call methods
                    await self._updateModelParams(service.id, modelType, modelName, {
                        temperature,
                        top_p,
                        max_tokens
                    });

                    // Update local data
                    selectedModel.temperature = temperature;
                    selectedModel.top_p = top_p;
                    selectedModel.max_tokens = max_tokens;

                    app.extensionManager.toast.add({
                        severity: "success",
                        summary: "Parameters updated",
                        detail: `Parameters for ${modelName} saved`,
                        life: 2000
                    });
                } catch (error) {
                    logger.error('Failed to update model parameters', error);
                    app.extensionManager.toast.add({
                        severity: "error",
                        summary: "Update failed",
                        detail: error.message,
                        life: 3000
                    });
                    throw error;
                }
            }
        });
    }

    /**
     * Batch update model parameters
     */
    async _updateModelParams(serviceId, modelType, modelName, params) {
        if (!serviceId) {
            logger.error("Failed to update model parameters: serviceId is empty");
            throw new Error("Service ID cannot be empty");
        }
        try {
            // Update each parameter sequentially
            for (const [paramName, paramValue] of Object.entries(params)) {
                const url = APIService.getApiUrl(`/services/${encodeURIComponent(serviceId)}/models/parameter`);
                logger.debug(`[v2] Updating parameter: ${url}`, { modelType, modelName, paramName, paramValue });

                const res = await fetch(url, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model_type: modelType,
                        model_name: modelName,
                        parameter_name: paramName,
                        parameter_value: paramValue
                    })
                });

                if (!res.ok) {
                    const text = await res.text();
                    logger.error(`Parameter update request failed: ${res.status} ${res.statusText}`, text);
                    throw new Error(`Request failed: ${res.status} ${res.statusText}`);
                }

                const text = await res.text();
                try {
                    const result = JSON.parse(text);
                    if (!result.success) {
                        throw new Error(result.error || 'Failed to update parameter');
                    }
                } catch (e) {
                    logger.error(`Failed to parse response JSON: ${text}`, e);
                    throw new Error(`Failed to parse response: ${e.message}`);
                }
            }

            logger.debug(`Batch updated model parameters: ${modelName}`, params);

        } catch (error) {
            logger.error('Failed to batch update model parameters', error);
            throw error;
        }
    }


    /**
     * Get available model list
     */
    async _getAvailableModels(service, modelType) {
        try {
            // Call backend API to get model list
            const res = await fetch(APIService.getApiUrl(`/services/${service.id}/models?model_type=${modelType}`));
            const result = await res.json();

            // Result contains success, models, or error
            return result;

        } catch (error) {
            logger.error(`Exception getting model list: ${error.message}`);
            return {
                success: false,
                error: `Network error: ${error.message}`
            };
        }
    }

    /**
     * Show add model listbox (using multi-select component)
     */
    _showAddModelDialog(service, modelType, container) {
        // Get trigger button
        const addBtn = event.target.closest('button');

        // Use new multi-select listbox component
        createMultiSelectListbox({
            triggerElement: addBtn,
            placeholder: `Search ${modelType === 'llm' ? 'LLM' : 'VLM'} models...`,
            fetchItems: async () => {
                const result = await this._getAvailableModels(service, modelType);

                if (!result.success) {
                    throw new Error(result.error || 'Failed to get model list');
                }

                return result.models[modelType] || [];
            },
            onConfirm: async (selectedModels, searchInputValue) => {
                // If no models are checked but the search box has content, use search box content as model name
                if (selectedModels.length === 0 && searchInputValue && searchInputValue.trim()) {
                    const modelName = searchInputValue.trim();
                    await this._addModel(service, modelType, modelName, container);
                } else {
                    // Batch add selected models
                    for (const modelName of selectedModels) {
                        await this._addModel(service, modelType, modelName, container);
                    }
                }
            }
        });
    }

    /**
     * Get recommended model list (removed, returns empty array)
     */
    async _getRecommendedModels(modelType) {
        // Recommended models removed, all models obtained from service provider API
        return [];
    }

    /**
     * Add model
     */
    async _addModel(service, modelType, modelName, container) {
        try {
            // Call backend API to add model
            const res = await fetch(APIService.getApiUrl(`/services/${service.id}/models`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model_type: modelType,
                    model_name: modelName,
                    temperature: 0.7,
                    top_p: 0.9,
                    max_tokens: 1024
                })
            });

            const result = await res.json();

            if (!result.success) {
                throw new Error(result.error || 'Failed to add model');
            }

            // Update local data
            const modelList = modelType === 'llm' ? service.llm_models : service.vlm_models;
            if (!modelList) {
                if (modelType === 'llm') {
                    service.llm_models = [];
                } else {
                    service.vlm_models = [];
                }
            }

            const updatedList = modelType === 'llm' ? service.llm_models : service.vlm_models;
            updatedList.push({
                name: modelName,
                is_default: updatedList.length === 0,
                temperature: 0.7,
                top_p: 0.9,
                max_tokens: 1024
            });

            // Remove empty hint
            const emptyHint = container.querySelector('.empty-hint');
            if (emptyHint) {
                emptyHint.remove();
            }

            // Add new tag
            const newTag = this._createModelTag({
                name: modelName,
                is_default: updatedList.length === 1
            }, service, modelType);
            container.appendChild(newTag);

            // Initialize or update Sortable (ensure newly added tags are draggable)
            // Destroy old Sortable instance first (if exists)
            if (container.sortableInstance) {
                container.sortableInstance.destroy();
            }

            // Create new Sortable instance
            container.sortableInstance = new Sortable(container, {
                animation: 150,
                ghostClass: 'sortable-ghost',
                handle: '.model-tag',
                onEnd: async (evt) => {
                    await this._updateModelOrder(service.id, modelType, container);
                }
            });

            app.extensionManager.toast.add({
                severity: "success",
                summary: "Model added",
                life: 2000
            });

        } catch (error) {
            logger.error('Failed to add model', error);
            app.extensionManager.toast.add({
                severity: "error",
                summary: "Add failed",
                detail: error.message,
                life: 3000
            });
        }
    }

    /**
     * Delete model
     */
    async _deleteModel(service, modelType, modelName, tagElement) {
        // Use createSettingsDialog to create confirmation window
        createSettingsDialog({
            title: '<i class="pi pi-exclamation-triangle" style="margin-right: 8px; color: var(--p-orange-500);"></i>Confirm Delete',
            isConfirmDialog: true,
            dialogClassName: 'confirm-dialog',
            saveButtonText: 'Delete',
            saveButtonIcon: 'pi-trash',
            isDangerButton: true,
            cancelButtonText: 'Cancel',
            renderContent: (content) => {
                content.className = 'confirm-dialog-content-simple';

                const confirmMessage = document.createElement('p');
                confirmMessage.className = 'confirm-dialog-message-simple';
                confirmMessage.textContent = `Are you sure you want to delete model "${modelName}"?`;

                content.appendChild(confirmMessage);
            },
            onSave: async () => {
                try {
                    // Call backend API to delete model
                    const res = await fetch(APIService.getApiUrl(`/services/${service.id}/models/${modelType}/${encodeURIComponent(modelName)}`), {
                        method: 'DELETE'
                    });

                    const result = await res.json();

                    if (!result.success) {
                        throw new Error(result.error || 'Failed to delete model');
                    }

                    // Update local data
                    const models = modelType === 'llm' ? service.llm_models : service.vlm_models;
                    const index = models.findIndex(m => m.name === modelName);
                    if (index >= 0) {
                        models.splice(index, 1);
                    }

                    // Remove tag
                    tagElement.remove();

                    // If empty after deletion, show empty hint
                    const container = tagElement.parentElement;
                    if (container && container.children.length === 0) {
                        const emptyHint = document.createElement('div');
                        emptyHint.className = 'empty-hint';
                        emptyHint.textContent = 'No models configured. Click "+ Add Model" to get started';
                        emptyHint.style.cssText = `
                            font-size: 12px;
                            color: var(--p-text-muted-color);
                            padding: 8px;
                        `;
                        container.appendChild(emptyHint);
                    }

                    app.extensionManager.toast.add({
                        severity: "success",
                        summary: "Model deleted",
                        life: 2000
                    });

                    return true; // Allow closing dialog

                } catch (error) {
                    logger.error('Failed to delete model', error);
                    app.extensionManager.toast.add({
                        severity: "error",
                        summary: "Delete failed",
                        detail: error.message,
                        life: 3000
                    });
                    return false; // Prevent closing dialog
                }
            }
        });
    }

    /**
     * Set default model
     */
    async _setDefaultModel(service, modelType, modelName, tagElement) {
        try {
            // Call backend API to set default model
            const res = await fetch(APIService.getApiUrl(`/services/${service.id}/models/default`), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model_type: modelType,
                    model_name: modelName
                })
            });

            const result = await res.json();

            if (!result.success) {
                throw new Error(result.error || 'Failed to set default model');
            }

            // Update local data
            const models = modelType === 'llm' ? service.llm_models : service.vlm_models;
            models.forEach(m => {
                m.is_default = m.name === modelName;
            });

            // --- Update DOM directly, no reload needed ---
            const container = tagElement?.parentElement;
            if (container) {
                // Remove default state from all tags
                container.querySelectorAll('.model-tag').forEach(tag => {
                    tag.classList.remove('default');
                    // Remove old default badge
                    const oldBadge = tag.querySelector('.model-tag-badge');
                    if (oldBadge) {
                        oldBadge.remove();
                    }
                });

                // Add style and badge to new default model
                if (tagElement) {
                    tagElement.classList.add('default');
                    // Add default badge after name
                    const nameSpan = tagElement.querySelector('.model-tag-name');
                    if (nameSpan) {
                        const defaultBadge = document.createElement('span');
                        defaultBadge.className = 'model-tag-badge';
                        defaultBadge.textContent = 'Default';
                        nameSpan.after(defaultBadge);
                    }
                }
            }

            app.extensionManager.toast.add({
                severity: "success",
                summary: `"${modelName}" set as default model`,
                life: 2000
            });

        } catch (error) {
            logger.error('Failed to set default model', error);
            app.extensionManager.toast.add({
                severity: "error",
                summary: "Setting failed",
                detail: error.message,
                life: 3000
            });
        }
    }

    /**
     * Update model order
     */
    async _updateModelOrder(serviceId, modelType, container) {
        try {
            const modelTags = container.querySelectorAll('.model-tag');
            const newOrder = Array.from(modelTags).map(tag => tag.dataset.modelName);

            // Call backend API to update order
            const res = await fetch(APIService.getApiUrl(`/services/${serviceId}/models/order`), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model_type: modelType,
                    model_names: newOrder
                })
            });

            const result = await res.json();

            if (!result.success) {
                throw new Error(result.error || 'Failed to update model order');
            }

            app.extensionManager.toast.add({
                severity: "success",
                summary: "Model order updated",
                life: 2000
            });

        } catch (error) {
            logger.error('Failed to update model order', error);
            app.extensionManager.toast.add({
                severity: "error",
                summary: "Update failed",
                detail: error.message,
                life: 3000
            });
        }
    }

    /**
     * Delete service provider
     */
    async _deleteService(serviceId) {
        // Find service name
        const service = this.services.find(s => s.id === serviceId);
        const serviceName = service ? service.name : serviceId;

        // Use createSettingsDialog to create confirmation window
        createSettingsDialog({
            title: '<i class="pi pi-exclamation-triangle" style="margin-right: 8px; color: var(--p-orange-500);"></i>Confirm Delete',
            isConfirmDialog: true,
            dialogClassName: 'confirm-dialog',
            saveButtonText: 'Delete',
            saveButtonIcon: 'pi-trash',
            isDangerButton: true,
            cancelButtonText: 'Cancel',
            renderContent: (content) => {
                content.className = 'confirm-dialog-content-simple';

                const confirmMessage = document.createElement('p');
                confirmMessage.className = 'confirm-dialog-message-simple';
                confirmMessage.textContent = `Are you sure you want to delete service provider "${serviceName}"?`;

                content.appendChild(confirmMessage);
            },
            onSave: async () => {
                try {
                    const res = await fetch(APIService.getApiUrl(`/services/${serviceId}`), {
                        method: 'DELETE'
                    });

                    const result = await res.json();

                    if (result.success) {
                        app.extensionManager.toast.add({
                            severity: "success",
                            summary: "Deleted successfully",
                            life: 3000
                        });

                        // Reload configuration and refresh UI
                        await this._loadAllConfigs();

                        // Find and remove corresponding tab and content
                        const tabButton = document.querySelector(`.tab-button[data-tab="${serviceId}"]`);
                        if (tabButton) {
                            tabButton.remove();
                        }

                        const tabPane = document.querySelector(`.tab-pane[data-tab="${serviceId}"]`);
                        if (tabPane) {
                            tabPane.remove();
                        }

                        // Automatically switch to Baidu Translate tab
                        const header = document.querySelector('.tab-header');
                        const contentContainer = document.querySelector('.tab-content');
                        if (header && contentContainer) {
                            this._switchTab('baidu', header, contentContainer);
                        }

                        // If this was the last service provider, show empty hint
                        const listContainer = document.querySelector('.services-list');
                        if (listContainer && this.services.length === 0) {
                            const emptyHint = document.createElement('div');
                            emptyHint.style.cssText = `
                                text-align: center;
                                padding: 40px;
                                color: var(--p-text-muted-color);
                            `;
                            emptyHint.textContent = 'No service providers. Click "Add Service Provider" to get started';
                            listContainer.appendChild(emptyHint);
                        }

                        // Trigger configuration sync event
                        this.notifyConfigChange();

                        return true; // Allow closing dialog
                    } else {
                        throw new Error(result.error || 'Delete failed');
                    }
                } catch (error) {
                    logger.error('Failed to delete service provider', error);
                    app.extensionManager.toast.add({
                        severity: "error",
                        summary: "Delete failed",
                        detail: error.message,
                        life: 3000
                    });
                    return false; // Prevent closing dialog
                }
            }
        });
    }

    /**
     * Update service provider configuration
     */
    async _updateService(serviceId, updates) {
        try {
            const res = await fetch(APIService.getApiUrl(`/services/${serviceId}`), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates)
            });

            const result = await res.json();

            if (!result.success) {
                throw new Error(result.error || 'Update failed');
            }

            // Sync update local in-memory service provider data
            const service = this.services.find(s => s.id === serviceId);
            if (service) {
                Object.assign(service, updates);
            }

            // Trigger configuration sync event
            this.notifyConfigChange();

            logger.debug('Service provider configuration updated', serviceId);

            // Show success notification
            app.extensionManager.toast.add({
                severity: "success",
                summary: "Service provider configuration updated",
                life: 2000
            });
        } catch (error) {
            logger.error('Failed to update service provider', error);
            app.extensionManager.toast.add({
                severity: "error",
                summary: "Update failed",
                detail: error.message,
                life: 3000
            });
        }
    }



    /**
     * Load masked API Key
     * @param {string} serviceId Service provider ID
     * @returns {Promise<string|null>} Masked API Key
     */
    async _loadMaskedApiKey(serviceId) {
        try {
            const res = await fetch(APIService.getApiUrl(`/services/${serviceId}/masked`));
            const result = await res.json();

            if (result.success && result.service) {
                return result.service.api_key_masked || null;
            }

            return null;
        } catch (error) {
            logger.error('Failed to load masked API Key', error);
            return null;
        }
    }
}

// Export API configuration manager instance
export const apiConfigManager = new APIConfigManager();