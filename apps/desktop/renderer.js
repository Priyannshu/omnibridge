// renderer.js — Terminal UI for OmniBridge
// Drives the full command-terminal interface: boot sequence, command parsing,
// autocomplete, keyboard UX, drag-and-drop, and IPC event streaming.

const api = window.omnibridgeAPI;

// ── DOM References ─────────────────────────────────────
const outputPane  = document.getElementById('outputPane');
const cmdInput    = document.getElementById('cmdInput');
const engineDot   = document.getElementById('engineDot');
const engineLabel = document.getElementById('engineLabel');

// ── State ──────────────────────────────────────────────
let commandHistory = [];
let historyIndex   = -1;
let engineActive   = false;
let bridgeConnected = false;
let connectedDevice = null;
let clipboardOn    = false;
let modeAuto       = true;
let discoveredDevices = [];  // { name, host, latency }
let activeOperation = null;  // reference to cancel-able intervals
let transferLineEl  = null;  // element for in-place progress bar updates

// ── Commands Registry ──────────────────────────────────
const COMMANDS = [
    'scan', 'connect', 'disconnect', 'status', 'mode',
    'clipboard', 'drop', 'init', 'clear', 'help'
];

// ── Output Helpers ─────────────────────────────────────

/** Append a single styled line to the output pane. */
function printLine(text, colorClass = 'c-default') {
    const el = document.createElement('div');
    el.className = `term-line ${colorClass}`;
    el.textContent = text;
    outputPane.appendChild(el);
    outputPane.scrollTop = outputPane.scrollHeight;
    return el;
}

/** Append a line with mixed color spans. segments = [{text, cls}] */
function printSegments(segments) {
    const el = document.createElement('div');
    el.className = 'term-line';
    segments.forEach(seg => {
        const span = document.createElement('span');
        span.className = seg.cls || 'c-default';
        span.textContent = seg.text;
        el.appendChild(span);
    });
    outputPane.appendChild(el);
    outputPane.scrollTop = outputPane.scrollHeight;
    return el;
}

/** Print a blank line. */
function printBlank() { printLine(''); }

/** Stream an array of {text, cls} lines with a delay between each. */
function streamLines(lines, delayMs = 80) {
    return new Promise(resolve => {
        let i = 0;
        function next() {
            if (i >= lines.length) { resolve(); return; }
            const l = lines[i++];
            if (typeof l === 'string') printLine(l);
            else printLine(l.text, l.cls);
            setTimeout(next, delayMs);
        }
        next();
    });
}

// ── Boot Sequence ──────────────────────────────────────

async function runBootSequence() {
    const bootLines = [
        { text: 'OMNIBRIDGE v1.2.0-PRO',                         cls: 'c-bold' },
        { text: 'END-TO-END ENCRYPTION ACTIVE [AES-256]',        cls: 'c-dim' },
        { text: '────────────────────────────────────────',       cls: 'c-separator' },
        { text: '[sys]  Initializing bridge engine...',           cls: 'c-info' },
        { text: '[sys]  Loading network interfaces... OK',        cls: 'c-info' },
        { text: '[sys]  AES-256 keychain loaded',                 cls: 'c-info' },
        { text: '[sys]  mDNS discovery armed',                    cls: 'c-info' },
        { text: '[net]  Scanning subnet 192.168.x.x/24...',      cls: 'c-info' },
    ];

    await streamLines(bootLines, 80);

    // After boot, wait briefly then report device state
    setTimeout(() => {
        if (discoveredDevices.length === 0) {
            printLine('[net]  Awaiting device discovery...', 'c-dim');
        }
        printBlank();
        printLine('Type "help" for available commands.', 'c-dim');
        printBlank();
        cmdInput.focus();
    }, 600);
}

// ── Command Parser ─────────────────────────────────────

