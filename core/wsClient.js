const WebSocket = require('ws');
const crypto = require('crypto');
const os = require('os');
const createLogger = require('./loggerFactory');

// Create logger instance
const logger = createLogger({ appName: 'Omnibridge-WSClient' });

class WSClient {
    constructor(serverUrl, secureChannel) {
        this.serverUrl = serverUrl;
        this.secureChannel = secureChannel;
        this.ws = null;
        this.onEvent = null;
        this.onStatus = null;
        this.myId = null;
        this.targetId = null;
        this.reconnectAttempts = 0;
        this.maxAttempts = 5;
        this.connectionApproved = false;
        this.pendingConnectionRequest = null;
        this.keyExchangeCompleted = false;

        // Internal state guards
        this._intentionalDisconnect = false;  // true when disconnect() is called manually
        this._hasNotifiedError = false;        // prevents duplicate error+close notifications
        this._heartbeatTimer = null;           // ping/pong keepalive timer

        // Session cipher from SPAKE2 pairing (optional, overrides secureChannel for bridge traffic)
        this._sessionCipher = null;
    }

    connect() {
        if (this.ws) this.disconnect();
        
        logger.info('Connecting to server', { url: this.serverUrl });
        this.ws = new WebSocket(this.serverUrl);

        this._intentionalDisconnect = false;
        this._hasNotifiedError = false;

        this.ws.on('open', () => {
            logger.info('Connected to signaling server');
            this.reconnectAttempts = 0;
            this._hasNotifiedError = false;
            if (this.onStatus) this.onStatus('connected');
            
            // Register this client's hostname with the server (raw, unencrypted)
            // so the server can route connection requests by device name.
            this.ws.send(JSON.stringify({
                type: 'register',
                name: os.hostname(),
                platform: process.platform
            }));

            // Start heartbeat ping every 25s to keep the connection alive
            this._startHeartbeat();
        });

        this.ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw);
                
                // Handle server registration confirmation
                if (msg.type === 'registered') {
                    this.myId = msg.clientId;
                    logger.info('Registered with server', { clientId: msg.clientId, name: msg.name });
                    return;
                }
                
                // Handle connection approval messages
                if (msg.type === 'connection-request-pending') {
                    logger.info('Connection request pending from peer');
                    if (this.onStatus) this.onStatus('connection-request-pending', msg);
                    return;
                }
                
                if (msg.type === 'connection-established') {
                    logger.info('Connection established with peer');
                    this.connectionApproved = true;
                    this.targetId = msg.peerId;
                    if (this.onStatus) this.onStatus('connection-established');
                    return;
                }
                
                if (msg.type === 'connection-rejected') {
                    logger.info('Connection rejected', { reason: msg.reason });
                    if (this.onStatus) this.onStatus('connection-rejected', msg);
                    return;
                }
                
                // Handle key exchange messages
                if (msg.type === 'key-exchange-init') {
                    logger.info('Key exchange initiated by peer');
                    this.handleKeyExchangeInit(msg);
                    return;
                }
                
                if (msg.type === 'key-exchange-complete') {
                    logger.info('Key exchange completed by peer — computing shared secret');
                    if (msg.publicKey) {
                        this.secureChannel.computeSharedSecret(msg.publicKey);
                    }
                    this.keyExchangeCompleted = true;
                    if (this.onStatus) this.onStatus('key-exchange-completed');
                    return;
                }
                
                // Resolve targetId from message sender if not yet established via connection-established
                if (!this.targetId && msg.from) {
                    this.targetId = msg.from;
                    logger.info('Peer resolved from message', { peerId: this.targetId });
                }

