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
        this.clients = new Map();            // clientId → ws
        this.clientNames = new Map();        // deviceName → clientId (for routing by name)
        this.clientIdToName = new Map();     // clientId → deviceName (for cleanup on disconnect)
        this.connectionRequests = new Map(); // requester_id → {targetName, deviceInfo, timestamp}

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
                
                // Handle client registration — maps device name to clientId
                if (data.type === 'register') {
                    const name = data.name;
                    if (name) {
                        this.clientNames.set(name, id);
                        this.clientIdToName.set(id, name);
                        logger.info('Client registered', { clientId: id, name, platform: data.platform });
                        
                        // Send back the assigned clientId so the client knows its own ID
                        ws.send(JSON.stringify({
                            type: 'registered',
                            clientId: id,
                            name
                        }));
                    }
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
                
                // Handle connection requests — resolve target by device name
                if (data.type === 'connection-request') {
                    const targetName = data.targetName;
                    const targetClientId = this.clientNames.get(targetName);

                    // Store pending request
                    this.connectionRequests.set(id, {
                        requesterId: id,
                        targetName,
                        targetClientId: targetClientId || null,
                        deviceInfo: data.deviceInfo,
                        timestamp: Date.now()
                    });

                    if (!targetClientId || !this.clients.has(targetClientId)) {
                        logger.info('Connection request received — target not connected', {
                            requesterId: id,
                            targetName
                        });
                        // Notify requester that the target is not online on this server
                        ws.send(JSON.stringify({
                            type: 'connection-rejected',
                            reason: `Device "${targetName}" is not connected to this server`
                        }));
                        return;
                    }

                    logger.info('Connection request received — forwarding to target', {
                        requesterId: id,
                        targetName,
                        targetClientId
                    });

                    // Forward to target peer
                    this.clients.get(targetClientId).send(JSON.stringify({
                        type: 'connection-request-pending',
                        requestingClientId: id,
                        deviceInfo: data.deviceInfo
                    }));
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
                // Clean up name registry
                const name = this.clientIdToName.get(id);
                if (name) {
                    this.clientNames.delete(name);
                    this.clientIdToName.delete(id);
                }
                this.connectionRequests.delete(id);
                logger.info('Client disconnected', { clientId: id, name: name || 'unregistered' });
            });

            // Keepalive: mark alive on pong
            ws.isAlive = true;
            ws.on('pong', () => { ws.isAlive = true; });
        });

        // Server-side keepalive sweep: ping all clients every 30s,
        // terminate any that didn't respond to the previous ping.
        this._keepaliveInterval = setInterval(() => {
            this.wss.clients.forEach((ws) => {
                if (ws.isAlive === false) {
                    logger.info('Terminating unresponsive client');
                    return ws.terminate();
                }
                ws.isAlive = false;
                try { ws.ping(); } catch (_) {}
            });
        }, 30000);

        // Handle port-in-use and other server errors gracefully
        this.wss.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                logger.error(`Port ${port} is already in use. Kill the other process or use a different port.`);
                logger.error('Find the process: netstat -ano | findstr :' + port);
            } else {
                logger.error('WebSocket server error', { error: err.message });
            }
            process.exit(1);
        });

        // ── IP Discovery for User Convenience ──
        // Log after a short tick to ensure the server is actually listening
        setImmediate(() => {
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
        });
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