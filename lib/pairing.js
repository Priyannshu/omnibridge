// lib/pairing.js — PIN-based pairing via SPAKE2 (RFC 9382) over raw TCP
// Ciphersuite: SPAKE2-P256-SHA256-HKDF-HMAC
//
// Flow:
//   Device A (host):  `pair`    → generates PIN, listens on random TCP port
//   Device B (client): `connect <device> --pin <PIN>` → connects, runs SPAKE2
//
// After SPAKE2, both derive a session AES-256-GCM key via HKDF.
// The PIN is zeroed immediately after key derivation.

const crypto = require('crypto');
const net = require('net');
const os = require('os');
const { p256 } = require('@noble/curves/nist.js');
const createLogger = require('../core/loggerFactory');

const logger = createLogger({ appName: 'Omnibridge-Pairing' });

// ═══════════════════════════════════════════════════════════
//  SPAKE2 Constants — RFC 9382 §6, P-256 ciphersuite
// ═══════════════════════════════════════════════════════════

// M and N are "nothing-up-my-sleeve" curve points from the RFC.
// Compressed SEC1 encoding, as specified in RFC 9382 §6.
const M_HEX = '02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f';
const N_HEX = '03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49';

const Point = p256.Point;
const M = Point.fromHex(M_HEX);
const N = Point.fromHex(N_HEX);

// P-256 curve order (NIST SP 800-186 / FIPS 186-5)
const CURVE_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

// Protocol identities (used in transcript)
const IDENTITY_A = Buffer.from('omnibridge-host');
const IDENTITY_B = Buffer.from('omnibridge-client');

// PIN lifetime
const PIN_EXPIRY_MS = 90_000; // 90 seconds

// TCP port range for pairing listener
const PORT_MIN = 49152;
const PORT_MAX = 65535;

// ═══════════════════════════════════════════════════════════
//  Frame encoding: length-prefixed binary over TCP
//  [4-byte big-endian length][payload]
// ═══════════════════════════════════════════════════════════

/** Encode a buffer as a length-prefixed frame. */
function encodeFrame(buf) {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(buf.length, 0);
    return Buffer.concat([header, buf]);
}

/**
 * Accumulate TCP data and yield complete frames.
 * Returns a stateful parser function: feed it chunks, it returns complete frames.
 */
function createFrameParser() {
    let buffer = Buffer.alloc(0);

    return function feed(chunk) {
        buffer = Buffer.concat([buffer, chunk]);
        const frames = [];

        while (buffer.length >= 4) {
            const len = buffer.readUInt32BE(0);
            if (len > 1024 * 1024) throw new Error('Frame too large');
            if (buffer.length < 4 + len) break;  // incomplete frame
            frames.push(buffer.subarray(4, 4 + len));
            buffer = buffer.subarray(4 + len);
        }

        return frames;
    };
}

// ═══════════════════════════════════════════════════════════
//  SPAKE2 Core (RFC 9382 §3.3 with P-256)
// ═══════════════════════════════════════════════════════════

/**
 * Derive w from PIN: w = SHA-256(PIN) mod (curve_order).
 * Per RFC 9382 §3.2, w should be derived via MHF. For a 6-digit PIN
 * with a 90-second TTL and one-shot use, brute-force is constrained
 * to online attacks only (SPAKE2's core security guarantee), so SHA-256
 * is sufficient here. The PIN's entropy is the limiting factor regardless.
 */
function deriveW(pin) {
    const hash = crypto.createHash('sha256').update(pin).digest();
    // Convert to BigInt, reduce mod curve order
    const hashInt = BigInt('0x' + hash.toString('hex'));
    return hashInt % CURVE_ORDER;
}

/**
 * SPAKE2 side A (host): compute pA = x*G + w*M
 * Returns { x, pA } where x is the random scalar, pA is the public value.
 */
function spake2A(w) {
    // Pick random scalar x ∈ [1, p-1]
    const xBytes = p256.utils.randomSecretKey();
    const x = BigInt('0x' + Buffer.from(xBytes).toString('hex'));

    // X = x * G
    const X = Point.BASE.multiply(x);
    // pA = X + w * M
    const wM = M.multiply(w);
    const pA = X.add(wM);

    return { x, pA };
}

