const { app, clipboard, Tray, Menu, nativeImage, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const Discovery = require('../../core/discovery');
const InputEngine = require('../../core/inputEngine');
const LayoutEngine = require('../../core/layoutEngine');
const SecureChannel = require('../../core/secureChannel');
const WSClient = require('../../core/wsClient');
const FileEngine = require('../../core/fileEngine');
const DragEngine = require('../../core/dragEngine');
const Config = require('../../core/config');
const createLogger = require('../../core/loggerFactory');

// Create logger instance
const logger = createLogger({ appName: 'Omnibridge-Main' });

// Windows-specific: Release any OS-level cursor clipping rectangle.
// This prevents the cursor from being confined to a window region.
function releaseClipCursor() {
    if (process.platform !== 'win32') return;
    try {
        execSync(
            'powershell -NoProfile -Command "Add-Type -TypeDefinition \'' +
            'using System; using System.Runtime.InteropServices; ' +
            'public class CursorRelease { ' +
            '[DllImport(\\\"user32.dll\\\")] ' +
            'public static extern bool ClipCursor(IntPtr lpRect); }\'; ' +
            '[CursorRelease]::ClipCursor([IntPtr]::Zero)"',
            { timeout: 5000, stdio: 'ignore' }
        );
        logger.info('ClipCursor released');
    } catch (e) {
        logger.warn('Failed to release ClipCursor', { error: e.message });
    }
}

// Load configuration
const config = new Config();
const serverConfig = config.get().server;
const DEFAULT_SECRET = serverConfig.secret;

let mainWindow;
let edgeWindow;
let bridgeActive = false;
let currentSystem = 'local';
let capturing = false;
let tray = null;
let boundaryInterval = null;
let isSwitching = false;

// Clipboard sharing state
let lastClipboardContent = clipboard.readText();
let clipboardCheckInterval = null;
let isMonitoringClipboard = false;
let localClipboardContent = '';

const discovery = new Discovery();
const inputEngine = new InputEngine();
const layoutEngine = new LayoutEngine();
const secureChannel = new SecureChannel(DEFAULT_SECRET);
const fileEngine = new FileEngine();

// WSClient and DragEngine are created after server discovery
let wsClient = null;
let dragEngine = null;

/**
 * Try to discover the signaling server via mDNS on the local network.
 * Falls back to the config file host/port if nothing is found within 3 seconds.
 */
async function initConnection() {
    logger.info('Searching for signaling server on the network...');
    const discovered = await discovery.findServer(3000);

    let host, port;
    if (discovered) {
        host = discovered.host;
        port = discovered.port;
        logger.info('Using discovered server', { host, port });
    } else {
        host = serverConfig.host;
        port = serverConfig.port;
        logger.info('Using config server', { host, port });
    }

    const signalingUrl = `ws://${host}:${port}`;
    wsClient = new WSClient(signalingUrl, secureChannel);
    dragEngine = new DragEngine(wsClient, fileEngine); // pass shared fileEngine singleton

    // Forward device-found events from the discovery module to the renderer
    discovery.on('deviceFound', (device) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('device-found', device);
        }
    });
}

// Handle user pressing Escape/Ctrl+Alt+Q to break out of remote capture
inputEngine.onStop = () => {
    logger.info('User escaped remote capture mode');
    currentSystem = 'local';
    capturing = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('system-switched', 'local');
    }
};

function createEdgeWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    edgeWindow = new BrowserWindow({
        width: 1,
        height: height,
        x: width - 1,
        y: 0,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: false,
        webPreferences: { nodeIntegration: true }
    });
    
    edgeWindow.setIgnoreMouseEvents(false);
    
    // Register native drag interception on this 1px invisible edge
    if (!dragEngine) return; // guard: dragEngine not ready if initConnection failed
    dragEngine.registerEdgeWindow(edgeWindow.getNativeWindowHandle(), () => {
        // When drag crosses, immediately switch to remote so the mouse cursor keeps moving on receiver
        if (currentSystem === 'local' && bridgeActive) {
            handleSystemSwitch('remote', width, height);
        }
    });
}

async function createWindow() {
    // Release any stale cursor clipping from a previous crash/run
    releaseClipCursor();

    // Create the system tray
    createSystemTray();

    mainWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        backgroundColor: '#050505',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        frame: false,
        show: false
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));
    mainWindow.once('ready-to-show', () => mainWindow.show());
    
    // Minimize to system tray instead of closing
    mainWindow.on('minimize', function (event) {
        event.preventDefault();
        mainWindow.hide();
    });

    // Discover signaling server on the network (or fall back to config)
    await initConnection();

