const crypto = require('crypto');

class KeyExchange {
    constructor() {
        this.prime     = null;
        this.generator = null;
        this.privateKey = null;
        this.publicKey  = null;
        this._dh        = null; // keep the live DH instance for computeSecret
    }

    // Generate Diffie-Hellman parameters
    generateParameters() {
        const dh = crypto.createDiffieHellmanGroup('modp14');
        this.prime     = dh.getPrime();
        this.generator = dh.getGenerator();
        return { prime: this.prime, generator: this.generator };
    }

    // Set DH parameters received from the initiating peer
    setParameters(prime, generator) {
        this.prime     = prime;
        this.generator = generator;
    }

    // Generate key pair — stores the live DH instance so computeSecret works later
    generateKeyPair() {
        const dh = crypto.createDiffieHellman(this.prime, this.generator);
        dh.generateKeys();
        this._dh        = dh;
        this.privateKey = dh.getPrivateKey();
        this.publicKey  = dh.getPublicKey();
        return this.publicKey;
    }

    // Generate shared secret using the live DH instance
    generateSharedSecret(otherPublicKey) {
        if (!this._dh) throw new Error('KeyExchange: generateKeyPair() must be called first');
        return this._dh.computeSecret(otherPublicKey);
    }

    // Get the public key
    getPublicKey() {
        return this.publicKey;
    }
}

module.exports = KeyExchange;