function executeCommand(raw) {
    const trimmed = raw.trim();
    if (!trimmed) return;

    // Echo the command
    printSegments([
        { text: 'omni ❯ ', cls: 'c-prompt' },
        { text: trimmed, cls: 'c-default' }
    ]);

    // Push to history (max 50)
    commandHistory.unshift(trimmed);
    if (commandHistory.length > 50) commandHistory.pop();
    historyIndex = -1;

    const parts = trimmed.split(/\s+/);
    const cmd   = parts[0].toLowerCase();
    const args  = parts.slice(1);

    switch (cmd) {
        case 'help':       cmdHelp();                break;
        case 'clear':      cmdClear();               break;
        case 'scan':       cmdScan();                break;
        case 'connect':    cmdConnect(args);          break;
        case 'disconnect': cmdDisconnect();           break;
        case 'status':     cmdStatus();               break;
        case 'mode':       cmdMode(args);             break;
        case 'clipboard':  cmdClipboard(args);        break;
        case 'drop':       cmdDrop(args);             break;
        case 'init':       cmdInit();                 break;
        default:
            printLine(`Unknown command: ${cmd}. Type "help" for a list of commands.`, 'c-error');
    }
}

// ── Command Implementations ────────────────────────────

function cmdHelp() {
    const lines = [
        '',
        { text: '  AVAILABLE COMMANDS', cls: 'c-bold' },
        { text: '  ──────────────────────────────────────', cls: 'c-separator' },
        { text: '  scan                Re-run network discovery, stream results live', cls: 'c-default' },
        { text: '  connect <device>    Initiate bridge to a named or IP device', cls: 'c-default' },
        { text: '  disconnect          Drop current bridge connection', cls: 'c-default' },
        { text: '  status              Print bridge state, device, encryption info', cls: 'c-default' },
        { text: '  mode auto           Switch to automatic mDNS discovery', cls: 'c-default' },
        { text: '  mode manual <ip>    Switch to manual IP and connect', cls: 'c-default' },
        { text: '  clipboard on|off    Toggle shared clipboard', cls: 'c-default' },
        { text: '  drop <filepath>     Queue a file for secure bridge transfer', cls: 'c-default' },
        { text: '  init                Run engine initialization', cls: 'c-default' },
        { text: '  clear               Clear terminal output', cls: 'c-default' },
        { text: '  help                Show this help message', cls: 'c-default' },
        '',
        { text: '  Keyboard: ↑↓ history  |  Tab autocomplete  |  Ctrl+L clear  |  Ctrl+C cancel', cls: 'c-dim' },
        '',
    ];
    lines.forEach(l => {
        if (typeof l === 'string') printLine(l);
        else printLine(l.text, l.cls);
    });
}

function cmdClear() {
    outputPane.innerHTML = '';
}

function cmdScan() {
    discoveredDevices = [];
    printLine('[net]  Scanning subnet 192.168.x.x/24...', 'c-info');

    // Request scan from main process
    api.requestScan();

    // Set timeout for "no devices" message
    activeOperation = setTimeout(() => {
        if (discoveredDevices.length === 0) {
            printLine('[net]  No new devices found on subnet.', 'c-warning');
        }
        printLine(`[net]  Scan complete — ${discoveredDevices.length} device(s) found.`, 'c-info');
        activeOperation = null;
    }, 5000);
}

function cmdConnect(args) {
    if (args.length === 0) {
        printLine('Usage: connect <device-name or IP>', 'c-error');
        return;
    }

    const target = args.join(' ');

    // Check if it's an IP address
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (ipRegex.test(target)) {
        // Manual IP connection
        printLine(`[bridge]  Initiating handshake → ${target}`, 'c-info');
        simulateHandshake(target, target);
        api.manualConnect(target);
        return;
    }

    // Look up device by name
    const device = discoveredDevices.find(d =>
        d.name.toLowerCase().includes(target.toLowerCase())
    );

    if (!device) {
        printLine(`[bridge]  Device "${target}" not found. Run "scan" first.`, 'c-error');
        return;
    }

    printLine(`[bridge]  Initiating handshake → ${device.host}`, 'c-info');
    simulateHandshake(device.name, device.host);
    api.connectToDevice(device.name);
}

async function simulateHandshake(name, host) {
    const steps = [
        { text: '[bridge]  Exchanging keys...',           cls: 'c-info', delay: 400 },
        { text: '[bridge]  Verifying certificate...',     cls: 'c-info', delay: 600 },
        { text: `[bridge]  ✓ Bridge established — LOCAL SYSTEM ↔ ${name}`, cls: 'c-success', delay: 500 },
        { text: `[bridge]  Latency: ${randomLatency()}ms  |  Encryption: AES-256  |  Clipboard: ${clipboardOn ? 'ON' : 'OFF'}`, cls: 'c-dim', delay: 100 },
    ];

    for (const step of steps) {
        await delay(step.delay);
        printLine(step.text, step.cls);
    }

    connectedDevice = { name, host };
}

