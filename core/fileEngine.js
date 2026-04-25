const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const crypto = require('crypto');
const createLogger = require('./loggerFactory');

// Create logger instance
const logger = createLogger({ appName: 'Omnibridge-FileEngine' });

class FileEngine {
    constructor() {
        this.baseDir = app.getPath('userData');
        this.receivedDir = path.join(this.baseDir, 'received_files');
        this._ensureDir(this.receivedDir);
    }

    _ensureDir(dir) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            logger.info('Created directory', { directory: dir });
        }
    }

    async saveTempFile(fileName, base64Data) {
        const filePath = path.join(this.receivedDir, fileName);
        await fs.promises.writeFile(filePath, Buffer.from(base64Data, 'base64'));
        logger.info('Saved temp file', { fileName, filePath });
        return filePath;
    }

    // New: Append chunk to a growing file with integrity verification
    async appendChunk(fileName, base64Data, isFirst, expectedChecksum) {
        const filePath = path.join(this.receivedDir, fileName);
        if (isFirst && fs.existsSync(filePath)) {
            await fs.promises.unlink(filePath); // Clear existing
            logger.info('Cleared existing file for new transfer', { fileName, filePath });
        }
        
        // Verify checksum against the raw base64 string — matches sender's computation in wsClient.sendChunked
        if (expectedChecksum) {
            const actualChecksum = crypto.createHash('sha256').update(base64Data).digest('hex');
            if (actualChecksum !== expectedChecksum) {
                const error = `Checksum mismatch for chunk: expected ${expectedChecksum}, got ${actualChecksum}`;
                logger.error(error);
                throw new Error(error);
            }
        }
        
        await fs.promises.appendFile(filePath, Buffer.from(base64Data, 'base64'));
        logger.debug('Appended chunk to file', { fileName, filePath });
        return filePath;
    }

    async readFileAsBase64(filePath) {
        if (!fs.existsSync(filePath)) {
            logger.warn('File not found', { filePath });
            return null;
        }
        const data = await fs.promises.readFile(filePath);
        logger.debug('Read file as base64', { filePath });
        return data.toString('base64');
    }

    async listFiles(dirPath = '') {
        const fullPath = path.join(this.receivedDir, dirPath);
        logger.debug('Listing files', { directory: fullPath });
        return fs.promises.readdir(fullPath);
    }
}

module.exports = FileEngine;