// Start boundary detection polling (guard so it never stacks on re-open)
    if (!boundaryInterval) boundaryInterval = setInterval(() => {
        if (!bridgeActive || currentSystem === 'remote' || capturing) return;
        
        const { x, y } = screen.getCursorScreenPoint();
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width, height } = primaryDisplay.workAreaSize;
        
        // Check if cursor is at the edge of the screen (5px from edge)
        if (x >= width - 5 || x <= 5) {
            handleSystemSwitch('remote', width, height);
            return;
        }
    }, 50); // Check every 50ms for more responsive boundary detection

    // Set up WebSocket client status handler
    wsClient.onStatus = (status, data) => {
        logger.info('WS status changed', { status });
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ws-status', status);
        }
        if (status === 'connection-request-pending') {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('connection-request-pending', data);
            }
        } else if (status === 'connection-established') {
            logger.info('Connection established with peer');
            bridgeActive = true;
        } else if (status === 'connection-rejected') {
            logger.info('Connection rejected by peer');
        }
    };

    // Set up WebSocket event handler — routes input, file, and drag events
    wsClient.onEvent = async (event) => {
        try {
            if (event.type === 'file-chunk') {
                const isFirst = event.chunkIndex === 0;
                const filePath = await fileEngine.appendChunk(event.fileName, event.data, isFirst, event.checksum);
                const progress = (event.chunkIndex + 1) / event.totalChunks;
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('file-progress', { fileName: event.fileName, progress });
                    if (event.chunkIndex === event.totalChunks - 1) {
                        mainWindow.webContents.send('file-received', { name: event.fileName, path: filePath });
                    }
                }
                return;
            }
            // Drag-and-drop receive
            if (event.type === 'drag-start')      { if (dragEngine) dragEngine.handleDragStartEvent(event); return; }
            if (event.type === 'drag-file-chunk') { if (dragEngine) await dragEngine.handleDragFileChunk(event); return; }
            if (event.type === 'drag-ready')      { if (dragEngine) dragEngine.handleDragReady(event); return; }
            // Remote peer signalled return to local
            if (event.type === 'switch-to-local') { handleSystemSwitch('local'); return; }
            // KVM injection (receiver side) — also handles left-edge return signal
            const result = await inputEngine.injectEvent(event);
            if (result && result.action === 'switch-to-local') {
                wsClient.sendEvent({ type: 'switch-to-local' });
                handleSystemSwitch('local');
            }
        } catch (err) {
            logger.error('onEvent handler failed', { error: err.message });
        }
    };

    // Connect to signaling server
    wsClient.connect();

    // Create edge detection window for drag-and-drop
    createEdgeWindow();
}

// ── Electron App Lifecycle ──
app.whenReady().then(async () => {
    await createWindow();

    app.on('activate', async () => {
        if (BrowserWindow.getAllWindows().length === 0) await createWindow();
    });
});

app.on('window-all-closed', () => {
    if (wsClient) wsClient.disconnect();
    discovery.stop();
    if (process.platform !== 'darwin') app.quit();
});

function createSystemTray() {
    if (tray) return; // guard against duplicate tray on macOS re-activate
    // Create the system tray icon
    const iconPath = path.join(__dirname, 'file-icon.png');
    tray = new Tray(iconPath);
    
    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Show Omnibridge',
            click: () => {
                mainWindow.show();
            }
        },
        {
            label: 'Minimize to Tray',
            click: () => {
                mainWindow.hide();
            }
        },
        {
            label: 'Quit',
            click: () => {
                app.quit();
            }
        }
    ]);
    
    tray.setContextMenu(contextMenu);
    tray.setIgnoreDoubleClickEvents(true);
    tray.on('click', () => {
        mainWindow.show();
    });
    
    tray.on('right-click', () => {
        tray.popUpContextMenu(contextMenu);
    });
}

