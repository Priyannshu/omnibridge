const Logger = require('./logger');
const path = require('path');
const os = require('os');

// Logger factory function — works in both Electron and pure Node.js environments
function createLogger(options = {}) {
  let logFilePath = null;
  try {
    // Try Electron's app path first
    const { app } = require('electron');
    const userDataPath = app.getPath('userData');
    logFilePath = path.join(userDataPath, 'logs', 'omnibridge.log');
  } catch (_) {
    // Pure Node.js fallback: use ~/.omnibridge/logs/
    logFilePath = path.join(os.homedir(), '.omnibridge', 'logs', 'omnibridge.log');
  }

  // When running under the CLI REPL (index.js sets global.__OMNIBRIDGE_CLI),
  // suppress console output from core loggers — the REPL manages its own stdout.
  // Standalone processes (e.g. signaling server) keep console output on.
  const isCLI = global.__OMNIBRIDGE_CLI === true;

  const loggerOptions = {
    level: 'INFO',
    fileOutput: logFilePath,
    consoleOutput: !isCLI,
    appName: 'Omnibridge',
    ...options
  };

  return new Logger(loggerOptions);
}

module.exports = createLogger;