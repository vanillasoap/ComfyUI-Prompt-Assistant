/**
 * Event Manager
 * Unified management of all event-related operations, including DOM events, mouse events, etc.
 */

import { logger } from './logger.js';

class EventManager {
    // Event storage - uses nested Maps to store events and listeners
    static listeners = new Map();

    // Global mouse position
    static mousePosition = { x: 0, y: 0 };

    // Initialization state flag
    static initialized = false;
    static _mouseHandler = null;

    /**
     * Initialize event manager
     */
    static init() {
        // Strict check to avoid duplicate initialization
        if (this.initialized) {
            return true;
        }

        try {
            // Set up global mouse tracking
            this.setupGlobalMouseTracking();

            this.initialized = true;
            logger.log("Event Manager | Initialization complete");
            return true;
        } catch (error) {
            logger.error(`Event Manager | Initialization failed | ${error.message}`);
            return false;
        }
    }

    /**
     * Set up global mouse position tracking
     */
    static setupGlobalMouseTracking() {
        // Remove potentially existing old listener
        if (this._mouseHandler) {
            document.removeEventListener('mousemove', this._mouseHandler);
        }

        // Create new mouse handler
        this._mouseHandler = (e) => {
            // Update mouse position
            this.mousePosition.x = e.clientX;
            this.mousePosition.y = e.clientY;

            // Emit custom event
            this.emit('global_mouse_move', e);
        };

        // Add mouse listener
        document.addEventListener('mousemove', this._mouseHandler);
    }

    /**
     * Get current mouse position
     */
    static getMousePosition() {
        return { ...this.mousePosition };
    }

    /**
     * Check if mouse is over an element
     */
    static isMouseOverElement(element) {
        if (!element) return false;

        try {
            const rect = element.getBoundingClientRect();
            return (
                this.mousePosition.x >= rect.left &&
                this.mousePosition.x <= rect.right &&
                this.mousePosition.y >= rect.top &&
                this.mousePosition.y <= rect.bottom
            );
        } catch {
            return false;
        }
    }

    /**
     * Add event listener
     */
    static on(eventKey, id, callback) {
        // Parameter validation
        if (!eventKey || !id || typeof callback !== 'function') {
            logger.error(`Event registration failed | Invalid parameters | Event: ${eventKey}`);
            return false;
        }

        // Get or create event listener collection
        if (!this.listeners.has(eventKey)) {
            this.listeners.set(eventKey, new Map());
        }

        const listeners = this.listeners.get(eventKey);

        // Check if a listener with the same ID already exists
        if (listeners.has(id)) {
            return true; // Already exists, return silently
        }

        // Add new listener
        listeners.set(id, callback);
        return true;
    }

    /**
     * Remove event listener
     */
    static off(eventKey, id) {
        // Parameter validation
        if (!eventKey || !id) return false;

        // Check if event and listener exist
        if (!this.listeners.has(eventKey)) return false;

        const listeners = this.listeners.get(eventKey);
        const removed = listeners.delete(id);

        // If no more listeners for this event, delete the entire event
        if (listeners.size === 0) {
            this.listeners.delete(eventKey);
        }

        return removed;
    }

    /**
     * Emit event
     */
    static emit(eventKey, ...args) {
        if (!eventKey) return false;

        // Check if event has listeners
        if (!this.listeners.has(eventKey)) return false;

        const listeners = this.listeners.get(eventKey);
        if (listeners.size === 0) return false;

        // Execute all listeners
        for (const [id, callback] of listeners.entries()) {
            try {
                callback(...args);
            } catch (error) {
                logger.error(`Event handler error | Event: ${eventKey}, ID: ${id} | Error: ${error.message}`);
            }
        }

        return true;
    }

    /**
     * Add DOM event listener
     * Simplified helper method that returns a function for removing the listener
     */
    static addDOMListener(element, event, handler, options = false) {
        if (!element || !event || typeof handler !== 'function') {
            return () => { };
        }

        element.addEventListener(event, handler, options);

        return () => {
            element.removeEventListener(event, handler, options);
        };
    }

    /**
     * Create debounced function
     * Limits function call frequency
     */
    static debounce(func, wait = 100) {
        let timeout;
        return function (...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    /**
     * Register hover events for an element (simplified version)
     */
    static registerHoverEvents(element, id, onEnter, onLeave) {
        if (!element) return () => { };

        const enterHandler = () => onEnter && onEnter();
        const leaveHandler = () => onLeave && onLeave();

        element.addEventListener('mouseenter', enterHandler);
        element.addEventListener('mouseleave', leaveHandler);

        return () => {
            element.removeEventListener('mouseenter', enterHandler);
            element.removeEventListener('mouseleave', leaveHandler);
        };
    }

    /**
     * Clean up event manager
     */
    static cleanup(keepGlobalEvents = true) {
        if (keepGlobalEvents) {
            // Keep global events, clean up others
            const globalEvents = ['global_mouse_move'];

            for (const [eventKey, listeners] of this.listeners.entries()) {
                if (!globalEvents.includes(eventKey)) {
                    this.listeners.delete(eventKey);
                }
            }
        } else {
            // Clean up all events and listeners
            this.listeners.clear();

            // Remove global mouse listener
            if (this._mouseHandler) {
                document.removeEventListener('mousemove', this._mouseHandler);
                this._mouseHandler = null;
            }

            // Reset state
            this.initialized = false;
        }
    }
}

export { EventManager };