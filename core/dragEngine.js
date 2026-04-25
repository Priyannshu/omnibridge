const path = require('path');
const fs = require('fs');
const os = require('os');
const FileEngine = require('./fileEngine');
const createLogger = require('./loggerFactory');

// Create logger instance
const logger = createLogger({ appName: 'Omnibridge-DragEngine' });

let addon;
try {
    addon = require('../native/build/Release/omnibridge_dragdrop.node');
} catch (e) {
    logger.warn('Native drag-drop addon not compiled. Falling back to stub mode', { error: e.message });
    addon = {
        registerEdgeTarget: () => {},
        startDrag: () => {}
    };
}

class DragEngine {
    constructor(wsClient, fileEngine) {
        this.wsClient  = wsClient;
        this.fileEngine = fileEngine; // shared singleton, avoids requiring electron app per-drag
        this.isReceiving   = false;
        this.dragSessionId = null;
        this.receivedFiles = [];
        this.tempDir = path.join(os.tmpdir(), 'OmnibridgeDrag');

        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    registerEdgeWindow(hwndBuffer, onDragCrossed) {
        try {
            addon.registerEdgeTarget(hwndBuffer, (files) => {
                if (!files || files.length === 0) return;
                
                logger.info('Drag crossed edge', { files: files });
                const sessionId = Date.now().toString();
                
                const metadata = files.map(file => {
                    try {
                        const stats = fs.statSync(file);
                        return {
                            name:        path.basename(file),
                            path:        file,
                            size:        stats.size,
                            isDirectory: stats.isDirectory()
                        };
                    } catch (e) {
                        logger.warn('Cannot stat dragged file', { file, error: e.message });
                        return null;
                    }
                }).filter(Boolean);
                
                this.wsClient.sendEvent({
                    type: 'drag-start',
                    sessionId,
                    files: metadata
                });
                
                this.streamFiles(files, sessionId);
                
                if (onDragCrossed) onDragCrossed();
            });
        } catch (e) {
            logger.error('Failed to register edge target', { error: e.message });
        }
    }

    async streamFiles(files, sessionId) {
        for (const file of files) {
            const fileName = path.basename(file);
            try {
                const base64 = await this.fileEngine.readFileAsBase64(file);
                if (base64) {
                    // Await sendChunked so drag-ready only fires after all chunks are sent
                    await this.wsClient.sendChunked('drag-file-chunk', { sessionId, fileName, data: base64 }, (progress) => {
                        logger.info('Streaming file', { fileName, progress: Math.round(progress * 100) });
                    });
                }
            } catch (err) {
                logger.error('Failed to stream file', { fileName, error: err.message });
            }
        }

        this.wsClient.sendEvent({ type: 'drag-ready', sessionId });
    }

    handleDragStartEvent(event) {
        logger.info('Received drag start from remote');
        this.dragSessionId = event.sessionId;
        this.isReceiving = true;
        this.receivedFiles = [];
        
        if (fs.existsSync(this.tempDir)) {
            fs.rmSync(this.tempDir, { recursive: true, force: true });
        }
        fs.mkdirSync(this.tempDir, { recursive: true });
    }

    async handleDragFileChunk(event) {
        if (!this.isReceiving || event.sessionId !== this.dragSessionId) return;
        
        const isFirst = event.chunkIndex === 0;
        const tempPath = path.join(this.tempDir, event.fileName);
        
        const buffer = Buffer.from(event.data, 'base64');
        if (isFirst) {
            fs.writeFileSync(tempPath, buffer);
        } else {
            fs.appendFileSync(tempPath, buffer);
        }

        if (event.chunkIndex === event.totalChunks - 1) {
            this.receivedFiles.push(tempPath);
        }
    }

    handleDragReady(event) {
        if (event.sessionId === this.dragSessionId) {
            logger.info('All files ready. Triggering native DoDragDrop...');
            try {
                addon.startDrag(this.receivedFiles, () => {
                    logger.info('Drag drop operation finished natively');
                    this.isReceiving = false;
                    this.dragSessionId = null;
                });
            } catch (e) {
                logger.error('Failed to trigger startDrag', { error: e.message });
            }
        }
    }
}

module.exports = DragEngine;
