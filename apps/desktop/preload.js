const { contextBridge, ipcRenderer, clipboard } = require('electron');

// Expose protected methods to renderer via a clean API.
// Every IPC channel the terminal UI needs is surfaced here.
contextBridge.exposeInMainWorld('omnibridgeAPI', {
    // Generic (kept for compatibility)
    send: (channel, data) => ipcRenderer.send(channel, data),
    on:   (channel, func) => ipcRenderer.on(channel, (event, ...args) => func(...args)),

    // Clipboard read/write
    readClipboard:  () => clipboard.readText(),
    writeClipboard: (text) => clipboard.writeText(text),

    // Bridge engine
    initializeBridge: () => ipcRenderer.send('initialize-bridge'),
    onBridgeStatus:   (fn) => ipcRenderer.on('bridge-status', (_, status) => fn(status)),

    // Manual IP connection
    manualConnect: (ip) => ipcRenderer.send('manual-connect', ip),

    // Network scan — triggers a fresh mDNS device scan
    requestScan: () => ipcRenderer.send('request-scan'),

    // WebSocket status
    onWsStatus: (fn) => ipcRenderer.on('ws-status', (_, status) => fn(status)),

    // Connection status
    onConnectionStatus: (fn) => ipcRenderer.on('connection-status', (_, data) => fn(data)),

    // Device discovery
    onDeviceFound:   (fn) => ipcRenderer.on('device-found', (_, device) => fn(device)),
    connectToDevice: (name) => ipcRenderer.send('connect-to-device', { name }),

    // System switch (cursor crossed edge)
    onSystemSwitched: (fn) => ipcRenderer.on('system-switched', (_, system) => fn(system)),

    // File transfer
    sendFile:       (filePath) => ipcRenderer.send('send-file', filePath),
    onFileProgress: (fn) => ipcRenderer.on('file-progress', (_, data) => fn(data)),
    onFileReceived: (fn) => ipcRenderer.on('file-received', (_, data) => fn(data)),
    startNativeDrag: (filePath) => ipcRenderer.send('start-native-drag', { filePath }),

    // Store path of a received file for later native drag
    storeReceivedFile: (filePath) => ipcRenderer.send('store-received-file', filePath),

    // Clipboard sharing
    startClipboardSharing: () => ipcRenderer.send('start-clipboard-sharing'),
    stopClipboardSharing:  () => ipcRenderer.send('stop-clipboard-sharing'),

    // Connection approval
    onConnectionRequestPending: (fn) => ipcRenderer.on('connection-request-pending', (_, data) => fn(data)),
    approveConnection: (requestingClientId) => ipcRenderer.send('approve-connection', { requestingClientId }),
    rejectConnection:  (requestingClientId) => ipcRenderer.send('reject-connection',  { requestingClientId }),
});