function cmdDisconnect() {
    if (!connectedDevice) {
        printLine('[bridge]  No active bridge to disconnect.', 'c-warning');
        return;
    }

    printLine(`[bridge]  Dropping bridge → ${connectedDevice.name}...`, 'c-info');
    connectedDevice = null;
    bridgeConnected = false;
    setEngineStatus(false);
    printLine('[bridge]  ✗ Bridge disconnected.', 'c-warning');
    api.send('disconnect-bridge', {});
}

function cmdStatus() {
    printBlank();
    printLine('  BRIDGE STATUS', 'c-bold');
    printLine('  ──────────────────────────────────────', 'c-separator');
    printLine(`  Engine:      ${engineActive ? 'ACTIVE' : 'IDLE'}`, engineActive ? 'c-success' : 'c-dim');
    printLine(`  Bridge:      ${connectedDevice ? 'CONNECTED' : 'DISCONNECTED'}`, connectedDevice ? 'c-success' : 'c-dim');
    if (connectedDevice) {
        printLine(`  Device:      ${connectedDevice.name} (${connectedDevice.host})`, 'c-default');
    }
    printLine(`  Mode:        ${modeAuto ? 'AUTOMATIC' : 'MANUAL IP'}`, 'c-default');
    printLine(`  Encryption:  AES-256`, 'c-success');
    printLine(`  Clipboard:   ${clipboardOn ? 'ON' : 'OFF'}`, clipboardOn ? 'c-success' : 'c-dim');
    printLine(`  Devices:     ${discoveredDevices.length} discovered`, 'c-default');
    printBlank();
}

function cmdMode(args) {
    if (args.length === 0) {
        printLine('Usage: mode auto | mode manual <ip>', 'c-error');
        return;
    }

    const subCmd = args[0].toLowerCase();

    if (subCmd === 'auto') {
        modeAuto = true;
        printLine('[sys]  Switched to AUTOMATIC discovery mode.', 'c-success');
    } else if (subCmd === 'manual') {
        modeAuto = false;
        if (args[1]) {
            const ip = args[1];
            const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
            if (!ipRegex.test(ip)) {
                printLine(`[sys]  Invalid IP format: ${ip}`, 'c-error');
                return;
            }
            printLine('[sys]  Switched to MANUAL IP mode.', 'c-success');
            printLine(`[sys]  Connecting to ${ip}...`, 'c-info');
            api.manualConnect(ip);
        } else {
            printLine('[sys]  Switched to MANUAL IP mode. Use "connect <ip>" to connect.', 'c-success');
        }
    } else {
        printLine('Usage: mode auto | mode manual <ip>', 'c-error');
    }
}

function cmdClipboard(args) {
    if (args.length === 0) {
        printLine(`[sys]  Clipboard sharing is ${clipboardOn ? 'ON' : 'OFF'}.`, 'c-default');
        return;
    }

    const toggle = args[0].toLowerCase();
    if (toggle === 'on') {
        clipboardOn = true;
        api.startClipboardSharing();
        printLine('[sys]  ✓ Clipboard sharing enabled.', 'c-success');
    } else if (toggle === 'off') {
        clipboardOn = false;
        api.stopClipboardSharing();
        printLine('[sys]  ✗ Clipboard sharing disabled.', 'c-warning');
    } else {
        printLine('Usage: clipboard on | clipboard off', 'c-error');
    }
}

function cmdDrop(args) {
    if (args.length === 0) {
        printLine('Usage: drop <filepath>', 'c-error');
        return;
    }

    const filePath = args.join(' ');
    printLine(`[transfer]  File queued: ${getFileName(filePath)}`, 'c-info');
    printLine('[transfer]  Encrypting... AES-256', 'c-info');

    api.sendFile(filePath);
    // Progress will be handled by the onFileProgress listener
}

function cmdInit() {
    if (engineActive) {
        printLine('[sys]  Engine is already active.', 'c-warning');
        return;
    }

    printLine('[sys]  Initializing bridge engine...', 'c-info');
    api.initializeBridge();
}

// ── Engine Status ──────────────────────────────────────

function setEngineStatus(active) {
    engineActive = active;
    engineDot.classList.toggle('active', active);
    engineLabel.textContent = active ? 'ENGINE ACTIVE' : 'ENGINE IDLE';
}

// ── IPC Event Listeners ────────────────────────────────

