/**
 * Resource Manager
 * Unified management of all resource loading, caching, and access
 */

import { logger } from './logger.js';
import { APIService } from '../services/api.js';

class ResourceManager {
    // Resource caches
    static #iconCache = new Map();
    static #styleCache = new Map();
    static #scriptCache = new Map();
    static #tagCache = null;  // Changed to single variable storage
    static #userTagCache = null;  // User custom tag cache

    // Initialization state
    static #initialized = false;
    static #initializing = false;

    /**
     * Initialize resource manager
     */
    static init() {
        // Already initialized, return directly
        if (this.#initialized) {
            return true;
        }

        // Currently initializing, avoid duplication
        if (this.#initializing) {
            return false;
        }

        this.#initializing = true;

        try {
            // Load all resources
            this.#loadIcons();
            this.#loadStyles();
            this.#loadTagData();
            this.#loadUserTagData();

            this.#initialized = true;
            this.#initializing = false;

            logger.log("Resource Manager | Initialization complete");
            return true;
        } catch (error) {
            logger.error(`Resource Manager | Initialization failed | ${error.message}`);
            this.#initializing = false;
            return false;
        }
    }

    /**
     * Get the absolute URL for a resource
     */
    static getResourceUrl(relativePath) {
        return new URL(relativePath, import.meta.url).href;
    }

    /**
     * Get the URL for a CSS file
     */
    static getCssUrl(cssFileName) {
        return this.getResourceUrl(`../css/${cssFileName}`);
    }

    /**
     * Get the resource URL from the assets directory
     */
    static getAssetUrl(assetFileName) {
        return this.getResourceUrl(`../assets/${assetFileName}`);
    }

    /**
     * Get the URL for a library file
     */
    static getLibUrl(libFileName) {
        return this.getResourceUrl(`../lib/${libFileName}`);
    }

    // ====================== Icon Management ======================

    /**
     * Load all icons
     * @private
     */
    static #loadIcons() {
        // List of all icons to load
        const iconsToLoad = [
            'icon-main.svg',
            'icon-history.svg',
            'icon-undo.svg',
            'icon-redo.svg',
            'icon-tag.svg',
            'icon-expand.svg',
            'icon-translate.svg',
            'icon-caption-zh.svg',
            'icon-caption-en.svg',
            'icon-remove.svg',
            'icon-resize-handle.svg',
        ];

        let loaded = 0;
        let failed = 0;

