const crypto = require('crypto');
const KeyExchange = require('./keyExchange');
const createLogger = require('./loggerFactory');

// Create logger instance
const logger = createLogger({ appName: 'Omnibridge-SecureChannel' });

class SecureChannel {
    constructor(secret) {
        this.algorithm = 'aes-256-gcm';
        this.key = null;
        this.keyExchange = new KeyExchange();
        
        // For backward compatibility, use the static key if no Diffie-Hellman exchange
        if (secret) {
            this.key = crypto.scryptSync(secret, 'salt', 32);
        }
    }

    // Initialize Diffie-Hellman key exchange
    async initializeKeyExchange() {
        // Generate Diffie-Hellman parameters and key pair
        const params = this.keyExchange.generateParameters();
        const publicKey = this.keyExchange.generateKeyPair();
        
        return {
            type: 'key-exchange-init',
            publicKey: publicKey.toString('hex'),
            prime: params.prime.toString('hex'),
            generator: params.generator.toString('hex')
        };
    }

    // Complete key exchange (called by receiver).
    // Accepts the full key-exchange-init message, sets DH params, generates
    // this peer's key pair, computes shared secret, and returns own public key
    // so the caller can send it back to the initiator.
    completeKeyExchange(initMessage) {
        const prime     = Buffer.from(initMessage.prime,     'hex');
        const generator = Buffer.from(initMessage.generator, 'hex');
        const otherPub  = Buffer.from(initMessage.publicKey, 'hex');

        this.keyExchange.setParameters(prime, generator);
        this.keyExchange.generateKeyPair();
        const sharedSecret = this.keyExchange.generateSharedSecret(otherPub);
        this.key = crypto.scryptSync(sharedSecret, 'key-exchange', 32);

        return this.keyExchange.publicKey.toString('hex');
    }

    // Compute shared secret (called by initiator after receiving receiver's public key).
    computeSharedSecret(otherPublicKeyHex) {
        const otherPub     = Buffer.from(otherPublicKeyHex, 'hex');
        const sharedSecret = this.keyExchange.generateSharedSecret(otherPub);
        this.key = crypto.scryptSync(sharedSecret, 'key-exchange', 32);
    }

    // Fallback to static key if needed
    setStaticKey(secret) {
        this.key = crypto.scryptSync(secret, 'salt', 32);
    }

    encrypt(text) {
        if (!this.key) {
            throw new Error('No encryption key available. Run key exchange first.');
        }
        
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag().toString('hex');
        return JSON.stringify({
            iv: iv.toString('hex'),
            content: encrypted,
            tag: authTag
        });
    }

    decrypt(json) {
        if (!this.key) {
            throw new Error('No decryption key available. Run key exchange first.');
        }
        
        try {
            const { iv, content, tag } = JSON.parse(json);
            const decipher = crypto.createDecipheriv(this.algorithm, this.key, Buffer.from(iv, 'hex'));
            decipher.setAuthTag(Buffer.from(tag, 'hex'));
            let decrypted = decipher.update(content, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (e) {
            logger.error('Decryption failed', { error: e.message });
            return null;
        }
    }
}

module.exports = SecureChannel;