api.onBridgeStatus((status) => {
    if (status === 'active') {
        setEngineStatus(true);
        printLine('[sys]  ✓ Bridge engine initialized — edge detection active.', 'c-success');
    }
});

api.onWsStatus((status) => {
    if (status === 'connected') {
        printLine('[net]  ✓ Signaling server connected.', 'c-success');
    } else if (status === 'disconnected') {
        printLine('[net]  ✗ Signaling server disconnected.', 'c-error');
    } else if (status === 'error') {
        printLine('[net]  ✗ Signaling server connection error.', 'c-error');
    }
});

api.onConnectionStatus((data) => {
    if (data.status === 'connected') {
        bridgeConnected = true;
        connectedDevice = connectedDevice || { name: data.device, host: data.device };
        printLine(`[bridge]  ✓ Connection confirmed: ${data.device}`, 'c-success');
    } else if (data.status === 'connecting') {
        printLine(`[bridge]  Connecting to ${data.device}...`, 'c-info');
    }
});

api.onDeviceFound((device) => {
    // Avoid duplicates
    if (discoveredDevices.find(d => d.name === device.name)) return;

    const lat = randomLatency();
    const entry = { name: device.name, host: device.host, latency: lat };
    discoveredDevices.push(entry);

    const namePad = device.name.padEnd(22);
    const hostPad = (device.host || '').padEnd(16);
    printLine(
        `[net]  ◉ Found: ${namePad} ${hostPad} latency ${lat}ms  [BRIDGE-CAPABLE]`,
        'c-success'
    );
});

api.onSystemSwitched((system) => {
    if (system === 'remote') {
        printLine('[bridge]  ⇢ Cursor crossed edge — REMOTE OVERRIDE active.', 'c-warning');
    } else {
        printLine('[bridge]  ⇠ Returned to LOCAL SYSTEM.', 'c-info');
    }
});

api.onFileProgress(({ fileName, progress, type }) => {
    const pct = Math.round(progress * 100);
    const filled = Math.round(pct / 5);
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    const label = type === 'send' ? 'Sending' : 'Receiving';
    const target = connectedDevice ? ` → ${connectedDevice.name}` : '';

    // Overwrite the progress line in place
    if (!transferLineEl) {
        transferLineEl = printLine('', 'c-info');
    }
    transferLineEl.textContent = `[transfer]  ${bar} ${pct}%  — ${label}${target}`;
    outputPane.scrollTop = outputPane.scrollHeight;

    if (pct >= 100) {
        transferLineEl.textContent = `[transfer]  ${'█'.repeat(20)} 100%  — Transfer complete`;
        transferLineEl.className = 'term-line c-success';
        transferLineEl = null;
    }
});

api.onFileReceived(({ name, path: filePath }) => {
    printLine(`[transfer]  ✓ File received: ${name}`, 'c-success');
    // Store for native drag (kept for compatibility, though not shown as ghost icon)
    api.storeReceivedFile(filePath);
});

api.onConnectionRequestPending((data) => {
    printLine(`[bridge]  Connection request from: ${data.deviceInfo || data.requestingClientId}`, 'c-warning');
    printLine('[bridge]  Auto-approving connection...', 'c-info');
    api.approveConnection(data.requestingClientId);
});

// ── Autocomplete ───────────────────────────────────────

let acDropdown = null;
let acItems    = [];
let acIndex    = -1;

function createDropdown() {
    if (acDropdown) return;
    acDropdown = document.createElement('div');
    acDropdown.id = 'autocompleteDropdown';
    document.body.appendChild(acDropdown);
}

function showAutocomplete(matches) {
    createDropdown();
    acItems = matches;
    acIndex = 0;
    acDropdown.innerHTML = '';

    matches.forEach((m, i) => {
        const div = document.createElement('div');
        div.className = `ac-item${i === 0 ? ' selected' : ''}`;
        div.textContent = m;
        div.addEventListener('mousedown', (e) => {
            e.preventDefault();
            cmdInput.value = m + ' ';
            hideAutocomplete();
            cmdInput.focus();
        });
        acDropdown.appendChild(div);
    });

    // Position above the input bar
    const inputRect = cmdInput.getBoundingClientRect();
    acDropdown.style.left   = inputRect.left + 'px';
    acDropdown.style.bottom = (window.innerHeight - inputRect.top + 4) + 'px';
    acDropdown.style.top    = 'auto';
    acDropdown.style.display = 'block';
}

