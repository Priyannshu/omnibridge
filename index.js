#!/usr/bin/env node
// index.js — OmniBridge CLI entry point
// Boots the bridge engine, discovers the signaling server, and starts the interactive REPL.

// Signal to loggerFactory that the CLI REPL owns stdout — suppress console output
// from core module loggers so they don't corrupt the formatted terminal output.
global.__OMNIBRIDGE_CLI = true;

const DiscoveryService = require('./lib/discovery');
const Bridge = require('./lib/bridge');
const FileEngine = require('./core/fileEngine');
const Repl = require('./lib/repl');
const Config = require('./core/config');

async function main() {
    const config = new Config();
    const serverConfig = config.get().server;

    const discovery = new DiscoveryService();
    const bridge = new Bridge();
    const fileEngine = new FileEngine();
    const repl = new Repl(bridge, discovery, fileEngine);

    // ── Detect Tailscale interface before boot ─────────────
    const tailscaleIP = discovery.detectTailscale();

    // ── Boot sequence (animated, shows Tailscale status) ───
    await repl.boot({ tailscaleIP });

    // ── Discover signaling server via mDNS ─────────────────
    repl.log('[net]  Searching for signaling server...', 'info');

    const discovered = await discovery.findServer(3000);
    let host, port;

    if (discovered) {
        host = discovered.host;
        port = discovered.port;
        repl.log(`[net]  ✓ Found server: ${host}:${port}`, 'success');
    } else {
        host = serverConfig.host;
        port = serverConfig.port;
        repl.log(`[net]  No server discovered — using config: ${host}:${port}`, 'warning');
    }

    // ── Connect to signaling server ────────────────────────
    bridge.connectServer(host, port);

    // ── Initial device scan (background) ───────────────────
    // Device formatting is handled by the REPL's _formatDeviceLine
    const onBootDevice = (device) => {
        repl._formatDeviceLine(device);
    };
    discovery.on('device', onBootDevice);

    // Show Tailscale error messages during boot scan
    const onBootTsError = (errType) => {
        if (errType === 'daemon-not-running') {
            repl.log('[error]  Tailscale daemon not running. Start it with: tailscale up', 'error');
        }
    };
    discovery.on('tailscale-error', onBootTsError);

    discovery.scan(5000).then((devices) => {
        discovery.removeListener('device', onBootDevice);
        discovery.removeListener('tailscale-error', onBootTsError);
        if (devices.length === 0) {
            repl.log('[net]  No devices found on initial scan.', 'dim');
        }
        repl.log('', 'default');
        repl.log('Type "help" for available commands.', 'dim');
        repl.log('', 'default');
    });

    // ── Start interactive REPL ─────────────────────────────
    repl.start();

    // ── Graceful shutdown ──────────────────────────────────
    process.on('SIGTERM', () => {
        bridge.shutdown();
        discovery.stop();
        process.exit(0);
    });
}

main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
