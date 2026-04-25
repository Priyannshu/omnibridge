const Logger = require('./logger');
const path = require('path');
const { app } = require('electron');

// Logger factory function
function createLogger(options = {}) {
  // Default log file path in user data directory
  let logFilePath = null;
  try {
    const userDataPath = app.getPath('userData');
    logFilePath = path.join(userDataPath, 'logs', 'omnibridge.log');
  } catch (error) {
    // Fallback if app is not available (e.g., in tests)
    logFilePath = './logs/omnibridge.log';
  }

  // Merge default options with provided options
  const loggerOptions = {
    level: 'INFO',
    fileOutput: logFilePath,
    consoleOutput: true,
    appName: 'Omnibridge',
    ...options
  };

  return new Logger(loggerOptions);
}

module.exports = createLogger;