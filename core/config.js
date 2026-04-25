const fs = require('fs');
const path = require('path');
const os = require('os');

class Config {
  constructor() {
    this.config = this.loadConfig();
  }

  /**
   * Auto-detect the primary LAN IPv4 address.
   * Skips virtual/internal adapters and prefers 192.168.x.x / 10.x.x.x ranges.
   */
  static getLanIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        // Skip internal (loopback) and non-IPv4
        if (iface.internal || iface.family !== 'IPv4') continue;
        // Prefer common LAN ranges (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
        if (iface.address.startsWith('192.168.') ||
            iface.address.startsWith('10.') ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(iface.address)) {
          return iface.address;
        }
      }
    }
    // Fallback: return the first non-internal IPv4 found
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (!iface.internal && iface.family === 'IPv4') return iface.address;
      }
    }
    return '127.0.0.1';
  }

  loadConfig() {
    try {
      const configPath = path.join(__dirname, '..', 'config', 'omnibridge.json');
      if (fs.existsSync(configPath)) {
        const configFile = fs.readFileSync(configPath, 'utf8');
        return JSON.parse(configFile);
      } else {
        // Return default config if file doesn't exist
        return {
          server: {
            host: "auto",
            port: 8080,
            secret: "super-secret-key"
          },
          display: {
            width: 1000,
            height: 800
          }
        };
      }
    } catch (error) {
      console.error('Error loading config:', error);
      return {
        server: { host: 'auto', port: 8080, secret: 'super-secret-key' },
        display: { width: 1000, height: 800 }
      };
    }
  }

  get() {
    const cfg = { ...this.config };
    // Resolve "auto" host to the actual LAN IP at runtime
    if (cfg.server && cfg.server.host === 'auto') {
      cfg.server = { ...cfg.server, host: Config.getLanIP() };
    }
    return cfg;
  }
}

module.exports = Config;