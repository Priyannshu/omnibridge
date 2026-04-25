const { uIOhook, UiohookKey } = require('uiohook-napi');
const robot = require('@jitsi/robotjs');
const createLogger = require('./loggerFactory');

// Create logger instance
const logger = createLogger({ appName: 'Omnibridge-InputEngine' });

class InputEngine {
    constructor() {
        this.active = false;
        this.remoteMode = false;
        
        // Comprehensive mapping for uiohook-napi to robotjs keys
        this.keyMap = {
            [UiohookKey.Enter]: 'enter',
            [UiohookKey.Space]: 'space',
            [UiohookKey.Escape]: 'escape',
            [UiohookKey.Backspace]: 'backspace',
            [UiohookKey.Tab]: 'tab',
            [UiohookKey.Shift]: 'shift',
            [UiohookKey.ShiftRight]: 'right_shift',
            [UiohookKey.Ctrl]: 'control',
            [UiohookKey.CtrlRight]: 'control',
            [UiohookKey.Alt]: 'alt',
            [UiohookKey.AltRight]: 'alt',
            [UiohookKey.Meta]: 'command',
            [UiohookKey.MetaRight]: 'command',
            [UiohookKey.ArrowUp]: 'up',
            [UiohookKey.ArrowDown]: 'down',
            [UiohookKey.ArrowLeft]: 'left',
            [UiohookKey.ArrowRight]: 'right',
            [UiohookKey.Insert]: 'insert',
            [UiohookKey.Delete]: 'delete',
            [UiohookKey.Home]: 'home',
            [UiohookKey.End]: 'end',
            [UiohookKey.PageUp]: 'pageup',
            [UiohookKey.PageDown]: 'pagedown',
            [UiohookKey.PrintScreen]: 'printscreen',
            [UiohookKey.F1]: 'f1', [UiohookKey.F2]: 'f2', [UiohookKey.F3]: 'f3', [UiohookKey.F4]: 'f4',
            [UiohookKey.F5]: 'f5', [UiohookKey.F6]: 'f6', [UiohookKey.F7]: 'f7', [UiohookKey.F8]: 'f8',
            [UiohookKey.F9]: 'f9', [UiohookKey.F10]: 'f10', [UiohookKey.F11]: 'f11', [UiohookKey.F12]: 'f12',
            [UiohookKey.A]: 'a', [UiohookKey.B]: 'b', [UiohookKey.C]: 'c', [UiohookKey.D]: 'd',
            [UiohookKey.E]: 'e', [UiohookKey.F]: 'f', [UiohookKey.G]: 'g', [UiohookKey.H]: 'h',
            [UiohookKey.I]: 'i', [UiohookKey.J]: 'j', [UiohookKey.K]: 'k', [UiohookKey.L]: 'l',
            [UiohookKey.M]: 'm', [UiohookKey.N]: 'n', [UiohookKey.O]: 'o', [UiohookKey.P]: 'p',
            [UiohookKey.Q]: 'q', [UiohookKey.R]: 'r', [UiohookKey.S]: 's', [UiohookKey.T]: 't',
            [UiohookKey.U]: 'u', [UiohookKey.V]: 'v', [UiohookKey.W]: 'w', [UiohookKey.X]: 'x',
            [UiohookKey.Y]: 'y', [UiohookKey.Z]: 'z',
            [UiohookKey['0']]: '0', [UiohookKey['1']]: '1', [UiohookKey['2']]: '2', [UiohookKey['3']]: '3',
            [UiohookKey['4']]: '4', [UiohookKey['5']]: '5', [UiohookKey['6']]: '6', [UiohookKey['7']]: '7',
            [UiohookKey['8']]: '8', [UiohookKey['9']]: '9',
            [UiohookKey.Numpad0]: 'numpad_0', [UiohookKey.Numpad1]: 'numpad_1', [UiohookKey.Numpad2]: 'numpad_2', [UiohookKey.Numpad3]: 'numpad_3',
            [UiohookKey.Numpad4]: 'numpad_4', [UiohookKey.Numpad5]: 'numpad_5', [UiohookKey.Numpad6]: 'numpad_6', [UiohookKey.Numpad7]: 'numpad_7',
            [UiohookKey.Numpad8]: 'numpad_8', [UiohookKey.Numpad9]: 'numpad_9',
            [UiohookKey.Semicolon]: ';',
            [UiohookKey.Equal]: '=',
            [UiohookKey.Comma]: ',',
            [UiohookKey.Minus]: '-',
            [UiohookKey.Period]: '.',
            [UiohookKey.Slash]: '/',
            [UiohookKey.Backquote]: '`',
            [UiohookKey.BracketLeft]: '[',
            [UiohookKey.Backslash]: '\\',
            [UiohookKey.BracketRight]: ']'
        };
        // UiohookKey.Quote is missing or problematic in some versions, mapping it safely
        if (UiohookKey.Quote) this.keyMap[UiohookKey.Quote] = '\'';
        
        this.centerX = 0;
        this.centerY = 0;
        this.lastX = 0;
        this.lastY = 0;
        
        // Guard flag to prevent feedback loops when re-centering the cursor programmatically
        this.isRecentering = false;
        
        // Callback to notify main process when capture is stopped via escape hotkey
        this.onStop = null;
        
        // Track modifier key states for escape hotkey detection
        this._ctrlDown = false;
        this._altDown = false;
        
        this.screenSize = robot.getScreenSize();
    }