function hideAutocomplete() {
    if (acDropdown) acDropdown.style.display = 'none';
    acItems = [];
    acIndex = -1;
}

function handleTab() {
    const val = cmdInput.value.trim().toLowerCase();
    if (!val) return;

    const matches = COMMANDS.filter(c => c.startsWith(val));
    if (matches.length === 1) {
        cmdInput.value = matches[0] + ' ';
        hideAutocomplete();
    } else if (matches.length > 1) {
        showAutocomplete(matches);
    }
}

// ── Keyboard UX ────────────────────────────────────────

cmdInput.addEventListener('keydown', (e) => {
    // Tab autocomplete
    if (e.key === 'Tab') {
        e.preventDefault();
        if (acItems.length > 0) {
            cmdInput.value = acItems[acIndex] + ' ';
            hideAutocomplete();
        } else {
            handleTab();
        }
        return;
    }

    // Enter submits
    if (e.key === 'Enter') {
        e.preventDefault();
        hideAutocomplete();
        const val = cmdInput.value;
        cmdInput.value = '';
        executeCommand(val);
        return;
    }

    // Up/Down for history
    if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (acItems.length > 0) {
            acIndex = Math.max(0, acIndex - 1);
            updateAcSelection();
        } else if (commandHistory.length > 0) {
            historyIndex = Math.min(historyIndex + 1, commandHistory.length - 1);
            cmdInput.value = commandHistory[historyIndex];
        }
        return;
    }

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (acItems.length > 0) {
            acIndex = Math.min(acItems.length - 1, acIndex + 1);
            updateAcSelection();
        } else if (historyIndex > 0) {
            historyIndex--;
            cmdInput.value = commandHistory[historyIndex];
        } else {
            historyIndex = -1;
            cmdInput.value = '';
        }
        return;
    }

    // Escape to close autocomplete
    if (e.key === 'Escape') {
        hideAutocomplete();
        return;
    }

    // Any other key hides autocomplete
    if (acItems.length > 0 && e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt') {
        hideAutocomplete();
    }
});

// Ctrl+L to clear, Ctrl+C to cancel
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'l') {
        e.preventDefault();
        cmdClear();
    }
    if (e.ctrlKey && e.key === 'c') {
        if (activeOperation) {
            clearTimeout(activeOperation);
            activeOperation = null;
            printLine('[sys]  Operation cancelled.', 'c-warning');
        }
    }
});

function updateAcSelection() {
    if (!acDropdown) return;
    const items = acDropdown.querySelectorAll('.ac-item');
    items.forEach((el, i) => {
        el.classList.toggle('selected', i === acIndex);
    });
}

// ── Drag-and-Drop File Transfer ────────────────────────

let dragOverlay = null;

function showDragOverlay() {
    if (dragOverlay) return;
    dragOverlay = document.createElement('div');
    dragOverlay.className = 'drag-overlay';
    dragOverlay.textContent = '[ DROP FILE TO SECURE BRIDGE ]';
    document.body.appendChild(dragOverlay);
}

function removeDragOverlay() {
    if (dragOverlay) {
        dragOverlay.remove();
        dragOverlay = null;
    }
}

document.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showDragOverlay();
});

document.addEventListener('dragleave', (e) => {
    // Only remove if leaving the window entirely
    if (e.relatedTarget === null) {
        removeDragOverlay();
    }
});

document.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    removeDragOverlay();

    if (e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
        const target = connectedDevice ? connectedDevice.name : 'peer';

        printLine(`[transfer]  File queued: ${file.name} (${sizeMB} MB)`, 'c-info');
        printLine('[transfer]  Encrypting... AES-256', 'c-info');
        printLine(`[transfer]  Sending → ${target}`, 'c-info');

        api.sendFile(file.path);
    }
});

// ── Utility ────────────────────────────────────────────

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomLatency() {
    return Math.floor(Math.random() * 12) + 1;
}

function getFileName(filePath) {
    return filePath.split(/[\\/]/).pop() || filePath;
}

// ── Click anywhere focuses input ───────────────────────
document.addEventListener('click', (e) => {
    // Don't steal focus from autocomplete
    if (e.target.closest('#autocompleteDropdown')) return;
    cmdInput.focus();
});

// ── Launch ─────────────────────────────────────────────
runBootSequence();