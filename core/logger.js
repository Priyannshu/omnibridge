const fs = require('fs');
const path = require('path');

// Log levels in order of priority
const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
};

class Logger {
  constructor(options = {}) {
    this.level = options.level || 'INFO';
    this.fileOutput = options.fileOutput || null;
    this.consoleOutput = options.consoleOutput !== false; // default to true
    this.appName = options.appName || 'Omnibridge';
    
    // Create log directory if needed
    if (this.fileOutput) {
      const logDir = path.dirname(this.fileOutput);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
    }
  }

  // Get numeric value for log level
  _getLevelValue(level) {
    return LOG_LEVELS[level] !== undefined ? LOG_LEVELS[level] : -1;
  }

  // Check if we should log based on current level
  _shouldLog(level) {
    const currentLevelValue = this._getLevelValue(this.level);
    const messageLevelValue = this._getLevelValue(level);
    return messageLevelValue <= currentLevelValue;
  }

  // Format log message
  _formatMessage(level, message, metadata = {}) {
    const timestamp = new Date().toISOString();
    const formattedMetadata = Object.keys(metadata).length > 0 
      ? ` ${JSON.stringify(metadata)}` 
      : '';
    
    return `[${timestamp}] [${this.appName}] [${level}] ${message}${formattedMetadata}`;
  }

  // Write log to file
  _writeToFile(message) {
    if (this.fileOutput) {
      try {
        fs.appendFileSync(this.fileOutput, message + '\n');
      } catch (error) {
        console.error('Failed to write to log file:', error);
      }
    }
  }

  // Log message
  _log(level, message, metadata) {
    if (!this._shouldLog(level)) {
      return;
    }

    const formattedMessage = this._formatMessage(level, message, metadata);
    
    // Console output
    if (this.consoleOutput) {
      console.log(formattedMessage);
    }
    
    // File output
    if (this.fileOutput) {
      this._writeToFile(formattedMessage);
    }
  }

  // Public logging methods
  error(message, metadata = {}) {
    this._log('ERROR', message, metadata);
  }

  warn(message, metadata = {}) {
    this._log('WARN', message, metadata);
  }

  info(message, metadata = {}) {
    this._log('INFO', message, metadata);
  }

  debug(message, metadata = {}) {
    this._log('DEBUG', message, metadata);
  }
}

module.exports = Logger;