    startCapture(onEvent, centerX, centerY) {
        this.active = true;
        this.remoteMode = true; // explicitly set remote mode

        this.centerX = centerX || Math.floor(this.screenSize.width / 2);
        this.centerY = centerY || Math.floor(this.screenSize.height / 2);
        
        this.lastX = this.centerX;
        this.lastY = this.centerY;

        // Move to center initially
        this.isRecentering = true;
        robot.moveMouse(this.centerX, this.centerY);
        
        // We assume the OS might take a few ms to process this move, so we keep `isRecentering = true` 
        // until the first mousemove matching the center arrives, but a timer acts as a fallback.
        setTimeout(() => { this.isRecentering = false; }, 50);

        uIOhook.removeAllListeners();

        // Mouse Events
        uIOhook.on('mousemove', (e) => {
            if (!this.active || !this.remoteMode) return;

            const dx = e.x - this.lastX;
            const dy = e.y - this.lastY;

            // If we are artificially resetting the mouse, ignore this event
            if (this.isRecentering && Math.abs(e.x - this.centerX) <= 1 && Math.abs(e.y - this.centerY) <= 1) {
                this.isRecentering = false;
                this.lastX = e.x;
                this.lastY = e.y;
                return;
            }

            this.lastX = e.x;
            this.lastY = e.y;

            if (dx !== 0 || dy !== 0) {
                onEvent({ type: 'mousemove', dx, dy });
            }

            // Trap mechanism: If mouse strays > 150px from center, pull it back
            if (Math.abs(e.x - this.centerX) > 150 || Math.abs(e.y - this.centerY) > 150) {
                this.isRecentering = true;
                robot.moveMouse(this.centerX, this.centerY);
                this.lastX = this.centerX;
                this.lastY = this.centerY;
                
                // Safety clear just in case the hook event drops
                setTimeout(() => { this.isRecentering = false; }, 50);
            }
        });

        uIOhook.on('mousedown', (e) => {
            if (this.active && this.remoteMode) {
                onEvent({ type: 'mousedown', button: this._mapButton(e.button) });
            }
        });

        uIOhook.on('mouseup', (e) => {
            if (this.active && this.remoteMode) {
                onEvent({ type: 'mouseup', button: this._mapButton(e.button) });
            }
        });

        uIOhook.on('wheel', (e) => {
            if (this.active && this.remoteMode) {
                onEvent({ type: 'mousewheel', delta: e.rotation });
            }
        });

        // Keyboard Events — with escape hotkey (Ctrl+Alt+Q) to break out of capture
        uIOhook.on('keydown', (e) => {
            if (!this.active || !this.remoteMode) return;
            
            // Track modifier states
            if (e.keycode === UiohookKey.Ctrl || e.keycode === UiohookKey.CtrlRight) this._ctrlDown = true;
            if (e.keycode === UiohookKey.Alt || e.keycode === UiohookKey.AltRight) this._altDown = true;
            
            // Escape hotkey: Ctrl+Alt+Q immediately breaks out of capture
            if (this._ctrlDown && this._altDown && e.keycode === UiohookKey.Q) {
                logger.info('Escape hotkey (Ctrl+Alt+Q) pressed — stopping capture');
                this.stop();
                if (this.onStop) this.onStop();
                return;
            }
            
            // Also allow Escape key alone as a secondary escape mechanism
            if (e.keycode === UiohookKey.Escape) {
                logger.info('Escape key pressed — stopping capture');
                this.stop();
                if (this.onStop) this.onStop();
                return;
            }
            
            const key = this.keyMap[e.keycode];
            if (key) onEvent({ type: 'keydown', key });
        });

        uIOhook.on('keyup', (e) => {
            if (!this.active || !this.remoteMode) return;
            
            // Track modifier states
            if (e.keycode === UiohookKey.Ctrl || e.keycode === UiohookKey.CtrlRight) this._ctrlDown = false;
            if (e.keycode === UiohookKey.Alt || e.keycode === UiohookKey.AltRight) this._altDown = false;
            
            const key = this.keyMap[e.keycode];
            if (key) onEvent({ type: 'keyup', key });
        });

        uIOhook.start();
    }

