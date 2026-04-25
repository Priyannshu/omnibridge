const WebSocket = require('ws');
const crypto = require('crypto');
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
    }

    connect() {
        if (this.ws) this.disconnect();
        
        logger.info('Connecting to server', { url: this.serverUrl });
        this.ws = new WebSocket(this.serverUrl);

        this.ws.on('open', () => {
            logger.info('Connected to signaling server');
            this.reconnectAttempts = 0;
            if (this.onStatus) this.onStatus('connected');
            
            // Initial handshake to announce presence
            this.sendEvent({ type: 'handshake', name: 'omnibridge-peer' });
        });

        this.ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw);
                
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
                    logger.info('Connection rejected by peer');
                    if (this.onStatus) this.onStatus('connection-rejected');
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

                if (msg.payload) {
                    const decrypted = this.secureChannel.decrypt(msg.payload);
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
            logger.info('Disconnected from signaling server');
            if (this.onStatus) this.onStatus('disconnected');
            this._attemptReconnect();
        });

        this.ws.on('error', (e) => {
            logger.error('WSClient error', { error: e.message });
            if (this.onStatus) this.onStatus('error');
        });
    }

    _attemptReconnect() {
        if (this.reconnectAttempts < this.maxAttempts) {
            this.reconnectAttempts++;
            logger.info('Reconnection attempt', { attempt: this.reconnectAttempts });
            setTimeout(() => this.connect(), 2000);
        }
    }

    sendEvent(event) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
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
        this.reconnectAttempts = 0; // reset so manual reconnect starts fresh
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
    requestConnection(targetDeviceId) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const msg = {
                type: 'connection-request',
                targetId: targetDeviceId,
                deviceInfo: {
                    name: 'omnibridge-peer',
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