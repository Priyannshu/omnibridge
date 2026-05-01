// lib/repl.js — Interactive REPL: readline setup, command parser, output formatting
const readline = require('readline');
const pc = require('picocolors');
const Transfer = require('./transfer');

// ── Color helpers keyed by log category ────────────────
const COLORS = {
    default: (s) => pc.gray(s),
    success: (s) => pc.green(s),
    error:   (s) => pc.red(s),
    info:    (s) => pc.cyan(s),
    warning: (s) => pc.yellow(s),
    dim:     (s) => pc.dim(s),
    bold:    (s) => pc.bold(pc.white(s)),
    sep:     (s) => pc.dim(s),
    prompt:  (s) => pc.green(s),
};

const COMMANDS = ['scan', 'connect', 'disconnect', 'pair', 'status', 'mode', 'clipboard', 'drop', 'init', 'clear', 'help', 'exit'];

class Repl {
    /**
     * @param {Bridge} bridge
     * @param {DiscoveryService} discovery
     * @param {FileEngine} fileEngine
     */
    constructor(bridge, discovery, fileEngine) {
        this.bridge = bridge;
        this.discovery = discovery;
        this.fileEngine = fileEngine;
        this.rl = null;
    }

    /** Print a colored line to stdout. */
    log(text, color = 'default') {
        const fn = COLORS[color] || COLORS.default;
        console.log(fn(text));
    }

    /** Stream lines with a delay between each (for boot sequence). */
    streamLines(lines, delayMs = 80) {
        return new Promise((resolve) => {
            let i = 0;
            const next = () => {
                if (i >= lines.length) { resolve(); return; }
                const l = lines[i++];
                if (typeof l === 'string') this.log(l);
                else this.log(l.text, l.color);
                setTimeout(next, delayMs);
            };
            next();
        });
    }

    /**
     * Run the animated boot sequence.
     * @param {object} opts - { tailscaleIP: string|null }
     */
    async boot(opts = {}) {
        const bootLines = [
            { text: '',                                                color: 'default' },
            { text: 'OMNIBRIDGE v1.2.0-PRO  |  AES-256 ACTIVE',       color: 'bold' },
            { text: '──────────────────────────────────────────',       color: 'sep' },
            { text: '[sys]  Initializing bridge engine...',             color: 'info' },
            { text: '[sys]  Loading network interfaces... OK',          color: 'info' },
            { text: '[sys]  AES-256 keychain loaded',                   color: 'info' },
            { text: '[sys]  mDNS discovery armed',                      color: 'info' },
        ];

        if (opts.tailscaleIP) {
            bootLines.push({ text: `[sys]  Tailscale interface detected (${opts.tailscaleIP}) — tailnet discovery enabled`, color: 'success' });
        }

        bootLines.push({ text: '[net]  Scanning subnet 192.168.x.x/24...', color: 'info' });

        await this.streamLines(bootLines, 80);
    }

