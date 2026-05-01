// lib/discovery.js — Network discovery: mDNS/Bonjour + Tailscale tailnet
// Tries Tailscale CLI → Tailscale LocalAPI → mDNS, merges results.
const EventEmitter = require('events');
const os = require('os');
const net = require('net');
const { execFile } = require('child_process');
const { Bonjour } = require('bonjour-service');
const createLogger = require('../core/loggerFactory');

const logger = createLogger({ appName: 'Omnibridge-Discovery' });

class DiscoveryService extends EventEmitter {
    constructor() {
        super();
        this.bonjour = new Bonjour();
        this.serviceType = 'omnibridge-signal';
        this.browser = null;
        this.knownDevices = new Map();  // hostname → device object

        // Tailscale state — populated at boot by detectTailscale()
        this.tailscaleActive = false;
        this.selfHostname = os.hostname();
    }

    // ── Tailscale Interface Detection ──────────────────────

    /**
     * Check if a Tailscale interface exists on this machine.
     * Looks for an interface named "tailscale" or any IPv4 address in 100.64.0.0/10.
     * Returns the local Tailscale IP if found, null otherwise.
     */
    detectTailscale() {
        const ifaces = os.networkInterfaces();
        for (const [name, addrs] of Object.entries(ifaces)) {
            for (const a of addrs) {
                if (a.family !== 'IPv4' || a.internal) continue;
                // Tailscale uses CGNAT range 100.64.0.0/10 (100.64.x.x – 100.127.x.x)
                if (name.toLowerCase().includes('tailscale') || this._isTailscaleIP(a.address)) {
                    this.tailscaleActive = true;
                    logger.info('Tailscale interface detected', { name, ip: a.address });
                    return a.address;
                }
            }
        }
        return null;
    }

    /** Check if an IP falls within Tailscale's CGNAT range (100.64.0.0/10). */
    _isTailscaleIP(ip) {
        if (!ip.startsWith('100.')) return false;
        const second = parseInt(ip.split('.')[1], 10);
        return second >= 64 && second <= 127;
    }

    // ── Tailscale Discovery ────────────────────────────────

    /**
     * Discover Tailscale peers. Tries approaches in order:
     *   1. `tailscale status --json` CLI
     *   2. Tailscale LocalAPI via socket/named pipe
     * Emits 'device' for each peer found. Emits 'tailscale-error' on failure.
     * Returns array of discovered peer devices.
     */
    async discoverTailscale() {
        // Approach 1: CLI
        let status = await this._tailscaleCLI();

        // Approach 2: LocalAPI fallback
        if (!status) {
            status = await this._tailscaleLocalAPI();
        }

        if (!status) {
            this.emit('tailscale-error', 'cli-unavailable');
            return [];
        }

        // Check daemon state
        if (status.BackendState && status.BackendState !== 'Running') {
            this.emit('tailscale-error', 'daemon-not-running');
            return [];
        }

        return await this._parseTailscalePeers(status);
    }

