const SecureChannel = require('../core/secureChannel');

describe('SecureChannel', () => {
  const testSecret = 'test-secret-key';
  let secureChannel;

  beforeEach(() => {
    secureChannel = new SecureChannel(testSecret);
  });

  test('should initialize with correct algorithm and key', () => {
    expect(secureChannel.algorithm).toBe('aes-256-gcm');
    expect(secureChannel.key).toBeDefined();
  });

  test('should encrypt and decrypt text correctly', () => {
    const originalText = 'Hello, World!';
    const encrypted = secureChannel.encrypt(originalText);
    const decrypted = secureChannel.decrypt(encrypted);
    
    expect(decrypted).toBe(originalText);
  });

  test('should handle empty string encryption', () => {
    const originalText = '';
    const encrypted = secureChannel.encrypt(originalText);
    const decrypted = secureChannel.decrypt(encrypted);
    
    expect(decrypted).toBe(originalText);
  });

  test('should return null for invalid decryption', () => {
    const invalidJson = 'invalid json string';
    const result = secureChannel.decrypt(invalidJson);
    expect(result).toBeNull();
  });
});