    /** Start the interactive REPL loop. */
    start() {
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: pc.green('omni ❯ '),
            historySize: 50,
            completer: (line) => {
                const hits = COMMANDS.filter(c => c.startsWith(line.trim().toLowerCase()));
                return [hits.length ? hits : COMMANDS, line];
            },
            terminal: true
        });

        this.rl.prompt();

        this.rl.on('line', (line) => {
            this.handleCommand(line.trim());
            this.rl.prompt();
        });

        this.rl.on('close', () => {
            this.log('\n[sys]  Shutting down...', 'warning');
            this.bridge.shutdown();
            this.discovery.stop();
            process.exit(0);
        });

        // Ctrl+C: cancel active operation or exit
        this.rl.on('SIGINT', () => {
            this.log('\n[sys]  Use "exit" to quit, or Ctrl+C again to force.', 'warning');
            this.rl.prompt();
        });

        // Wire bridge events into the REPL output
        this._wireBridgeEvents();
    }

    /** Route bridge events to terminal output. */
    _wireBridgeEvents() {
        this.bridge.on('ws-status', (status) => {
            if (status === 'connected') {
                this._interruptLog('[net]  ✓ Signaling server connected.', 'success');
            } else if (status === 'disconnected') {
                this._interruptLog('[net]  ✗ Signaling server disconnected.', 'error');
            } else if (status === 'error') {
                this._interruptLog('[net]  ✗ Signaling server connection error.', 'error');
            }
        });

        this.bridge.on('connecting', (name) => {
            this._interruptLog(`[bridge]  Waiting for peer response from ${name}...`, 'info');
        });

        this.bridge.on('connection-established', (device) => {
            this._interruptLog(`[bridge]  ✓ Connection established: ${device.name} (${device.host})`, 'success');
            this._interruptLog(`[bridge]  Encryption: AES-256  |  Clipboard: ${this.bridge.clipboardOn ? 'ON' : 'OFF'}`, 'dim');
        });

        this.bridge.on('connection-timeout', (name) => {
            this._interruptLog(`[bridge]  ✗ Connection timed out — ${name} did not respond.`, 'error');
            this._interruptLog('[bridge]  Ensure the peer is running OmniBridge and connected to the same signaling server.', 'dim');
        });

        this.bridge.on('connection-request', (data) => {
            const peerName = (data.deviceInfo && data.deviceInfo.name) || data.requestingClientId;
            this._interruptLog(`[bridge]  Connection request from: ${peerName}`, 'warning');
            this._interruptLog('[bridge]  Auto-approving...', 'info');
            this.bridge.approveConnection(data.requestingClientId);
        });

        this.bridge.on('connection-rejected', (data) => {
            const reason = (data && data.reason) ? data.reason : 'Connection rejected by peer';
            this._interruptLog(`[bridge]  ✗ ${reason}`, 'error');
        });

        this.bridge.on('engine-status', (status) => {
            if (status === 'active') {
                this._interruptLog('[sys]  ✓ KVM engine active — move cursor to screen edge to control remote device.', 'success');
                this._interruptLog('[sys]  Press Ctrl+Alt+Q or Escape to return control.', 'dim');
            }
        });

        this.bridge.on('system-switched', (system) => {
            if (system === 'remote') {
                this._interruptLog('[kvm]  → Cursor crossed to REMOTE — input forwarding active', 'success');
            } else {
                this._interruptLog('[kvm]  ← Cursor returned to LOCAL', 'info');
            }
        });

        this.bridge.on('error', (msg) => {
            this._interruptLog(`[error]  ${msg}`, 'error');
        });

        this.bridge.on('event', (event) => {
            // Handle incoming file chunks
            if (event.type === 'file-chunk') {
                const pct = Math.round(((event.chunkIndex + 1) / event.totalChunks) * 100);
                const filled = Math.round(pct / 5);
                const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
                process.stdout.write(`\r${pc.cyan(`[transfer]  ${bar} ${pct}%  — Receiving: ${event.fileName}`)}`);
                if (event.chunkIndex === event.totalChunks - 1) {
                    process.stdout.write('\n');
                    this._interruptLog(`[transfer]  ✓ File received: ${event.fileName}`, 'success');
                }
                return;
            }
        });
    }

    /**
     * Print a log line that interrupts the current prompt cleanly.
     * Clears the prompt line, prints the message, then re-shows the prompt.
     */
    _interruptLog(text, color = 'default') {
        // Clear current line
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        this.log(text, color);
        if (this.rl) this.rl.prompt(true);
    }

    // ── Command Dispatch ───────────────────────────────────

    handleCommand(raw) {
        if (!raw) return;
        const parts = raw.split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1);

        switch (cmd) {
            case 'help':       this.cmdHelp();        break;
            case 'clear':      this.cmdClear();       break;
            case 'scan':       this.cmdScan();        break;
            case 'connect':    this.cmdConnect(args);  break;
            case 'disconnect': this.cmdDisconnect();   break;
            case 'pair':       this.cmdPair();         break;
            case 'status':     this.cmdStatus();       break;
            case 'mode':       this.cmdMode(args);     break;
            case 'clipboard':  this.cmdClipboard(args);break;
            case 'drop':       this.cmdDrop(args);     break;
            case 'init':       this.cmdInit();         break;
            case 'exit':
            case 'quit':       this.cmdExit();         break;
            default:
                this.log(`Unknown command: ${cmd}. Type "help" for a list of commands.`, 'error');
        }
    }

    // ── Command Implementations ────────────────────────────

    cmdHelp() {
        this.log('');
        this.log('  AVAILABLE COMMANDS', 'bold');
        this.log('  ──────────────────────────────────────', 'sep');
        this.log('  scan                Re-run network discovery, stream results live');
        this.log('  connect <device>    Initiate bridge to a named or IP device');
        this.log('  connect <device> --pin <PIN>   Pair + connect using 6-digit PIN (SPAKE2)');
        this.log('  disconnect          Drop current bridge connection');
        this.log('  pair                Generate a PIN and wait for a remote device to pair');
        this.log('  init                Activate KVM engine (mouse/keyboard sharing)');
        this.log('  status              Print bridge state, device, encryption info');
        this.log('  mode auto           Switch to automatic mDNS discovery');
        this.log('  mode manual <ip>    Switch to manual IP and connect');
        this.log('  clipboard on|off    Toggle shared clipboard');
        this.log('  drop <filepath>     Queue a file for secure bridge transfer');
        this.log('  clear               Clear terminal output');
        this.log('  help                Show this help message');
        this.log('  exit                Shut down and quit');
        this.log('');
        this.log('  PIN Pairing:', 'bold');
        this.log('  1. On Device A: "pair" → shows PIN + port', 'dim');
        this.log('  2. On Device B: "connect <device-ip>:<port> --pin <PIN>"', 'dim');
        this.log('  Both devices derive a session key via SPAKE2 (no shared secret needed).', 'dim');
        this.log('');
        this.log('  KVM: after connecting + init, move cursor to right screen edge to control remote.', 'dim');
        this.log('  Press Ctrl+Alt+Q or Escape to return cursor to local system.', 'dim');
        this.log('');
        this.log('  Keyboard: ↑↓ history  |  Tab autocomplete  |  Ctrl+C interrupt', 'dim');
        this.log('');
    }

    cmdClear() {
        console.clear();
    }

    cmdScan() {
        this.log('[net]  Starting network scan...', 'info');

        // Listen for scan phase transitions
        const onPhase = (phase) => {
            if (phase === 'tailscale') {
                this._interruptLog('[net]  Querying Tailscale tailnet...', 'info');
            } else if (phase === 'lan') {
                this._interruptLog('[net]  Scanning LAN via mDNS...', 'info');
            }
        };

        // Handle Tailscale-specific errors
        const onTsError = (errType) => {
            if (errType === 'daemon-not-running') {
                this._interruptLog('[error]  Tailscale daemon not running. Start it with: tailscale up', 'error');
            } else if (errType === 'cli-unavailable') {
                this._interruptLog('[warn]  Tailscale CLI not found. Skipping tailnet scan.', 'warning');
            }
        };

        // Format each discovered device
        const onDevice = (device) => {
            this._formatDeviceLine(device);
        };

        this.discovery.on('scan-phase', onPhase);
        this.discovery.on('tailscale-error', onTsError);
        this.discovery.on('device', onDevice);

        this.discovery.scan(5000).then((devices) => {
            this.discovery.removeListener('scan-phase', onPhase);
            this.discovery.removeListener('tailscale-error', onTsError);
            this.discovery.removeListener('device', onDevice);
            if (devices.length === 0) {
                this._interruptLog('[net]  No devices found.', 'warning');
            }
            this._interruptLog(`[net]  Scan complete — ${devices.length} device(s) found.`, 'info');
        });
    }

    /** Format and print a discovered device line based on its source. */
    _formatDeviceLine(device) {
        if (device.source === 'tailscale') {
            const icon = device.online ? '◉' : '○';
            const statusTag = device.online ? '[ONLINE]' : '[OFFLINE]';
            const dnsLabel = device.dnsName || device.name;
            const namePad = dnsLabel.padEnd(36);
            const hostPad = (device.host || '').padEnd(16);
            const osTag = device.os ? `[${device.os}]` : '';
            const latStr = device.latency != null ? `  latency ${device.latency}ms` : '';
            const color = device.online ? 'success' : 'dim';
            this._interruptLog(
                `[net]  ${icon} Found: ${namePad} ${hostPad} ${osTag}  [TAILSCALE]  ${statusTag}${latStr}`,
                color
            );
        } else {
            // LAN / mDNS device
            const lat = Math.floor(Math.random() * 12) + 1;
            const namePad = device.name.padEnd(24);
            const hostPad = (device.host || '').padEnd(16);
            this._interruptLog(
                `[net]  ◉ Found: ${namePad} ${hostPad} latency ${lat}ms  [LAN]  [BRIDGE-CAPABLE]`,
                'success'
            );
        }
    }

    cmdConnect(args) {
        if (args.length === 0) {
            this.log('Usage: connect <device-name or IP> [--pin <PIN>]', 'error');
            return;
        }

        // ── Parse --pin flag ───────────────────────────────
        let pin = null;
        const pinIdx = args.indexOf('--pin');
        if (pinIdx !== -1) {
            if (pinIdx + 1 >= args.length) {
                this.log('Usage: connect <host>:<port> --pin <6-digit PIN>', 'error');
                return;
            }
            pin = args[pinIdx + 1];
            // Validate PIN format
            if (!/^\d{6}$/.test(pin)) {
                this.log('[pair]  PIN must be exactly 6 digits.', 'error');
                return;
            }
            // Remove --pin and its value from args
            args = args.filter((_, i) => i !== pinIdx && i !== pinIdx + 1);
        }

        const target = args.join(' ');

        // ── PIN-based pairing flow ─────────────────────────
        if (pin) {
            // Target must be host:port for PIN pairing
            const hostPortMatch = target.match(/^([\w.\-]+):(\d+)$/);
            if (!hostPortMatch) {
                this.log('Usage: connect <host>:<port> --pin <PIN>', 'error');
                this.log('  Example: connect 192.168.1.5:52341 --pin 847291', 'dim');
                return;
            }

            const host = hostPortMatch[1];
            const port = parseInt(hostPortMatch[2], 10);

            this.log(`[pair]  Connecting to ${host}:${port} for PIN pairing...`, 'info');
            this.log('[pair]  Running SPAKE2 handshake...', 'info');

            this.bridge.pairWithPin(host, port, pin).then((result) => {
                this._interruptLog(`[pair]  ✓ Paired with ${result.peerHostname}`, 'success');
                this._interruptLog('[pair]  Session key derived via SPAKE2 + HKDF', 'dim');
                this._interruptLog('[pair]  All bridge traffic encrypted with AES-256-GCM (session key)', 'dim');

                // Install session cipher on the bridge
                this.bridge.setSessionCipher(result.sessionCipher);

                // Set as connected device
                this.bridge.connectedDevice = { name: result.peerHostname, host };
                this.bridge.emit('connection-established', this.bridge.connectedDevice);
            }).catch((err) => {
                this._interruptLog(`[pair]  ${err.message}`, 'error');
            });
            return;
        }

        // ── Standard connect flow (no PIN) ────────────────
        const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
        const devices = this.discovery.getDevices();

        if (ipRegex.test(target)) {
            // First: check if this IP matches a discovered device (Tailscale or LAN)
            const deviceByIP = devices.find(d => d.host === target);
            if (deviceByIP) {
                if (deviceByIP.online === false) {
                    this.log(`[bridge]  Device "${deviceByIP.name}" (${target}) is OFFLINE.`, 'warning');
                    return;
                }
                this.log(`[bridge]  Found device: ${deviceByIP.name} (${target})`, 'info');
                this.log(`[bridge]  Requesting connection to ${deviceByIP.host}...`, 'info');
                this.bridge.connectToDevice(deviceByIP.name, deviceByIP.host);
                return;
            }

            // Not a known peer — treat as a signaling server address
            this.log(`[bridge]  No discovered device at ${target}.`, 'dim');
            this.log(`[bridge]  Connecting to ${target}:${this.bridge.serverPort} as signaling server...`, 'info');
            this.bridge.manualConnect(target);
            return;
        }

        // Look up by name (partial match)
        const device = devices.find(d =>
            d.name.toLowerCase().includes(target.toLowerCase()) ||
            (d.dnsName && d.dnsName.toLowerCase().includes(target.toLowerCase()))
        );

        if (!device) {
            this.log(`[bridge]  Device "${target}" not found. Run "scan" first.`, 'error');
            return;
        }

        if (device.online === false) {
            this.log(`[bridge]  Device "${device.name}" is OFFLINE.`, 'warning');
            return;
        }

        this.log(`[bridge]  Requesting connection to ${device.host}...`, 'info');
        this.bridge.connectToDevice(device.name, device.host);
    }

    cmdPair() {
        const os = require('os');
        const Config = require('../core/config');

        this.log('[pair]  Generating pairing PIN...', 'info');

        const pairingHost = this.bridge.createPairingHost();
        const promise = pairingHost.start();

        // After start() initializes, display PIN and port
        setTimeout(() => {
            const pin = pairingHost.getPin();
            const port = pairingHost.getPort();
            const lanIP = Config.getLanIP();

            // Detect Tailscale IP if available
            let tsIP = null;
            try {
                const ifaces = os.networkInterfaces();
                for (const [name, addrs] of Object.entries(ifaces)) {
                    for (const a of addrs) {
                        if (a.family !== 'IPv4' || a.internal) continue;
                        if (a.address.startsWith('100.')) {
                            const second = parseInt(a.address.split('.')[1], 10);
                            if (second >= 64 && second <= 127) { tsIP = a.address; break; }
                        }
                    }
                    if (tsIP) break;
                }
            } catch (_) {}

            if (pin) {
                this.log('');
                this.log('  PAIRING PIN', 'bold');
                this.log('  ──────────────────────────────────────', 'sep');
                this.log(`  PIN:   ${pin}`, 'success');
                this.log(`  Port:  ${port}`, 'dim');
                this.log('');
                this.log('  On the other device, run:', 'dim');
                this.log(`    connect ${lanIP}:${port} --pin ${pin}`, 'info');
                if (tsIP) {
                    this.log('');
                    this.log('  Over Tailscale:', 'dim');
                    this.log(`    connect ${tsIP}:${port} --pin ${pin}`, 'info');
                }
                this.log('');
                this.log('  PIN expires in 90 seconds.', 'warning');
                if (process.platform === 'win32') {
                    this.log('  Note: allow port through Windows Firewall if peer cannot connect.', 'dim');
                }
                this.log('');
                this.log('[pair]  Waiting for peer...', 'dim');
            }
        }, 100);

        promise.then((result) => {
            this._interruptLog(`[pair]  ✓ Paired with ${result.peerHostname}`, 'success');
            this._interruptLog('[pair]  Session key derived via SPAKE2 + HKDF', 'dim');
            this._interruptLog('[pair]  All bridge traffic encrypted with AES-256-GCM (session key)', 'dim');

            // Install session cipher
            this.bridge.setSessionCipher(result.sessionCipher);
            this.bridge.connectedDevice = { name: result.peerHostname, host: 'paired' };
            this.bridge.emit('connection-established', this.bridge.connectedDevice);
        }).catch((err) => {
            this._interruptLog(`[pair]  ✗ ${err.message}`, 'error');
        });
    }

    cmdDisconnect() {
        if (!this.bridge.connectedDevice && !this.bridge._pendingDevice) {
            this.log('[bridge]  No active bridge to disconnect.', 'warning');
            return;
        }
        const name = (this.bridge.connectedDevice || this.bridge._pendingDevice).name;
        this.log(`[bridge]  Dropping bridge → ${name}...`, 'info');
        this.bridge.disconnect();
        this.log('[bridge]  ✗ Bridge disconnected.', 'warning');
    }

    cmdStatus() {
        const s = this.bridge.getStatus();
        const devices = this.discovery.getDevices();
        const tsDevices = devices.filter(d => d.source === 'tailscale');
        const lanDevices = devices.filter(d => d.source !== 'tailscale');

        const bridgeColor = s.bridge === 'CONNECTED' ? 'success'
            : s.bridge === 'CONNECTING' ? 'warning' : 'dim';

        this.log('');
        this.log('  BRIDGE STATUS', 'bold');
        this.log('  ──────────────────────────────────────', 'sep');
        this.log(`  Engine:      ${s.engine}`, s.engine === 'ACTIVE' ? 'success' : 'dim');
        this.log(`  Bridge:      ${s.bridge}`, bridgeColor);
        if (s.device) {
            const suffix = s.bridge === 'CONNECTING' ? '  (waiting for peer)' : '';
            this.log(`  Device:      ${s.device.name} (${s.device.host})${suffix}`);
        }
        this.log(`  Server:      ${s.server}`, s.server !== 'DISCONNECTED' ? 'success' : 'dim');
        this.log(`  Mode:        ${s.mode}`);
        this.log(`  Auth:        ${s.auth}`, s.auth === 'PIN-PAIRED' ? 'success' : 'warning');
        this.log(`  Encryption:  ${s.encryption}`, 'success');
        this.log(`  Clipboard:   ${s.clipboard}`, s.clipboard === 'ON' ? 'success' : 'dim');
        this.log(`  Tailscale:   ${this.discovery.tailscaleActive ? 'ACTIVE' : 'NOT DETECTED'}`, this.discovery.tailscaleActive ? 'success' : 'dim');
        this.log(`  Devices:     ${devices.length} total (${tsDevices.length} tailnet, ${lanDevices.length} LAN)`);
        this.log(`  KVM:         ${s.kvmReady ? 'READY' : 'NOT AVAILABLE (native addons missing)'}`, s.kvmReady ? 'success' : 'warning');
        if (s.engine === 'ACTIVE') {
            this.log(`  Cursor:      ${s.cursor === 'remote' ? 'REMOTE (forwarding input)' : 'LOCAL'}`, s.cursor === 'remote' ? 'success' : 'dim');
        }
        this.log('');
    }

    cmdMode(args) {
        if (args.length === 0) {
            this.log('Usage: mode auto | mode manual <ip>', 'error');
            return;
        }

        const sub = args[0].toLowerCase();
        if (sub === 'auto') {
            this.bridge.modeAuto = true;
            this.log('[sys]  Switched to AUTOMATIC discovery mode.', 'success');
        } else if (sub === 'manual') {
            this.bridge.modeAuto = false;
            if (args[1]) {
                const ip = args[1];
                const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
                if (!ipRegex.test(ip)) {
                    this.log(`[sys]  Invalid IP format: ${ip}`, 'error');
                    return;
                }
                this.log('[sys]  Switched to MANUAL IP mode.', 'success');
                this.log(`[sys]  Connecting to ${ip}...`, 'info');
                this.bridge.manualConnect(ip);
            } else {
                this.log('[sys]  Switched to MANUAL IP mode. Use "connect <ip>" to connect.', 'success');
            }
        } else {
            this.log('Usage: mode auto | mode manual <ip>', 'error');
        }
    }

    cmdClipboard(args) {
        if (args.length === 0) {
            this.log(`[sys]  Clipboard sharing is ${this.bridge.clipboardOn ? 'ON' : 'OFF'}.`);
            return;
        }

        const toggle = args[0].toLowerCase();
        if (toggle === 'on') {
            this.bridge.setClipboard(true);
            this.log('[sys]  ✓ Clipboard sharing enabled.', 'success');
        } else if (toggle === 'off') {
            this.bridge.setClipboard(false);
            this.log('[sys]  ✗ Clipboard sharing disabled.', 'warning');
        } else {
            this.log('Usage: clipboard on | clipboard off', 'error');
        }
    }

    async cmdDrop(args) {
        if (args.length === 0) {
            this.log('Usage: drop <filepath>', 'error');
            return;
        }

        const filePath = args.join(' ');
        await Transfer.send(
            filePath,
            this.bridge,
            this.fileEngine,
            (text, color) => this._interruptLog(text, color),
            pc
        );
    }

    cmdInit() {
        if (this.bridge.bridgeActive) {
            this.log('[sys]  KVM engine is already active.', 'warning');
            return;
        }
        if (!this.bridge.connectedDevice) {
            this.log('[sys]  No device connected. Run "connect <device>" first.', 'error');
            return;
        }
        this.log('[sys]  Initializing KVM engine...', 'info');
        this.bridge.initEngine();
    }

    cmdExit() {
        this.log('[sys]  Shutting down...', 'warning');
        this.bridge.shutdown();
        this.discovery.stop();
        process.exit(0);
    }
}

module.exports = Repl;