/**
 * SPAKE2 side B (client): compute pB = y*G + w*N
 * Returns { y, pB }.
 */
function spake2B(w) {
    const yBytes = p256.utils.randomSecretKey();
    const y = BigInt('0x' + Buffer.from(yBytes).toString('hex'));

    const Y = Point.BASE.multiply(y);
    const wN = N.multiply(w);
    const pB = Y.add(wN);

    return { y, pB };
}

/**
 * A computes shared value K = x * (pB - w*N)
 * P-256 has cofactor h=1, so no cofactor multiplication needed.
 */
function computeK_A(x, w, pB) {
    const wN = N.multiply(w);
    const pBminuswN = pB.subtract(wN);
    return pBminuswN.multiply(x);
}

/**
 * B computes shared value K = y * (pA - w*M)
 */
function computeK_B(y, w, pA) {
    const wM = M.multiply(w);
    const pAminuswM = pA.subtract(wM);
    return pAminuswM.multiply(y);
}

/**
 * Serialize a point to an uncompressed SEC1 byte buffer (65 bytes for P-256).
 */
function pointToBytes(pt) {
    return Buffer.from(pt.toHex(false), 'hex');
}

/**
 * Build the transcript TT per RFC 9382 §3.3:
 *   TT = len(A) || A || len(B) || B || len(pA) || pA || len(pB) || pB || len(K) || K || len(w) || w
 * All lengths are 8-byte little-endian.
 */
function buildTranscript(identityA, identityB, pABytes, pBBytes, kBytes, wBytes) {
    const parts = [identityA, identityB, pABytes, pBBytes, kBytes, wBytes];
    const buffers = [];

    for (const part of parts) {
        const lenBuf = Buffer.alloc(8);
        lenBuf.writeBigUInt64LE(BigInt(part.length), 0);
        buffers.push(lenBuf, part);
    }

    return Buffer.concat(buffers);
}

/**
 * Key schedule: derive Ke (session key material) and Ka (key confirmation material).
 *   Hash(TT) = Ke || Ka   (each 128 bits for SHA-256)
 *   KDF(Ka, nil, "ConfirmationKeys", 256) = KcA || KcB
 */
function deriveKeys(transcript) {
    const hashTT = crypto.createHash('sha256').update(transcript).digest();
    const Ke = hashTT.subarray(0, 16);
    const Ka = hashTT.subarray(16, 32);

    // Derive confirmation keys via HKDF
    const confirmKeys = crypto.hkdfSync('sha256', Ka, Buffer.alloc(0), 'ConfirmationKeys', 32);
    const confirmBuf = Buffer.from(confirmKeys);
    const KcA = confirmBuf.subarray(0, 16);
    const KcB = confirmBuf.subarray(16, 32);

    return { Ke, KcA, KcB };
}

/**
 * Compute key confirmation MAC: HMAC-SHA256(Kc, transcript)
 */
function computeConfirmation(kc, transcript) {
    return crypto.createHmac('sha256', kc).update(transcript).digest();
}

/**
 * Derive the final AES-256 session key from SPAKE2's Ke via HKDF,
 * with the label specified by the user: 'omnibridge-session-v1'.
 */
function deriveSessionKey(Ke) {
    const keyMaterial = crypto.hkdfSync(
        'sha256',
        Ke,
        Buffer.alloc(0),       // no salt
        'omnibridge-session-v1', // info/label
        32                     // 256 bits for AES-256
    );
    return Buffer.from(keyMaterial);
}

// ═══════════════════════════════════════════════════════════
//  Session Encryption — AES-256-GCM
//  Wire format: [12-byte IV][ciphertext][16-byte GCM tag]
// ═══════════════════════════════════════════════════════════

class SessionCipher {
    constructor(key) {
        this._key = Buffer.from(key); // copy
    }