function handleSystemSwitch(system, width, height) {
    if (isSwitching) return;
    isSwitching = true;
    try {
        if (system === 'remote') {
            capturing = true;
            currentSystem = 'remote';
            mainWindow.webContents.send('system-switched', 'remote');
            const centerX = Math.floor(width / 2);
            const centerY = Math.floor(height / 2);
            inputEngine.startCapture((event) => {
                if (wsClient) wsClient.sendEvent(event);
            }, centerX, centerY);
        } else {
            currentSystem = 'local';
            capturing = false;
            inputEngine.stop();
            releaseClipCursor();
            mainWindow.webContents.send('system-switched', 'local');
            if (width && height) {
                const robot = require('@jitsi/robotjs');
                const { y } = screen.getCursorScreenPoint();
                robot.moveMouse(width - 2, y || Math.floor(height / 2));
            }
        }
    } finally {
        // Add a small delay to prevent immediate switching back
        setTimeout(() => {
            isSwitching = false;
        }, 200);
    }
}

ipcMain.on('send-file', async (event, filePath) => {
    try {
        if (!fs.existsSync(filePath)) return;
        if (!wsClient) { logger.warn('send-file: wsClient not ready'); return; }
        const base64 = await fileEngine.readFileAsBase64(filePath);
        if (base64) {
            const fileName = path.basename(filePath);
            wsClient.sendChunked('file-chunk', { fileName, data: base64 }, (progress) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('file-progress', { fileName, progress, type: 'send' });
                }
            });
        }
    } catch (err) {
        logger.error('send-file failed', { error: err.message });
    }
});

// ── Connection Approval IPC Handlers ──
ipcMain.on('request-connection', (event, { targetDeviceId }) => {
    if (!wsClient) return;
    wsClient.requestConnection(targetDeviceId);
});

ipcMain.on('approve-connection', (event, { requestingClientId }) => {
    if (!wsClient) return;
    wsClient.approveConnection(requestingClientId);
});

ipcMain.on('reject-connection', (event, { requestingClientId }) => {
    if (!wsClient) return;
    wsClient.rejectConnection(requestingClientId);
});

// ── Bridge Engine ──
// The "INITIALIZE ENGINE" button in the UI triggers this.
// It activates boundary detection so that moving the cursor to the screen edge
// will switch control to the remote device.
ipcMain.on('initialize-bridge', (event) => {
    bridgeActive = true;
    logger.info('Bridge engine initialized — edge detection active');
    event.reply('bridge-status', 'active');
});

// ── Manual IP Connection ──
// When user switches to MANUAL IP mode and enters an IP address.
ipcMain.on('manual-connect', (event, ip) => {
    if (!wsClient) return;
    wsClient.disconnect();
    wsClient.serverUrl = `ws://${ip}:${serverConfig.port}`;
    wsClient.connect();
    logger.info('Manual connect', { ip });
    event.reply('connection-status', { device: ip, status: 'connecting' });
});

// ── Device Discovery Connect ──
// When user clicks CONNECT on a discovered device card.
ipcMain.on('connect-to-device', (event, { name }) => {
    if (!wsClient) { logger.warn('connect-to-device: wsClient not ready'); return; }
    logger.info('Connecting to discovered device', { name });
    wsClient.requestConnection(name);
    event.reply('connection-status', { device: name, status: 'connecting' });
});

// ── Native Drag from Ghost Icon ──
// When user clicks the ghost file icon to drag a received file to their desktop.
ipcMain.on('start-native-drag', (event, { filePath }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.startDrag({
            file: filePath,
            icon: path.join(__dirname, 'file-icon.png')
        });
    }
});

// ── Re-scan network (terminal `scan` command) ──
ipcMain.on('request-scan', (event) => {
    logger.info('Manual scan requested from terminal');
    try {
        const { Bonjour } = require('bonjour-service');
        const scanner = new Bonjour();
        const browser = scanner.find({ type: 'omnibridge-signal' });

        browser.on('up', (service) => {
            if (service.name.startsWith('omnibridge')) {
                const device = {
                    name: service.name,
                    host: service.referer?.address || service.host,
                    port: service.port
                };
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('device-found', device);
                }
            }
        });

        // Stop scanning after 5 seconds
        setTimeout(() => {
            try { browser.stop(); scanner.destroy(); } catch (_) {}
        }, 5000);
    } catch (err) {
        logger.error('Scan failed', { error: err.message });
    }
});

// ── Store received file path for native drag ──
let storedReceivedFile = null;
ipcMain.on('store-received-file', (event, filePath) => {
    storedReceivedFile = filePath;
});

// ── Disconnect bridge ──
ipcMain.on('disconnect-bridge', () => {
    bridgeActive = false;
    capturing = false;
    currentSystem = 'local';
    inputEngine.stop();
    releaseClipCursor();
    logger.info('Bridge disconnected via terminal command');
});