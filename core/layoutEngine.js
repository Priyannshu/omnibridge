const createLogger = require('./loggerFactory');

// Create logger instance
const logger = createLogger({ appName: 'Omnibridge-LayoutEngine' });

class LayoutEngine {
    constructor() {
        this.systems = []; // { id, name, position: 'left' | 'right' | 'top' | 'bottom', active: boolean }
        this.currentSystemId = 'local';
        this.displays = []; // Multi-monitor support
    }

    addSystem(system) {
        this.systems.push(system);
    }

    // Multi-monitor support: get all displays
    getAllDisplays() {
        const { screen } = require('electron');
        return screen.getAllDisplays();
    }

    // Get primary display
    getPrimaryDisplay() {
        const { screen } = require('electron');
        return screen.getPrimaryDisplay();
    }

    // Add display to layout
    addDisplay(display) {
        if (!this.displays.find(d => d.id === display.id)) {
            this.displays.push(display);
        }
    }

    // Check boundary with multi-monitor support
    checkBoundary(x, y, screenWidth, screenHeight) {
        // Use actual screen edges instead of zones for more accurate detection
        const edgeThreshold = 5; // 5px from actual screen edge
        
        // Check if we're at/near an edge
        if (x >= screenWidth - edgeThreshold) return 'right';
        if (x <= edgeThreshold) return 'left';
        
        return null;
    }

    getNextSystem(boundary) {
        return this.systems.find(s => s.position === boundary);
    }
    
    // Multi-monitor boundary detection
    checkMultiMonitorBoundary(x, y) {
        try {
            const { screen } = require('electron');
            const displays = screen.getAllDisplays();
            if (displays.length <= 1) return null; // Single monitor, use regular boundary detection
            
            // Check if cursor is at edge of any display
            for (const display of displays) {
                const bounds = display.bounds;
                const edgeThreshold = 5;
                
                // Check right edge
                if (x >= bounds.x + bounds.width - edgeThreshold && x <= bounds.x + bounds.width) {
                    return { boundary: 'right', display: display };
                }
                // Check left edge  
                if (x >= bounds.x && x <= bounds.x + edgeThreshold) {
                    return { boundary: 'left', display: display };
}
            }
        } catch (e) {
            // Fallback to single monitor detection
            logger.warn('Multi-monitor detection failed, using single monitor detection', { error: e.message });
        }
        
        return null;
    }

    // Get display arrangement for UI
    getDisplayArrangement() {
        try {
            const { screen } = require('electron');
            const displays = screen.getAllDisplays();
            return displays.map(display => ({
                id: display.id,
                bounds: display.bounds,
                workArea: display.workArea,
                isPrimary: display.id === screen.getPrimaryDisplay().id
            }));
        } catch (e) {
            logger.warn('Could not get display arrangement', { error: e.message });
            return [];
        }
    }
}

module.exports = LayoutEngine;