    /** Encrypt plaintext → [12-byte IV][ciphertext][16-byte tag] */
    encrypt(plaintext) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this._key, iv);
        const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const tag = cipher.getAuthTag();
        return Buffer.concat([iv, ct, tag]);
    }

    /** Decrypt [12-byte IV][ciphertext][16-byte tag] → plaintext */
    decrypt(frame) {
        if (frame.length < 28) throw new Error('Frame too short for AES-256-GCM');
        const iv = frame.subarray(0, 12);
        const tag = frame.subarray(frame.length - 16);
        const ct = frame.subarray(12, frame.length - 16);
        const decipher = crypto.createDecipheriv('aes-256-gcm', this._key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ct), decipher.final()]);
    }

    /** Encrypt a JSON-serializable object → Buffer (for WebSocket bridge traffic). */
    encryptJSON(obj) {
        return this.encrypt(Buffer.from(JSON.stringify(obj), 'utf8'));
    }

    /** Decrypt a Buffer → parsed JSON object. */
    decryptJSON(frame) {
        return JSON.parse(this.decrypt(frame).toString('utf8'));
    }

    /** Zero out the key from memory. */
    destroy() {
        this._key.fill(0);
    }
}

// ═══════════════════════════════════════════════════════════
//  Pairing Host (Device A) — `pair` command
// ═══════════════════════════════════════════════════════════

class PairingHost {
    constructor() {
        this.pin = null;
        this.server = null;
        this.port = null;
        this.sessionKey = null;
        this.sessionCipher = null;
        this._timeout = null;
        this._resolved = false;
    }

    /**
     * Start the pairing listener.
     * Generates a PIN, opens a TCP server on a random port, waits for one client.
     * Returns a promise that resolves with { sessionKey, sessionCipher, peerHostname }
     * or rejects on timeout / wrong PIN / error.
     */
    start() {
        return new Promise((resolve, reject) => {
            // Generate cryptographically random 6-digit PIN
            this.pin = String(crypto.randomInt(100000, 999999));

            const done = (err, result) => {
                if (this._resolved) return;
                this._resolved = true;
                this._cleanup();
                if (err) reject(err);
                else resolve(result);
            };

            // Set PIN expiry timer
            this._timeout = setTimeout(() => {
                done(new Error('PIN expired — no pairing attempt within 90 seconds'));
            }, PIN_EXPIRY_MS);

            // Choose random port
            this.port = crypto.randomInt(PORT_MIN, PORT_MAX + 1);

            this.server = net.createServer((socket) => {
                // Only accept one connection
                this.server.close();
                this._handleClient(socket, done);
            });

            this.server.on('error', (err) => {
                done(new Error(`Pairing server error: ${err.message}`));
            });

            this.server.listen(this.port, '0.0.0.0', () => {
                logger.info('Pairing server listening', { port: this.port });
            });
        });
    }

    /** Get the generated PIN (for display to user). */
    getPin() { return this.pin; }

    /** Get the port the server is listening on. */
    getPort() { return this.port; }