        // Load icons one by one
        iconsToLoad.forEach(iconName => {
            const iconUrl = this.getAssetUrl(iconName);

            // Use fetch to load SVG content
            fetch(iconUrl)
                .then(response => {
                    if (!response.ok) {
                        throw new Error(`HTTP error! status: ${response.status}`);
                    }
                    return response.text();
                })
                .then(svgContent => {
                    // Cache SVG content
                    this.#iconCache.set(iconName, svgContent);
                    loaded++;

                    // Log after all icons finish loading
                    if (loaded + failed === iconsToLoad.length) {
                        logger.debug(`Icon loading complete | Success: ${loaded} | Failed: ${failed}`);
                    }
                })
                .catch(error => {
                    failed++;
                    logger.warn(`Icon loading failed | ${iconName} | ${error.message}`);

                    // Log after all icons finish loading
                    if (loaded + failed === iconsToLoad.length) {
                        logger.debug(`Icon loading complete | Success: ${loaded} | Failed: ${failed}`);
                    }
                });
        });
    }

    /**
     * Get cached icon
     */
    static getIcon(iconName) {
        const svgContent = this.#iconCache.get(iconName);
        if (!svgContent) {
            return null;
        }

        // Create a span element containing the SVG
        const iconContainer = document.createElement('span');
        iconContainer.className = 'svg-icon';
        iconContainer.innerHTML = svgContent;

        // Get SVG element and add styles
        const svgElement = iconContainer.querySelector('svg');
        if (svgElement) {
            // Add styles to ensure SVG color can be controlled via the color property
            svgElement.style.width = '100%';
            svgElement.style.height = '100%';
            svgElement.style.fill = 'currentColor';

            // Remove potentially existing fixed color attributes
            svgElement.querySelectorAll('*').forEach(el => {
                if (el.hasAttribute('fill') && el.getAttribute('fill') !== 'none') {
                    el.setAttribute('fill', 'currentColor');
                }
                if (el.hasAttribute('stroke') && el.getAttribute('stroke') !== 'none') {
                    el.setAttribute('stroke', 'currentColor');
                }
            });
        }

        return iconContainer;
    }

    // ====================== Style Management ======================

    /**
     * Load all stylesheets
     * @private
     */
    static #loadStyles() {
        const stylesToLoad = [
            { id: 'prompt-assistant-common-styles', file: 'common.css' },
            { id: 'prompt-assistant-styles', file: 'assistant.css' },
            { id: 'prompt-assistant-popup-styles', file: 'popup.css' },
            { id: 'prompt-assistant-ui-components-styles', file: 'uiComponents.css' }
        ];

        stylesToLoad.forEach(style => {
            this.#loadStyle(style.id, style.file);
        });
    }

    /**
     * Load a single stylesheet
     */
    static #loadStyle(id, file) {
        // Check if already exists
        if (document.getElementById(id)) {
            return;
        }

        const link = document.createElement("link");
        link.id = id;
        link.rel = "stylesheet";
        link.type = "text/css";
        link.href = this.getCssUrl(file);

        link.onload = () => {
            this.#styleCache.set(id, link);
        };

        link.onerror = () => {
            logger.error(`Stylesheet loading failed | ${id}`);
        };

        document.head.appendChild(link);
    }

    // ====================== Tag Data Management ======================

    /**
     * Get the URL for the tag data file
     */
    static getTagUrl() {
        // Use API route to get tag data
        return APIService.getApiUrl('/config/tags');
    }

    /**
     * Get the URL for the user custom tag data file
     */
    static getUserTagUrl() {
        // Use API route to get user custom tag data
        return APIService.getApiUrl('/config/tags_user');
    }

    /**
     * Calculate tag data statistics
     */
    static #getTagStats(data) {
        const stats = {
            categories: 0,  // Total number of categories (including all levels)
            tags: 0        // Number of leaf nodes (actual tags)
        };

        /**
         * Recursively count tag data
         */
        const countRecursively = (obj) => {
            // Iterate through all keys at the current level
            for (const key in obj) {
                const value = obj[key];

                // If value is a string, it's a tag (leaf node)
                if (typeof value === 'string') {
                    stats.tags++;
                }
                // If value is an object, it's a category, continue recursion
                else if (typeof value === 'object' && value !== null) {
                    stats.categories++;
                    countRecursively(value);
                }
            }
        };

        // Start recursive counting
        countRecursively(data);

        return stats;
    }

    /**
     * Refresh tag data
     */
    static refreshTagData() {
        return new Promise((resolve, reject) => {
            const tagUrl = this.getTagUrl();
            logger.debug("Starting to reload tag data...");

            fetch(tagUrl + '?t=' + new Date().getTime())  // Add timestamp to prevent caching
                .then(response => {
                    if (!response.ok) {
                        throw new Error(`HTTP error! status: ${response.status}`);
                    }
                    return response.json();
                })
                .then(data => {
                    // Check for error messages
                    if (data.error) {
                        throw new Error(`API returned error: ${data.error}`);
                    }

                    this.#tagCache = data;
                    const stats = this.#getTagStats(data);
                    logger.log(`Tag data refresh complete | Categories: ${stats.categories} | Tags: ${stats.tags}`);
                    resolve(data);
                })
                .catch(error => {
                    logger.error(`Tag data refresh failed | ${error.message}`);
                    reject(error);
                });
        });
    }

    /**
     * Refresh user custom tag data
     */
    static refreshUserTagData() {
        return new Promise((resolve, reject) => {
            const userTagUrl = this.getUserTagUrl();
            logger.debug("Starting to reload user custom tag data...");

            fetch(userTagUrl + '?t=' + new Date().getTime())  // Add timestamp to prevent caching
                .then(response => {
                    if (!response.ok) {
                        throw new Error(`HTTP error! status: ${response.status}`);
                    }
                    return response.json();
                })
                .then(data => {
                    // Check for error messages
                    if (data.error) {
                        throw new Error(`API returned error: ${data.error}`);
                    }

                    this.#userTagCache = data;
                    const stats = this.#getTagStats(data);
                    logger.log(`User tag data refresh complete | Categories: ${stats.categories} | Tags: ${stats.tags}`);
                    resolve(data);
                })
                .catch(error => {
                    logger.error(`User tag data refresh failed | ${error.message}`);
                    reject(error);
                });
        });
    }

    /**
     * Load tag data
     */
    static #loadTagData() {
        return this.refreshTagData();
    }

    /**
     * Load user custom tag data
     */
    static #loadUserTagData() {
        return this.refreshUserTagData();
    }

    /**
     * Get tag data
     */
    static async getTagData(refresh = false) {
        if (refresh || !this.#tagCache) {
            try {
                await this.refreshTagData();
            } catch (error) {
                logger.error(`Failed to get tag data | ${error.message}`);
                return {};
            }
        }
        return this.#tagCache || {};
    }

    /**
     * Get user custom tag data
     */
    static async getUserTagData(refresh = false) {
        if (refresh || !this.#userTagCache) {
            try {
                await this.refreshUserTagData();
            } catch (error) {
                logger.error(`Failed to get user tag data | ${error.message}`);
                return {};
            }
        }
        return this.#userTagCache || {};
    }

    /**
     * Get tag statistics
     */
    static async getTagStats() {
        const tagData = await this.getTagData();
        const stats = this.#getTagStats(tagData);
        return stats.tags;
    }

    // --- CSV Tag System ---

    /**
     * Get CSV file list
     */
    static async getTagFileList() {
        try {
            const response = await fetch(APIService.getApiUrl('/config/tags_files'));
            const result = await response.json();
            if (result.success) {
                return result.files || [];
            }
            logger.error(`Failed to get tag file list | ${result.error}`);
            return [];
        } catch (error) {
            logger.error(`Failed to get tag file list | ${error.message}`);
            return [];
        }
    }

    /**
     * Get user-selected tag file
     */
    static async getSelectedTagFile() {
        try {
            const response = await fetch(APIService.getApiUrl('/config/tags_selection'));
            const result = await response.json();
            if (result.success) {
                return result.selection?.selected_file || '用户标签.csv';
            }
            return '用户标签.csv';
        } catch (error) {
            logger.error(`Failed to get tag selection | ${error.message}`);
            return '用户标签.csv';
        }
    }

    /**
     * Save user-selected tag file
     */
    static async setSelectedTagFile(filename) {
        try {
            const response = await fetch(APIService.getApiUrl('/config/tags_selection'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ selected_file: filename })
            });
            const result = await response.json();
            return result.success;
        } catch (error) {
            logger.error(`Failed to save tag selection | ${error.message}`);
            return false;
        }
    }

    /**
     * Load CSV tag data
     * @param {string} filename - CSV file name
     * @param {boolean} forceReload - Whether to force reload (currently always reloads)
     */
    static async loadTagsCsv(filename, forceReload = false) {
        try {
            const response = await fetch(APIService.getApiUrl(`/config/tags_csv/${filename}`));
            const result = await response.json();
            if (result.success) {
                this.#tagCache = result.data;
                const stats = this.#getTagStats(result.data);
                logger.log(`CSV tag loading complete | File: ${filename} | Categories: ${stats.categories} | Tags: ${stats.tags}`);
                return result.data;
            }
            logger.error(`Failed to load CSV tags | ${result.error}`);
            return {};
        } catch (error) {
            logger.error(`Failed to load CSV tags | ${error.message}`);
            return {};
        }
    }

    /**
     * Save CSV tag data
     */
    static async saveTagsCsv(filename, data) {
        try {
            const response = await fetch(APIService.getApiUrl(`/config/tags_csv/${filename}`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data })
            });
            const result = await response.json();
            if (result.success) {
                logger.log(`CSV tag save successful | File: ${filename}`);
                return true;
            }
            logger.error(`Failed to save CSV tags | ${result.error}`);
            return false;
        } catch (error) {
            logger.error(`Failed to save CSV tags | ${error.message}`);
            return false;
        }
    }

    /**
     * Get favorites list
     */
    static async getFavorites() {
        try {
            const response = await fetch(APIService.getApiUrl('/config/favorites'));
            const result = await response.json();
            if (result.success) {
                return result.favorites || [];
            }
            return [];
        } catch (error) {
            logger.error(`Failed to get favorites list | ${error.message}`);
            return [];
        }
    }

    /**
     * Add favorite
     */
    static async addFavorite(tagValue, tagName = null, category = null) {
        try {
            const body = { tag_value: tagValue };
            if (tagName) {
                body.tag_name = tagName;
            }
            if (category) {
                body.category = category;
            }
            const response = await fetch(APIService.getApiUrl('/config/favorites/add'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const result = await response.json();
            return result.success;
        } catch (error) {
            logger.error(`Failed to add favorite | ${error.message}`);
            return false;
        }
    }

    /**
     * Remove favorite
     */
    static async removeFavorite(tagValue, category = null) {
        try {
            const body = { tag_value: tagValue };
            if (category) {
                body.category = category;
            }
            const response = await fetch(APIService.getApiUrl('/config/favorites/remove'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const result = await response.json();
            return result.success;
        } catch (error) {
            logger.error(`Failed to remove favorite | ${error.message}`);
            return false;
        }
    }

    /**
     * Check if initialized
     */
    static isInitialized() {
        return this.#initialized;
    }


    // ====================== Resource Cleanup ======================

    /**
     * Clean up all resources
     */
    static async cleanup() {
        // Clear icon cache
        this.#iconCache.clear();

        // Remove stylesheets
        this.#styleCache.forEach((style) => {
            if (style && style.parentNode) {
                style.parentNode.removeChild(style);
            }
        });
        this.#styleCache.clear();

        // Clear script cache
        this.#scriptCache.clear();

        // Clear tag data
        this.#tagCache = null;
        this.#userTagCache = null;

        // Reset state
        this.#initialized = false;
        this.#initializing = false;

        // Re-initialize resources
        await this.init();

        logger.log("Resource Manager | Resources cleaned up and re-initialized");
    }

    /**
     * Save user custom tag data
     */
    static async saveUserTags(data) {
        try {
            const response = await fetch(APIService.getApiUrl('/config/tags_user'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            const result = await response.json();
            if (result.success) {
                logger.log("User tag data saved successfully");
                this.#userTagCache = data; // Update cache
                return true;
            }
            logger.error(`Failed to save user tag data | ${result.error}`);
            return false;
        } catch (error) {
            logger.error(`Failed to save user tag data | ${error.message}`);
            return false;
        }
    }

    /**
     * Load external script
     */
    static async loadScript(url) {
        try {
            if (this.#scriptCache.has(url)) {
                return this.#scriptCache.get(url);
            }

            const promise = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = url;
                script.async = true;
                script.onload = () => resolve();
                script.onerror = () => reject(new Error(`Failed to load script: ${url}`));
                document.head.appendChild(script);
            });

            this.#scriptCache.set(url, promise);
            await promise;
            logger.debug(`Script loaded successfully | URL: ${url}`);
            return promise;
        } catch (error) {
            logger.error(`Script loading failed | URL: ${url} | Error: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get SortableJS instance
     */
    static async getSortable() {
        try {
            if (window.Sortable) {
                return window.Sortable;
            }

            const sortableUrl = this.getLibUrl('Sortable.min.js');
            await this.loadScript(sortableUrl);

            if (!window.Sortable) {
                throw new Error('After loading Sortable.js, window.Sortable is undefined');
            }

            logger.debug('Sortable.js loaded successfully');
            return window.Sortable;
        } catch (error) {
            logger.error(`Failed to get Sortable.js | Error: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get the URL for the system prompts configuration file
     */
    static getSystemPromptsUrl() {
        return this.getResourceUrl('../config/system_prompts.json');
    }

    /**
     * Load system prompts configuration
     */
    static async loadSystemPrompts(forceRefresh = true) {
        try {
            const url = this.getSystemPromptsUrl();
            // Add timestamp or random parameter to prevent caching
            const finalUrl = forceRefresh ? `${url}?t=${Date.now()}` : url;

            logger.debug(`Loading system prompts configuration | URL: ${finalUrl}`);

            const response = await fetch(finalUrl);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            logger.debug(`System prompts configuration loaded successfully`);

            // Validate data structure
            if (!data.vision_prompts) {
                logger.warn(`Missing vision_prompts field in system prompts configuration`);
            } else {
                logger.debug(`Vision prompts configuration: ${Object.keys(data.vision_prompts).join(', ')}`);
            }

            return data;
        } catch (error) {
            logger.error(`System prompts configuration loading failed | ${error.message}`);
            return null;
        }
    }
}

export { ResourceManager };