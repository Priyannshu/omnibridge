// lib/transfer.js — File transfer with ASCII progress bar
const fs = require('fs');
const path = require('path');

class Transfer {
    /**
     * Send a file via the bridge, printing an in-place ASCII progress bar.
     * @param {string} filePath - absolute path to file
     * @param {Bridge} bridge - bridge instance
     * @param {FileEngine} fileEngine - file engine for reading
     * @param {Function} log - function(text, color) for normal log lines
     * @param {object} pc - picocolors instance for coloring
     */
    static async send(filePath, bridge, fileEngine, log, pc) {
        if (!fs.existsSync(filePath)) {
            log(`[transfer]  File not found: ${filePath}`, 'error');
            return;
        }

        const fileName = path.basename(filePath);
        const stats = fs.statSync(filePath);
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
        const target = bridge.connectedDevice ? bridge.connectedDevice.name : 'peer';

        log(`[transfer]  File queued: ${fileName} (${sizeMB} MB)`, 'info');
        log(`[transfer]  Encrypting... AES-256`, 'info');
        log(`[transfer]  Sending → ${target}`, 'info');

        try {
            await bridge.sendFile(filePath, fileEngine, (name, progress) => {
                Transfer.drawProgress(progress, pc);
            });
            // Final 100% line
            Transfer.drawProgress(1, pc);
            // Move to next line after progress bar completes
            process.stdout.write('\n');
            log(`[transfer]  ✓ Transfer complete: ${fileName}`, 'success');
        } catch (err) {
            process.stdout.write('\n');
            log(`[transfer]  ✗ Transfer failed: ${err.message}`, 'error');
        }
    }

    /**
     * Draw an ASCII progress bar that overwrites the current line.
     * @param {number} progress - 0 to 1
     * @param {object} pc - picocolors instance
     */
    static drawProgress(progress, pc) {
        const pct = Math.round(progress * 100);
        const filled = Math.round(pct / 5);
        const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
        const label = pct >= 100 ? 'Transfer complete' : `${pct}%`;
        const colorFn = pct >= 100 ? pc.green : pc.cyan;
        process.stdout.write(`\r${colorFn(`[transfer]  ${bar} ${label}`)}`);
    }
}

module.exports = Transfer;