    /**
     * Approach 1: Query `tailscale status --json` via child_process.execFile.
     * Returns parsed JSON or null on failure.
     */
    _tailscaleCLI() {
        return new Promise((resolve) => {
            // Determine binary name — tailscale.exe on Windows, tailscale elsewhere
            const bin = process.platform === 'win32' ? 'tailscale.exe' : 'tailscale';

            execFile(bin, ['status', '--json'], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
                if (err) {
                    logger.info('Tailscale CLI not available', { error: err.message });
                    resolve(null);
                    return;
                }
                try {
                    resolve(JSON.parse(stdout));
                } catch (parseErr) {
                    logger.warn('Failed to parse Tailscale CLI output', { error: parseErr.message });
                    resolve(null);
                }
            });
        });
    }

    /**
     * Approach 2: Query Tailscale LocalAPI daemon via Unix socket or Windows named pipe.
     * GET /localapi/v0/status
     */
    _tailscaleLocalAPI() {
        return new Promise((resolve) => {
            const http = require('http');

            let socketPath;
            if (process.platform === 'win32') {
                socketPath = '\\\\.\\pipe\\ProtectedPrefix\\Administrators\\Tailscale\\tailscaled';
            } else if (process.platform === 'darwin') {
                // macOS: varies by install method
                const candidates = [
                    '/var/run/tailscale/tailscaled.sock',
                    `${os.homedir()}/Library/Group Containers/io.tailscale.ipn.macos/tailscaled.sock`
                ];
                const fs = require('fs');
                socketPath = candidates.find(p => fs.existsSync(p)) || candidates[0];
            } else {
                socketPath = '/var/run/tailscale/tailscaled.sock';
            }

            const options = {
                socketPath,
                path: '/localapi/v0/status',
                method: 'GET',
                timeout: 5000
            };

            const req = http.get(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (_) {
                        resolve(null);
                    }
                });
            });

            req.on('error', (err) => {
                logger.info('Tailscale LocalAPI not available', { error: err.message });
                resolve(null);
            });

            req.on('timeout', () => {
                req.destroy();
                resolve(null);
            });
        });
    }

    /**
     * Parse the Tailscale status JSON and emit 'device' events for each peer.
     * Also measures latency via TCP connect probe to each online peer.
     * Returns array of peer devices.
     */
    async _parseTailscalePeers(status) {
        const peers = status.Peer || {};
        const devices = [];

        for (const [_key, peer] of Object.entries(peers)) {
            // Extract the first IPv4 Tailscale IP
            const ipv4 = (peer.TailscaleIPs || []).find(ip => !ip.includes(':'));
            if (!ipv4) continue;

            // Skip self
            if (peer.HostName === this.selfHostname) continue;

            const dnsName = (peer.DNSName || '').replace(/\.$/, '');  // strip trailing dot
            const device = {
                name: peer.HostName,
                host: ipv4,
                dnsName,
                os: peer.OS || 'unknown',
                online: peer.Online === true,
                relay: peer.Relay || '',
                source: 'tailscale',
                latency: null
            };

            // Measure latency to online peers via TCP connect probe
            if (device.online) {
                device.latency = await this._measureLatency(ipv4);
            }

            devices.push(device);

            // Merge into knownDevices, dedup by hostname
            if (!this.knownDevices.has(device.name)) {
                this.knownDevices.set(device.name, device);
                this.emit('device', device);
            }
        }

        return devices;
    }

    /**
     * Measure TCP connect latency to a peer on port 41641 (Tailscale default).
     * Falls back to port 80. Returns latency in ms, or null on failure.
     */
    _measureLatency(ip, port = 41641, timeoutMs = 3000) {
        return new Promise((resolve) => {
            const start = Date.now();
            const sock = new net.Socket();

            sock.setTimeout(timeoutMs);

            sock.connect(port, ip, () => {
                const latency = Date.now() - start;
                sock.destroy();
                resolve(latency);
            });

            sock.on('error', () => {
                sock.destroy();
                resolve(null);
            });

            sock.on('timeout', () => {
                sock.destroy();
                resolve(null);
            });
        });
    }

    // ── LAN mDNS Discovery (existing) ─────────────────────

    /**
     * Find the signaling server on the LAN via mDNS.
     * Resolves with {host, port} or null after timeout.
     */
    findServer(timeoutMs = 3000) {
        return new Promise((resolve) => {
            let resolved = false;
            const done = (result) => {
                if (resolved) return;
                resolved = true;
                try { if (this.browser) this.browser.stop(); } catch (_) {}
                resolve(result);
            };

            try {
                this.browser = this.bonjour.find({ type: this.serviceType });
                this.browser.on('up', (service) => {
                    if (service.name.startsWith('omnibridge')) {
                        const host = service.referer?.address || service.host;
                        const port = service.port;
                        logger.info('Discovered signaling server via mDNS', { host, port });
                        done({ host, port });
                    }
                });
            } catch (e) {
                logger.warn('mDNS browse failed', { error: e.message });
                done(null);
                return;
            }

            setTimeout(() => {
                if (!resolved) {
                    logger.info('mDNS discovery timed out');
                    done(null);
                }
            }, timeoutMs);
        });
    }

    /**
     * mDNS LAN scan for omnibridge services.
     * Emits 'device' events. Stops after scanDurationMs.
     */
    scanLAN(scanDurationMs = 5000) {
        return new Promise((resolve) => {
            const lanDevices = [];
            try {
                const scanner = new Bonjour();
                const browser = scanner.find({ type: this.serviceType });

                browser.on('up', (service) => {
                    if (!service.name.startsWith('omnibridge')) return;
                    const name = service.name;

                    // Dedup against known devices
                    if (this.knownDevices.has(name)) return;

                    const device = {
                        name,
                        host: service.referer?.address || service.host,
                        port: service.port,
                        source: 'lan',
                        online: true,
                        latency: null
                    };
                    this.knownDevices.set(name, device);
                    lanDevices.push(device);
                    this.emit('device', device);
                });

                setTimeout(() => {
                    try { browser.stop(); scanner.destroy(); } catch (_) {}
                    resolve(lanDevices);
                }, scanDurationMs);
            } catch (e) {
                logger.error('LAN scan failed', { error: e.message });
                resolve([]);
            }
        });
    }

    // ── Unified Scan ───────────────────────────────────────

    /**
     * Run a full scan: Tailscale discovery (if active) + LAN mDNS.
     * Merges results, deduplicating by hostname.
     * Emits 'device' events as peers/services are found.
     * Emits 'scan-complete' with total device count when done.
     */
    async scan(scanDurationMs = 5000) {
        this.knownDevices.clear();
        let tailscaleDevices = [];

        // Run Tailscale discovery if interface is detected
        if (this.tailscaleActive) {
            this.emit('scan-phase', 'tailscale');
            tailscaleDevices = await this.discoverTailscale();
        }

        // Always also run LAN mDNS scan in parallel
        this.emit('scan-phase', 'lan');
        const lanDevices = await this.scanLAN(scanDurationMs);

        const allDevices = [...this.knownDevices.values()];
        this.emit('scan-complete', allDevices);
        return allDevices;
    }

    /** Return currently known devices. */
    getDevices() {
        return [...this.knownDevices.values()];
    }

    stop() {
        try {
            if (this.browser) { this.browser.stop(); this.browser = null; }
            this.bonjour.unpublishAll();
            this.bonjour.destroy();
        } catch (_) {}
    }
}

module.exports = DiscoveryService;
