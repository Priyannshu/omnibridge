// lib/bridge.js — Connection, encryption, KVM pipeline, and bridge lifecycle management
const EventEmitter = require('events');
const WSClient = require('../core/wsClient');
const SecureChannel = require('../core/secureChannel');
const Config = require('../core/config');
const createLogger = require('../core/loggerFactory');

const logger = createLogger({ appName: 'Omnibridge-Bridge' });

// Input event types that should be routed to the KVM injection pipeline
const INPUT_EVENTS = new Set([
    'mousemove', 'mousedown', 'mouseup', 'mousewheel', 'keydown', 'keyup'
]);

class Bridge extends EventEmitter {
    constructor() {
        super();
        this.config = new Config();
        const serverConfig = this.config.get().server;
        this.serverSecret = serverConfig.secret;
        this.serverHost = serverConfig.host;
        this.serverPort = serverConfig.port;

        this.secureChannel = new SecureChannel(this.serverSecret);
        this.wsClient = null;

        this.connected = false;            // signaling server WebSocket connected
        this.bridgeActive = false;         // bridge engine initialized (KVM active)

        // Connection state machine: null → CONNECTING → CONNECTED
        this.connectedDevice = null;       // { name, host } — only set when CONNECTED
        this._pendingDevice = null;        // { name, host } — set during CONNECTING
        this._connectTimeout = null;       // timeout handle for connection attempt

        // KVM state
        this.currentSystem = 'local';      // 'local' (mouse here) or 'remote' (mouse on peer)
        this._edgeInterval = null;         // cursor edge detection polling timer
        this._isSwitching = false;         // debounce guard for local↔remote switch

        this.clipboardOn = false;
        this.modeAuto = true;

        // Native addons — loaded lazily/gracefully
        this.inputEngine = null;
        this._robot = null;                // @jitsi/robotjs — lazy loaded
        this._screenSize = null;           // cached screen dimensions

        // Try to load InputEngine (requires native addons)
        try {
            const InputEngine = require('../core/inputEngine');
            this.inputEngine = new InputEngine();
        } catch (e) {
            logger.warn('InputEngine not available (native addon missing)', { error: e.message });
        }
    }

    // ═══════════════════════════════════════════════════════
    //  SIGNALING SERVER CONNECTION
    // ═══════════════════════════════════════════════════════

    /** Connect to the signaling server at the given URL. */
    connectServer(host, port) {
        const url = `ws://${host}:${port}`;
        this.serverHost = host;
        this.serverPort = port;

        if (this.wsClient) this.wsClient.disconnect();
        this.wsClient = new WSClient(url, this.secureChannel);

        this.wsClient.onStatus = (status, data) => {
            logger.info('WS status', { status });
            if (status === 'connected') {
                this.connected = true;
                this.emit('ws-status', 'connected');
            } else if (status === 'disconnected' || status === 'error') {
                this.connected = false;
                this.emit('ws-status', status);
            } else if (status === 'connection-request-pending') {
                this.emit('connection-request', data);
            } else if (status === 'connection-established') {
                // Peer confirmed — promote pending to connected
                this._clearConnectTimeout();
                this.connectedDevice = this._pendingDevice || { name: 'peer', host: host };
                this._pendingDevice = null;
                this.emit('connection-established', this.connectedDevice);
            } else if (status === 'connection-rejected') {
                this._clearConnectTimeout();
                this.connectedDevice = null;
                this._pendingDevice = null;
                this.emit('connection-rejected', data);
            }
        };

        // ── Event routing: KVM injection + file transfer + switch signals ──
        this.wsClient.onEvent = async (event) => {
            // Switch-to-local signal from peer: peer's cursor hit their edge, return control
            if (event.type === 'switch-to-local') {
                this._switchToLocal();
                return;
            }

            // KVM input events: inject mouse/keyboard on this machine
            if (this.bridgeActive && INPUT_EVENTS.has(event.type)) {
                await this._handleInputEvent(event);
                return;
            }

            // All other events (file-chunk, drag, etc.) go to the REPL
            this.emit('event', event);
        };

        this.wsClient.connect();
    }

    // ═══════════════════════════════════════════════════════
    //  PEER CONNECTION
    // ═══════════════════════════════════════════════════════