    /** Handle a single pairing client connection. */
    _handleClient(socket, done) {
        const parser = createFrameParser();
        let state = 'AWAIT_PB';  // states: AWAIT_PB → AWAIT_CONFIRM → DONE
        let w, hostState, pABytes, pBBytes, kBytes, wBytes, transcript, keys;

        // Derive w from PIN
        w = deriveW(this.pin);
        // Zero the PIN string immediately
        this.pin = null;

        // A side: compute pA
        hostState = spake2A(w);
        pABytes = pointToBytes(hostState.pA); // uncompressed, 65 bytes

        // Send pA + hostname to client (frame 1)
        const msg1 = Buffer.concat([
            Buffer.from([pABytes.length]),
            pABytes,
            Buffer.from(os.hostname(), 'utf8')
        ]);
        socket.write(encodeFrame(msg1));

        socket.on('data', (chunk) => {
            let frames;
            try {
                frames = parser(chunk);
            } catch (e) {
                done(new Error('Pairing failed'));
                socket.destroy();
                return;
            }

            for (const frame of frames) {
                try {
                    if (state === 'AWAIT_PB') {
                        // Parse pB + hostname from client
                        const pBLen = frame[0];
                        pBBytes = frame.subarray(1, 1 + pBLen);
                        const peerHostname = frame.subarray(1 + pBLen).toString('utf8');

                        // Validate pB is on the curve
                        let pB;
                        try {
                            pB = Point.fromHex(Buffer.from(pBBytes).toString('hex'));
                            pB.assertValidity();
                        } catch (_) {
                            done(new Error('Pairing failed'));
                            socket.destroy();
                            return;
                        }

                        // Compute K
                        const K = computeK_A(hostState.x, w, pB);
                        kBytes = pointToBytes(K);

                        // Build w as big-endian padded to 32 bytes
                        wBytes = Buffer.alloc(32);
                        const wHex = w.toString(16).padStart(64, '0');
                        Buffer.from(wHex, 'hex').copy(wBytes);

                        // Build transcript
                        transcript = buildTranscript(
                            IDENTITY_A, IDENTITY_B,
                            pABytes, pBBytes, kBytes, wBytes
                        );

                        // Derive keys
                        keys = deriveKeys(transcript);

                        // Compute A's confirmation and send it
                        const cA = computeConfirmation(keys.KcA, transcript);
                        socket.write(encodeFrame(cA));

                        state = 'AWAIT_CONFIRM';
                        // Store peer hostname for result
                        this._peerHostname = peerHostname;

                    } else if (state === 'AWAIT_CONFIRM') {
                        // Verify B's confirmation
                        const expectedCB = computeConfirmation(keys.KcB, transcript);

                        if (frame.length !== expectedCB.length ||
                            !crypto.timingSafeEqual(frame, expectedCB)) {
                            // Wrong PIN or tampering — generic error (no oracle)
                            done(new Error('Pairing failed'));
                            socket.destroy();
                            return;
                        }

                        // Success — derive session key
                        const sessionKey = deriveSessionKey(keys.Ke);
                        this.sessionKey = sessionKey;
                        this.sessionCipher = new SessionCipher(sessionKey);

                        // Zero intermediate key material
                        keys.Ke.fill(0);
                        keys.KcA.fill(0);
                        keys.KcB.fill(0);
                        wBytes.fill(0);

                        // Send a success ack so the client knows pairing completed
                        socket.write(encodeFrame(Buffer.from('OK')));
                        socket.end();

                        state = 'DONE';
                        done(null, {
                            sessionKey,
                            sessionCipher: this.sessionCipher,
                            peerHostname: this._peerHostname
                        });
                    }
                } catch (e) {
                    logger.error('Pairing protocol error', { error: e.message });
                    done(new Error('Pairing failed'));
                    socket.destroy();
                }
            }
        });

        socket.on('error', () => {
            done(new Error('Pairing failed'));
        });

        socket.on('close', () => {
            if (state !== 'DONE') {
                done(new Error('Pairing failed'));
            }
        });
    }

    /** Cancel pairing and clean up. */
    cancel() {
        this._resolved = true;
        this._cleanup();
    }

    _cleanup() {
        if (this._timeout) { clearTimeout(this._timeout); this._timeout = null; }
        if (this.server) { try { this.server.close(); } catch (_) {} this.server = null; }
        this.pin = null;
    }
}

// ═══════════════════════════════════════════════════════════
//  Pairing Client (Device B) — `connect ... --pin <PIN>`
// ═══════════════════════════════════════════════════════════

class PairingClient {
    constructor() {
        this.sessionKey = null;
        this.sessionCipher = null;
    }