                if (msg.payload || msg.sessionPayload) {
                    let decrypted;

                    // Try session cipher first (SPAKE2-derived key)
                    if (msg.sessionPayload && this._sessionCipher) {
                        try {
                            const buf = Buffer.from(msg.sessionPayload, 'base64');
                            decrypted = JSON.stringify(this._sessionCipher.decryptJSON(buf));
                        } catch (e) {
                            logger.error('Session cipher decryption failed', { error: e.message });
                            return;
                        }
                    } else if (msg.payload) {
                        // Fallback to pre-shared SecureChannel
                        decrypted = this.secureChannel.decrypt(msg.payload);
                    }

                    if (decrypted && this.onEvent) {
                        const event = JSON.parse(decrypted);
                        
                        // Handle internal handshake response
                        if (event.type === 'handshake') {
                            logger.info('Handshake received from peer');
                            return;
                        }
                        
                        this.onEvent(event);
                    }
                }
            } catch (e) {
                logger.error('WSClient receive error', { error: e.message });
            }
        });

        this.ws.on('close', () => {
            this._stopHeartbeat();
            logger.info('Disconnected from signaling server');

            // If close was triggered by our own disconnect(), don't notify or reconnect
            if (this._intentionalDisconnect) return;

            // If on('error') already fired, skip the duplicate 'disconnected' notification
            if (!this._hasNotifiedError) {
                if (this.onStatus) this.onStatus('disconnected');
            }
            this._hasNotifiedError = false;
            this._attemptReconnect();
        });

        this.ws.on('error', (e) => {
            this._stopHeartbeat();
            logger.error('WSClient error', { error: e.message });
            // Mark that we already sent an error notification;
            // the subsequent 'close' event should not send a duplicate.
            this._hasNotifiedError = true;
            if (this.onStatus) this.onStatus('error');
        });
    }

    _attemptReconnect() {
        if (this._intentionalDisconnect) return;
        if (this.reconnectAttempts < this.maxAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(2000 * this.reconnectAttempts, 10000); // exponential backoff, max 10s
            logger.info('Reconnection attempt', { attempt: this.reconnectAttempts, delayMs: delay });
            setTimeout(() => {
                if (!this._intentionalDisconnect) this.connect();
            }, delay);
        } else {
            logger.warn('Max reconnection attempts reached');
        }
    }

    /** Start periodic ping to keep the WebSocket connection alive. */
    _startHeartbeat() {
        this._stopHeartbeat();
        this._heartbeatTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                try { this.ws.ping(); } catch (_) {}
            }
        }, 25000);
        // Don't prevent Node from exiting if this is the only active timer
        if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
    }

    /** Stop the heartbeat timer. */
    _stopHeartbeat() {
        if (this._heartbeatTimer) {
            clearInterval(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }
    }

    sendEvent(event) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        // If a SPAKE2 session cipher is active, use it for bridge traffic
        if (this._sessionCipher) {
            const encrypted = this._sessionCipher.encryptJSON(event);
            const msg = this.targetId
                ? { target: this.targetId, sessionPayload: encrypted.toString('base64') }
                : { sessionPayload: encrypted.toString('base64') };
            this.ws.send(JSON.stringify(msg));
            return;
        }

        // Fallback: use pre-shared SecureChannel
        const encrypted = this.secureChannel.encrypt(JSON.stringify(event));
        const msg = this.targetId
            ? { target: this.targetId, payload: encrypted }
            : { payload: encrypted };
        this.ws.send(JSON.stringify(msg));
    }

    // New: Send large events (like files) in chunks with integrity checksums
    async sendChunked(type, payload, onProgress) {
        const CHUNK_SIZE = 512 * 1024; // 512KB
        const data = payload.data; // Assumes base64 for now or raw
        const totalChunks = Math.ceil(data.length / CHUNK_SIZE);

        for (let i = 0; i < totalChunks; i++) {
            const chunk = data.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
            
            // Calculate checksum for integrity verification
            const checksum = crypto.createHash('sha256').update(chunk).digest('hex');
            
            this.sendEvent({
                type: type,
                chunkIndex: i,
                totalChunks: totalChunks,
                fileName: payload.fileName,
                data: chunk,
                checksum: checksum // Add checksum for integrity verification
            });

            if (onProgress) onProgress((i + 1) / totalChunks);
            
            // Backpressure: wait if socket buffer is filling up
            while (this.ws && this.ws.bufferedAmount > 1024 * 1024) {
                await new Promise(r => setTimeout(r, 20));
            }
            // Small throttle to avoid overwhelming the socket buffer
            if (i % 5 === 0) await new Promise(r => setTimeout(r, 10));
        }
    }

    disconnect() {
        this._intentionalDisconnect = true;
        this._stopHeartbeat();
        this.reconnectAttempts = 0;
        if (this.ws) {
            try {
                this.ws.removeAllListeners();
                if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                    this.ws.close();
                }
            } catch (e) {
                // Ignore close errors — socket may already be dead
            }
            this.ws = null;
        }
    }

    /**
     * Set a SPAKE2-derived session cipher for bridge traffic encryption.
     * When set, sendEvent() and message decryption use this instead of SecureChannel.
     * @param {SessionCipher} cipher
     */
    setSessionCipher(cipher) {
        this._sessionCipher = cipher;
    }
    
    // Key exchange methods
    async initiateKeyExchange() {
        try {
            // Initialize key exchange
            const keyExchangeMessage = await this.secureChannel.initializeKeyExchange();
            
            // Send key exchange initiation message
            this.sendEvent(keyExchangeMessage);
        } catch (error) {
            logger.error('Key exchange initialization failed', { error: error.message });
        }
    }
    
    async handleKeyExchangeInit(initMessage) {
        try {
            // Set DH params from initiator, generate our key pair, compute shared secret
            const myPublicKey = this.secureChannel.completeKeyExchange(initMessage);
            this.keyExchangeCompleted = true;

            // Send our public key back so initiator can compute the same shared secret
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({
                    type: 'key-exchange-complete',
                    target: this.targetId,
                    publicKey: myPublicKey
                }));
            }

            logger.info('Key exchange completed successfully');
        } catch (error) {
            logger.error('Key exchange completion failed', { error: error.message });
        }
    }
    
    // Connection approval methods
    requestConnection(targetDeviceName) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const msg = {
                type: 'connection-request',
                targetName: targetDeviceName,
                deviceInfo: {
                    name: os.hostname(),
                    platform: process.platform
                }
            };
            this.ws.send(JSON.stringify(msg));
        }
    }
    
    approveConnection(requestingClientId) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const msg = {
                type: 'connection-approve',
                requestingClientId: requestingClientId
            };
            this.ws.send(JSON.stringify(msg));
        }
    }
    
    rejectConnection(requestingClientId) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const msg = {
                type: 'connection-reject',
                requestingClientId: requestingClientId
            };
            this.ws.send(JSON.stringify(msg));
        }
    }
}

module.exports = WSClient;