    /**
     * Initiate connection to a device by name (via signaling server).
     * Sets state to CONNECTING. Only transitions to CONNECTED when the server
     * confirms with 'connection-established'. Times out after timeoutMs.
     */
    connectToDevice(name, host, timeoutMs = 15000) {
        if (!this.wsClient) { this.emit('error', 'Not connected to signaling server'); return; }

        // Clear any previous pending connection
        this._clearConnectTimeout();
        this.connectedDevice = null;

        // Store as pending — NOT connected yet
        this._pendingDevice = { name, host: host || name };
        this.wsClient.requestConnection(name);
        this.emit('connecting', name);

        // Start timeout — if the peer doesn't respond, revert to disconnected
        this._connectTimeout = setTimeout(() => {
            if (this._pendingDevice && !this.connectedDevice) {
                const timedOutDevice = this._pendingDevice.name;
                this._pendingDevice = null;
                this.emit('connection-timeout', timedOutDevice);
            }
        }, timeoutMs);
    }

    /** Manual IP connection — reconnect wsClient to a different server URL. */
    manualConnect(ip) {
        this.modeAuto = false;
        this._pendingDevice = null;
        this.connectedDevice = null;
        this._clearConnectTimeout();
        this.connectServer(ip, this.serverPort);
        this.emit('connecting', ip);
    }

    /** Approve an incoming connection request. */
    approveConnection(requestingClientId) {
        if (this.wsClient) this.wsClient.approveConnection(requestingClientId);
    }

    // ═══════════════════════════════════════════════════════
    //  KVM ENGINE — Edge Detection + Input Forwarding
    // ═══════════════════════════════════════════════════════

    /**
     * Initialize the bridge engine. This activates:
     * 1. Screen edge detection (50ms polling via robotjs)
     * 2. Input capture → WebSocket forwarding (when cursor crosses edge)
     * 3. Remote input injection (when receiving events from peer)
     *
     * Requires: a connected peer device + native addons (robotjs, uiohook-napi).
     */
    initEngine() {
        if (!this.connectedDevice) {
            this.emit('error', 'Connect to a device first (use "connect <device>")');
            return;
        }
        if (!this.inputEngine) {
            this.emit('error', 'Input engine not available — native addons (robotjs, uiohook-napi) are required for KVM');
            return;
        }

        // Lazy-load robotjs for cursor position polling
        try {
            if (!this._robot) this._robot = require('@jitsi/robotjs');
            this._screenSize = this._robot.getScreenSize();
        } catch (e) {
            this.emit('error', `robotjs not available: ${e.message}`);
            return;
        }

        this.bridgeActive = true;

        // Wire the escape hotkey callback: Ctrl+Alt+Q or Escape → return to local
        this.inputEngine.onStop = () => {
            logger.info('User broke out of remote capture (escape hotkey)');
            this._switchToLocal();
        };

        // Start polling cursor position for edge detection
        this._startEdgeDetection();

        this.emit('engine-status', 'active');
        logger.info('KVM engine active', {
            screen: this._screenSize,
            device: this.connectedDevice.name
        });
    }

    /**
     * Start polling the cursor position every 50ms.
     * When the cursor reaches the right edge of the screen (within 5px),
     * switch to remote mode and begin capturing + forwarding input.
     */
    _startEdgeDetection() {
        this._stopEdgeDetection();

        this._edgeInterval = setInterval(() => {
            // Only check edges when bridge is active and we're in local mode
            if (!this.bridgeActive || this.currentSystem === 'remote' || this._isSwitching) return;

            const pos = this._robot.getMousePos();

            // Right edge: switch to remote
            if (pos.x >= this._screenSize.width - 5) {
                this._switchToRemote();
            }
        }, 50);

        // Don't prevent Node.js from exiting if this is the only timer
        if (this._edgeInterval.unref) this._edgeInterval.unref();
    }

    /** Stop the edge detection polling. */
    _stopEdgeDetection() {
        if (this._edgeInterval) {
            clearInterval(this._edgeInterval);
            this._edgeInterval = null;
        }
    }

    /**
     * Switch to REMOTE mode:
     * - Start capturing all mouse/keyboard input via uiohook-napi
     * - Forward every captured event to the peer via the WebSocket
     * - The local cursor is trapped in center of screen (prevents it escaping)
     *
     * The capture continues until:
     * - User presses Ctrl+Alt+Q or Escape (inputEngine.onStop fires)
     * - Peer signals switch-to-local (their cursor hit the edge)
     */
    _switchToRemote() {
        if (this._isSwitching || this.currentSystem === 'remote') return;
        this._isSwitching = true;

        try {
            this.currentSystem = 'remote';
            this.emit('system-switched', 'remote');

            const centerX = Math.floor(this._screenSize.width / 2);
            const centerY = Math.floor(this._screenSize.height / 2);

            // Start capturing input — every event is forwarded to the peer
            this.inputEngine.startCapture((event) => {
                if (this.wsClient) {
                    this.wsClient.sendEvent(event);
                }
            }, centerX, centerY);

            logger.info('Switched to REMOTE — capturing input');
        } finally {
            // Debounce: prevent instant switch-back from edge race conditions
            setTimeout(() => { this._isSwitching = false; }, 200);
        }
    }

