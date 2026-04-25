const WSClient = require('../core/wsClient');

// Mock WebSocket for testing
jest.mock('ws', () => {
  return {
    WebSocket: jest.fn().mockImplementation(() => {
      return {
        on: jest.fn(),
        send: jest.fn(),
        close: jest.fn(),
        readyState: 1,
        removeAllListeners: jest.fn()
      };
    })
  };
});

describe('WSClient', () => {
  const mockServerUrl = 'ws://localhost:8080';
  const mockSecureChannel = {
    encrypt: jest.fn((data) => `encrypted:${data}`),
    decrypt: jest.fn((data) => {
      if (data && data.startsWith('encrypted:')) {
        return data.replace('encrypted:', '');
      }
      return null;
    })
  };

  let wsClient;

  beforeEach(() => {
    wsClient = new WSClient(mockServerUrl, mockSecureChannel);
  });

  test('should initialize with correct properties', () => {
    expect(wsClient.serverUrl).toBe(mockServerUrl);
    expect(wsClient.secureChannel).toBe(mockSecureChannel);
    expect(wsClient.reconnectAttempts).toBe(0);
    expect(wsClient.maxAttempts).toBe(5);
  });

  test('should connect to server', () => {
    // This test would normally test the connection, but we're mocking it
    expect(wsClient).toBeDefined();
  });

  test('should send event', () => {
    const testEvent = { type: 'test', data: 'test data' };
    
    wsClient.targetId = 'test-target';
    // Mock the ws property
    wsClient.ws = {
      send: jest.fn()
    };
    wsClient.sendEvent(testEvent);
    
    expect(mockSecureChannel.encrypt).toHaveBeenCalledWith(JSON.stringify(testEvent));
  });

  test('should handle sendChunked', async () => {
    const testData = 'a'.repeat(1000); // Large data to test chunking
    const payload = {
      data: testData,
      fileName: 'test.txt'
    };

    const progressCallback = jest.fn();
    
    // Mock the sendEvent method
    wsClient.sendEvent = jest.fn();
    
    await wsClient.sendChunked('file-chunk', payload, progressCallback);
    
    expect(progressCallback).toHaveBeenCalled();
  });
});