    _mapButton(btn) {
        if (btn === 1) return 'left';
        if (btn === 2) return 'right';
        if (btn === 3) return 'middle';
        return 'left';
    }

    // Returns a status object that can instruct the main process (e.g., boundary crossing)
    async injectEvent(event) {
        try {
            switch (event.type) {
                case 'mousemove':
                    const currentMouse = robot.getMousePos();
                    let newX = currentMouse.x + event.dx;
                    let newY = currentMouse.y + event.dy;
                    
                    // Receiver Side Boundaries
                    // If hitting the left edge (<=0), cross back to local mode!
                    if (newX <= 0) {
                        return { action: 'switch-to-local' };
                    }

                    // Clamp to other screen bounds to prevent crashing or wrapping
                    if (newY < 0) newY = 0;
                    if (newY >= this.screenSize.height) newY = this.screenSize.height - 1;
                    if (newX >= this.screenSize.width) newX = this.screenSize.width - 1;

                    robot.moveMouse(newX, newY);
                    break;
                case 'mousedown':
                    robot.mouseToggle('down', event.button);
                    break;
                case 'mouseup':
                    robot.mouseToggle('up', event.button);
                    break;
                case 'mousewheel':
                    robot.scrollMouse(0, event.delta * 10);
                    break;
                case 'keydown':
                    robot.keyToggle(event.key, 'down');
                    break;
                case 'keyup':
                    robot.keyToggle(event.key, 'up');
                    break;
            }
        } catch (err) {
            logger.error('Injection failed', { error: err.message, stack: err.stack });
        }
        return null;
    }

    // Windows-specific: release OS-level cursor clipping
    _releaseClipCursor() {
        if (process.platform !== 'win32') return;
        try {
            const { execSync } = require('child_process');
            execSync(
                'powershell -NoProfile -Command "Add-Type -TypeDefinition \'' +
                'using System; using System.Runtime.InteropServices; ' +
                'public class CursorRelease { ' +
                '[DllImport(\\\\\\\"user32.dll\\\\\\\")] ' +
                'public static extern bool ClipCursor(IntPtr lpRect); }\'; ' +
                '[CursorRelease]::ClipCursor([IntPtr]::Zero)"',
                { timeout: 5000, stdio: 'ignore' }
            );
        } catch (e) {
            // Best-effort — don't crash if this fails
        }
    }

    stop() {
        this.active = false;
        this.remoteMode = false;
        this._ctrlDown = false;
        this._altDown = false;
        try {
            // CRITICAL: Remove all listeners FIRST so the cursor trap stops immediately,
            // even if uIOhook.stop() takes time or fails
            uIOhook.removeAllListeners();
        } catch (e) {
            logger.error('Failed to remove listeners', { error: e.message });
        }
        try {
            uIOhook.stop();
        } catch (e) {
            // Already stopped — this is fine
        }
        // Release any OS-level cursor confinement
        this._releaseClipCursor();
    }
}

module.exports = InputEngine;