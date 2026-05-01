# OmniBridge CLI

Cross-device KVM bridge and secure file transfer — runs directly in your terminal.

## Install

```bash
# Global install (use from anywhere)
npm install -g omnibridge

# Or run locally
git clone <repo-url> && cd omnibridge
npm install
node index.js
```

## Usage

```bash
omnibridge
```

This starts an interactive REPL in your terminal with a boot sequence, network discovery, and a command prompt.

## Commands

| Command | Description |
|---|---|
| `scan` | Re-run mDNS network discovery, stream results live |
| `connect <device>` | Initiate bridge to a device by name or IP address |
| `disconnect` | Drop the current bridge connection |
| `status` | Print bridge state, connected device, encryption info |
| `mode auto` | Switch to automatic mDNS discovery |
| `mode manual <ip>` | Switch to manual IP mode and connect |
| `clipboard on\|off` | Toggle shared clipboard |
| `drop <filepath>` | Send a file over the secure bridge |
| `init` | Initialize the bridge engine (enable edge detection) |
| `clear` | Clear the terminal screen |
| `help` | List all commands |
| `exit` | Shut down and quit |

## Keyboard Shortcuts

- **↑ / ↓** — Cycle through command history (last 50 entries)
- **Tab** — Autocomplete commands
- **Ctrl+C** — Interrupt / cancel

## Signaling Server

Start the signaling server on one machine:

```bash
npm run server
```

Other machines on the same network will auto-discover it via mDNS. To connect manually, use `mode manual <ip>`.

## Configuration

Edit `config/omnibridge.json`:

```json
{
  "server": {
    "host": "auto",
    "port": 8080,
    "secret": "your-secret-key"
  }
}
```

Set `host` to `"auto"` for LAN IP auto-detection, or a specific IP/hostname.

## Architecture

```
index.js          — Entry point, boots engine, starts REPL
lib/
  repl.js         — Command parser, readline setup, output formatting
  discovery.js    — mDNS/Bonjour network scanning, emits device events
  bridge.js       — Connection + encryption lifecycle management
  transfer.js     — File transfer with ASCII progress bar
core/
  wsClient.js     — WebSocket client with chunked file transfer
  secureChannel.js — AES-256-GCM encryption with DH key exchange
  config.js       — Config loader with LAN IP auto-detection
  fileEngine.js   — File I/O with integrity verification
  inputEngine.js  — KVM input capture/injection (native addon)
server/
  signaling.js    — WebSocket signaling server
```
