const { WebSocketServer } = require('ws');
const os = require('os');
const createLogger = require('../core/loggerFactory');
const Discovery = require('../core/discovery');

// Create logger instance
const logger = createLogger({ appName: 'Omnibridge-Signaling' });

class SignalingServer {
    constructor(port = 8080) {
        // Advertise this server on the network via mDNS/Bonjour
        this.discovery = new Discovery();
        this.discovery.publishServer(port);


        // Increase maxPayload to 256MB to handle potential large chunks safely
        this.wss = new WebSocketServer({ 
            port,
            maxPayload: 256 * 1024 * 1024 
        });
        this.clients = new Map(); // id -> ws
        this.connectionRequests = new Map(); // requester_id -> {target_id, deviceInfo, timestamp}

        this.wss.on('connection', (ws) => {
            const id = require('crypto').randomUUID();
            this.clients.set(id, ws);
            logger.info('Client connected', { clientId: id });

            ws.on('message', (message) => {
                let data;
                try {
                    data = JSON.parse(message);
                } catch (e) {
                    return;
                }
                
                // Handle key exchange messages — forward all fields intact
                if (data.type === 'key-exchange-init' || data.type === 'key-exchange-complete') {
                    const forward = JSON.stringify({
                        from:      id,
                        type:      data.type,
                        publicKey: data.publicKey,
                        prime:     data.prime,
                        generator: data.generator
                    });
                    if (data.target && this.clients.has(data.target)) {
                        const target = this.clients.get(data.target);
                        if (target.readyState === require('ws').OPEN) target.send(forward);
                    } else {
                        this.clients.forEach((client, cid) => {
                            if (cid !== id && client.readyState === require('ws').OPEN) client.send(forward);
                        });
                    }
                    return;
                }
                
                // Handle connection approval requests
                if (data.type === 'connection-request') {
                    // Store pending connection request
                    this.connectionRequests.set(id, {
                        requesterId: id,
                        targetId: data.targetId,
                        deviceInfo: data.deviceInfo,
                        timestamp: Date.now()
                    });
                    logger.info('Connection request received', { 
                        requesterId: id, 
                        targetId: data.targetId 
                    });
                    
                    // Notify target client of pending connection request
                    if (this.clients.has(data.targetId)) {
                        this.clients.get(data.targetId).send(JSON.stringify({
                            type: 'connection-request-pending',
                            requestingClientId: id,
                            deviceInfo: data.deviceInfo
                        }));
                    }
                    return;
                }
                
                // Handle connection approval
                if (data.type === 'connection-approve') {
                    const requestingClientId = data.requestingClientId;
                    logger.info('Connection approved', { 
                        requestingClientId: requestingClientId 
                    });
                    
                    // Notify both parties that connection is established
                    if (this.clients.has(requestingClientId) && this.clients.has(id)) {
                        this.clients.get(requestingClientId).send(JSON.stringify({
                            type: 'connection-established',
                            peerId: id
                        }));
                        this.clients.get(id).send(JSON.stringify({
                            type: 'connection-established',
                            peerId: requestingClientId
                        }));
                    }
                    return;
                }
                
                // Handle connection rejection
                if (data.type === 'connection-reject') {
                    const requestingClientId = data.requestingClientId;
                    logger.info('Connection rejected', { 
                        requestingClientId: requestingClientId 
                    });
                    
                    // Notify requesting client that connection was rejected
                    if (this.clients.has(requestingClientId)) {
                        this.clients.get(requestingClientId).send(JSON.stringify({
                            type: 'connection-rejected',
                            reason: 'Connection rejected by peer'
                        }));
                    }
                    return;
                }
                
                // Targeted routing
                if (data.target && this.clients.has(data.target)) {
                    this.clients.get(data.target).send(JSON.stringify({
                        from: id,
                        payload: data.payload
                    }));
                } 
                // Handshake or Broadcast
                else {
                    this.broadcast(id, data);
                }
            });

            ws.on('close', () => {
                this.clients.delete(id);
                logger.info('Client disconnected', { clientId: id });
            });
        });

        // ── IP Discovery for User Convenience ──
        logger.info('--- OMNIBRIDGE HUB STARTING ---');
        const networkInterfaces = os.networkInterfaces();
        for (const interfaceName in networkInterfaces) {
            for (const iface of networkInterfaces[interfaceName]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    logger.info(`Server Active: ws://${iface.address}:${port}`);
                }
            }
        }
        logger.info('-------------------------------');
    }

    broadcast(senderId, data) {
        const payload = JSON.stringify({
            from: senderId,
            payload: data.payload
        });

        this.clients.forEach((client, id) => {
            if (id !== senderId && client.readyState === require('ws').OPEN) {
                client.send(payload);
            }
        });
    }
}

if (require.main === module) {
    new SignalingServer();
}

module.exports = SignalingServer;