    /**
     * Connect to a pairing host and complete the SPAKE2 handshake.
     * @param {string} host - IP or hostname of the host
     * @param {number} port - TCP port the host is listening on
     * @param {string} pin  - 6-digit PIN displayed by the host
     * @returns {Promise<{sessionKey, sessionCipher, peerHostname}>}
     */
    connect(host, port, pin) {
        return new Promise((resolve, reject) => {
            let resolved = false;
            const done = (err, result) => {
                if (resolved) return;
                resolved = true;
                if (err) reject(err);
                else resolve(result);
            };

            // Timeout after 15 seconds
            const timeout = setTimeout(() => {
                done(new Error('Pairing failed'));
                socket.destroy();
            }, 15000);

            const socket = net.createConnection({ host, port }, () => {
                logger.info('Connected to pairing host', { host, port });
            });

            const parser = createFrameParser();
            let state = 'AWAIT_PA';
            let w, clientState, pABytes, pBBytes, kBytes, wBytes, transcript, keys;

            // Derive w from PIN
            w = deriveW(pin);

            socket.on('data', (chunk) => {
                let frames;
                try {
                    frames = parser(chunk);
                } catch (e) {
                    done(new Error('Pairing failed'));
                    socket.destroy();
                    return;
                }

                for (const frame of frames) {
                    try {
                        if (state === 'AWAIT_PA') {
                            // Parse pA + hostname from host
                            const pALen = frame[0];
                            pABytes = frame.subarray(1, 1 + pALen);
                            const peerHostname = frame.subarray(1 + pALen).toString('utf8');

                            // Validate pA is on the curve
                            let pA;
                            try {
                                pA = Point.fromHex(Buffer.from(pABytes).toString('hex'));
                                pA.assertValidity();
                            } catch (_) {
                                done(new Error('Pairing failed'));
                                socket.destroy();
                                return;
                            }

                            // B side: compute pB
                            clientState = spake2B(w);
                            pBBytes = pointToBytes(clientState.pB);

                            // Compute K
                            const K = computeK_B(clientState.y, w, pA);
                            kBytes = pointToBytes(K);

                            // Build w as big-endian padded to 32 bytes
                            wBytes = Buffer.alloc(32);
                            const wHex = w.toString(16).padStart(64, '0');
                            Buffer.from(wHex, 'hex').copy(wBytes);

                            // Build transcript
                            transcript = buildTranscript(
                                IDENTITY_A, IDENTITY_B,
                                pABytes, pBBytes, kBytes, wBytes
                            );

                            // Derive keys
                            keys = deriveKeys(transcript);

                            // Send pB + hostname to host
                            const msg = Buffer.concat([
                                Buffer.from([pBBytes.length]),
                                pBBytes,
                                Buffer.from(os.hostname(), 'utf8')
                            ]);
                            socket.write(encodeFrame(msg));

                            state = 'AWAIT_CONFIRM';
                            this._peerHostname = peerHostname;

                        } else if (state === 'AWAIT_CONFIRM') {
                            // Verify A's confirmation
                            const expectedCA = computeConfirmation(keys.KcA, transcript);

                            if (frame.length !== expectedCA.length ||
                                !crypto.timingSafeEqual(frame, expectedCA)) {
                                done(new Error('Pairing failed'));
                                socket.destroy();
                                return;
                            }

                            // Send B's confirmation
                            const cB = computeConfirmation(keys.KcB, transcript);
                            socket.write(encodeFrame(cB));

                            state = 'AWAIT_ACK';

                        } else if (state === 'AWAIT_ACK') {
                            // Host sent success ack
                            const sessionKey = deriveSessionKey(keys.Ke);
                            this.sessionKey = sessionKey;
                            this.sessionCipher = new SessionCipher(sessionKey);

                            // Zero intermediate key material
                            keys.Ke.fill(0);
                            keys.KcA.fill(0);
                            keys.KcB.fill(0);
                            wBytes.fill(0);

                            clearTimeout(timeout);
                            socket.end();

                            state = 'DONE';
                            done(null, {
                                sessionKey,
                                sessionCipher: this.sessionCipher,
                                peerHostname: this._peerHostname
                            });
                        }
                    } catch (e) {
                        logger.error('Pairing protocol error', { error: e.message });
                        done(new Error('Pairing failed'));
                        socket.destroy();
                    }
                }
            });

            socket.on('error', () => {
                clearTimeout(timeout);
                done(new Error('Pairing failed'));
            });

            socket.on('close', () => {
                clearTimeout(timeout);
                if (state !== 'DONE') {
                    done(new Error('Pairing failed'));
                }
            });
        });
    }
}

module.exports = {
    PairingHost,
    PairingClient,
    SessionCipher,
    // Exported for testing only
    _internal: { deriveW, spake2A, spake2B, computeK_A, computeK_B,
                 buildTranscript, deriveKeys, deriveSessionKey,
                 computeConfirmation, encodeFrame, createFrameParser }
};