    /**
     * Switch to LOCAL mode:
     * - Stop capturing input (releases cursor trap)
     * - Move cursor to the right edge (where it "entered" from the peer)
     */
    _switchToLocal() {
        if (this.currentSystem === 'local') return;

        this.currentSystem = 'local';

        if (this.inputEngine) {
            this.inputEngine.stop();
        }

        // Move cursor to the right edge so the user sees continuity
        try {
            if (this._robot && this._screenSize) {
                const currentPos = this._robot.getMousePos();
                this._robot.moveMouse(
                    this._screenSize.width - 10,
                    currentPos.y || Math.floor(this._screenSize.height / 2)
                );
            }
        } catch (_) {}

        this.emit('system-switched', 'local');
        logger.info('Switched to LOCAL — input released');
    }

    /**
     * Handle an incoming KVM input event from the peer.
     * Injects it on this machine via robotjs.
     * If the injected mouse cursor hits the edge, signals the peer to stop capture.
     */
    async _handleInputEvent(event) {
        if (!this.inputEngine) return;

        try {
            const result = await this.inputEngine.injectEvent(event);

            // Receiver's cursor hit the screen edge → signal peer to release capture
            if (result && result.action === 'switch-to-local') {
                if (this.wsClient) {
                    this.wsClient.sendEvent({ type: 'switch-to-local' });
                }
                this._switchToLocal();
            }
        } catch (e) {
            logger.error('Input injection failed', { error: e.message });
        }
    }

    // ═══════════════════════════════════════════════════════
    //  BRIDGE LIFECYCLE
    // ═══════════════════════════════════════════════════════

    /** Disconnect the bridge. */
    disconnect() {
        this.bridgeActive = false;
        this.connectedDevice = null;
        this._pendingDevice = null;
        this.currentSystem = 'local';
        this._isSwitching = false;
        this._clearConnectTimeout();
        this._stopEdgeDetection();

        if (this.inputEngine) {
            try { this.inputEngine.stop(); } catch (_) {}
        }

        this.emit('engine-status', 'idle');
    }

    /** Send a file over the bridge. Returns a promise. */
    async sendFile(filePath, fileEngine, onProgress) {
        if (!this.wsClient) throw new Error('Not connected');
        const base64 = await fileEngine.readFileAsBase64(filePath);
        if (!base64) throw new Error('File not found or unreadable');

        const path = require('path');
        const fileName = path.basename(filePath);

        await this.wsClient.sendChunked('file-chunk', { fileName, data: base64 }, (progress) => {
            if (onProgress) onProgress(fileName, progress);
        });
    }

    /** Toggle clipboard sharing. */
    setClipboard(on) {
        this.clipboardOn = on;
    }

    /** Get current status summary. */
    getStatus() {
        let bridgeState;
        if (this.connectedDevice) {
            bridgeState = 'CONNECTED';
        } else if (this._pendingDevice) {
            bridgeState = 'CONNECTING';
        } else {
            bridgeState = 'DISCONNECTED';
        }

        return {
            engine: this.bridgeActive ? 'ACTIVE' : 'IDLE',
            bridge: bridgeState,
            device: this.connectedDevice || this._pendingDevice,
            mode: this.modeAuto ? 'AUTOMATIC' : 'MANUAL IP',
            encryption: 'AES-256',
            clipboard: this.clipboardOn ? 'ON' : 'OFF',
            server: this.connected ? `${this.serverHost}:${this.serverPort}` : 'DISCONNECTED',
            cursor: this.currentSystem,
            kvmReady: !!this.inputEngine
        };
    }

    /** Clear the connection attempt timeout. */
    _clearConnectTimeout() {
        if (this._connectTimeout) {
            clearTimeout(this._connectTimeout);
            this._connectTimeout = null;
        }
    }

    /** Shut down everything cleanly. */
    shutdown() {
        this._clearConnectTimeout();
        this._stopEdgeDetection();
        if (this.inputEngine) {
            try { this.inputEngine.stop(); } catch (_) {}
        }
        if (this.wsClient) this.wsClient.disconnect();
    }
}

module.exports = Bridge;
