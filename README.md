# OmniBridge

Cross-device KVM bridge and secure file transfer over your local network.
Share mouse, keyboard, clipboard, and files between machines from the terminal.

## Install

```bash
git clone <repo-url> && cd omnibridge
npm install
```

## Quick Start

```bash
# Start the signaling server on one machine
npm run server

# Start the CLI on each device
node index.js
```

## Commands

| Command | Description |
|---|---|
| `scan` | Run mDNS network discovery |
| `connect <device>` | Connect to a device by name or IP |
| `connect <host>:<port> --pin <PIN>` | Connect using PIN-based pairing (SPAKE2) |
| `disconnect` | Drop the current bridge connection |
| `pair` | Generate a 6-digit PIN and wait for a remote device to pair |
| `init` | Activate the KVM engine (mouse/keyboard forwarding) |
| `status` | Print bridge state, auth method, encryption info |
| `mode auto` | Switch to automatic mDNS discovery |
| `mode manual <ip>` | Switch to manual IP mode |
| `clipboard on\|off` | Toggle shared clipboard |
| `drop <filepath>` | Send a file over the encrypted bridge |
| `clear` | Clear the terminal |
| `help` | List all commands |
| `exit` | Shut down and quit |

## PIN-Based Pairing

OmniBridge supports PIN-based device pairing using the SPAKE2 protocol (RFC 9382).
This removes the need for a pre-shared secret in the config file.

```
Device A:  pair
           -> displays a 6-digit PIN and a TCP port

Device B:  connect 192.168.1.5:52341 --pin 847291
           -> SPAKE2 handshake over TCP
           -> AES-256-GCM session key derived via HKDF
```

The PIN is cryptographically random, expires after 90 seconds or on first use,
and is zeroed from memory immediately after key derivation.
Wrong PIN attempts receive a generic error (no information leakage).

After pairing, all bridge traffic (mouse, keyboard, clipboard, files) is encrypted
with the session key. The key exists only in memory and is never written to disk.

## Signaling Server

The signaling server relays encrypted messages between paired devices.
Start it on any machine reachable by both peers:

```bash
npm run server
```

Other machines on the same network discover it automatically via mDNS.
To connect manually, use `mode manual <ip>`.

## Configuration

Edit `config/omnibridge.json`:

```json
{
  "server": {
    "host": "auto",
    "port": 8080,
    "secret": "change-this"
  }
}
```

- `host` set to `"auto"` detects the LAN IP at runtime.
- `secret` is the fallback pre-shared key used when PIN pairing is not active.

## Project Structure

```
index.js            Entry point
lib/
  pairing.js        SPAKE2 PIN-based pairing (RFC 9382, P-256)
  bridge.js         Connection lifecycle, KVM pipeline, session cipher
  repl.js           Interactive command parser and terminal UI
  discovery.js      mDNS/Bonjour + Tailscale network scanning
  transfer.js       File transfer progress display
core/
  wsClient.js       WebSocket client with chunked transfer
  secureChannel.js  AES-256-GCM encryption, DH key exchange
  keyExchange.js    Diffie-Hellman parameter generation
  config.js         Config loader with LAN IP auto-detection
  fileEngine.js     File I/O with integrity verification
  inputEngine.js    KVM input capture/injection (native addon)
  logger.js         Structured logger
  loggerFactory.js  Logger factory (Electron/Node.js aware)
server/
  signaling.js      WebSocket relay server with connection approval
config/
  omnibridge.json   Runtime configuration
```

## Requirements

- Node.js >= 18
- Windows (native addons for KVM are Windows-only)
- Both devices must be on the same network (or use Tailscale)

## Keyboard Shortcuts

- Up/Down -- cycle command history
- Tab -- autocomplete commands
- Ctrl+C -- interrupt
