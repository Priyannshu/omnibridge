const { Bonjour } = require('bonjour-service');
const EventEmitter = require('events');
const createLogger = require('./loggerFactory');

// Create logger instance
const logger = createLogger({ appName: 'Omnibridge-Discovery' });

class Discovery extends EventEmitter {
    constructor() {
        super();
        this.bonjour = new Bonjour();
        this.serviceName = 'omnibridge';
        this.serviceType = 'omnibridge-signal';
        this.port = null;
        this.browser = null;
    }

    /**
     * Publish this machine as an Omnibridge signaling server via mDNS/Bonjour.
     * Call this from the signaling server on startup.
     */
    publishServer(port) {
        this.port = port;
        try {
            this.bonjour.publish({
                name: `${this.serviceName}-server-${Math.random().toString(36).substr(2, 5)}`,
                type: this.serviceType,
                port: port
            });
            logger.info('Published signaling server via mDNS', { port });
        } catch (e) {
            logger.error('Failed to publish mDNS service', { error: e.message });
        }
    }

    /**
     * Browse the network for an Omnibridge signaling server.
     * Returns a Promise that resolves to { host, port } if found,
     * or null if no server is discovered within the timeout.
     * @param {number} timeoutMs - How long to wait for discovery (default 3000ms)
     */
    findServer(timeoutMs = 3000) {
        return new Promise((resolve) => {
            let resolved = false;

            const done = (result) => {
                if (resolved) return;
                resolved = true;
                if (this.browser) {
                    try { this.browser.stop(); } catch (_) {}
                    this.browser = null;
                }
                resolve(result);
            };

            try {
                this.browser = this.bonjour.find({ type: this.serviceType });

                this.browser.on('up', (service) => {
                    if (service.name.startsWith(this.serviceName)) {
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

            // Timeout — no server found on the network
            setTimeout(() => {
                if (!resolved) {
                    logger.info('mDNS discovery timed out, falling back to config');
                    done(null);
                }
            }, timeoutMs);
        });
    }

    /**
     * Legacy start() — publishes and browses simultaneously.
     * Kept for backward compatibility.
     */
    start(port) {
        this.port = port;
        try {
            this.bonjour.publish({
                name: `${this.serviceName}-${Math.random().toString(36).substr(2, 5)}`,
                type: this.serviceType,
                port: this.port
            });

            const browser = this.bonjour.find({ type: this.serviceType });
            browser.on('up', (service) => {
                if (service.name.startsWith(this.serviceName)) {
                    this.emit('deviceFound', {
                        name: service.name,
                        host: service.referer?.address || service.host,
                        port: service.port
                    });
                }
            });
        } catch (e) {
            logger.error('Bonjour discovery failed', { error: e.message });
            logger.warn('Falling back to manual IP mode only');
        }
    }

    stop() {
        try {
            if (this.browser) {
                this.browser.stop();
                this.browser = null;
            }
            this.bonjour.unpublishAll();
            this.bonjour.destroy();
        } catch (_) {}
    }
}

module.exports = Discovery;