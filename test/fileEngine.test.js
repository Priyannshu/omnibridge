const FileEngine = require('../core/fileEngine');
const fs = require('fs');
const path = require('path');

// Mock fs for testing
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  promises: {
    writeFile: jest.fn(),
    readFile: jest.fn(),
    unlink: jest.fn(),
    appendFile: jest.fn(),
    readdir: jest.fn()
  }
}));

describe('FileEngine', () => {
  let fileEngine;

  beforeEach(() => {
    fileEngine = new FileEngine();
    // Clear all mocks before each test
    jest.clearAllMocks();
  });

  test('should initialize with correct directories', () => {
    expect(fileEngine.baseDir).toBeDefined();
    expect(fileEngine.receivedDir).toBeDefined();
  });

  test('should ensure directory exists', () => {
    // Mock fs.existsSync to return false so mkdirSync gets called
    fs.existsSync.mockReturnValue(false);
    
    // Create a new FileEngine instance to trigger directory creation
    const newFileEngine = new FileEngine();
    
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('received_files'),
      { recursive: true }
    );
  });

  test('should save temp file', async () => {
    const testFileName = 'test.txt';
    const testData = 'Hello World';
    
    fs.promises.writeFile.mockResolvedValue();
    
    const result = await fileEngine.saveTempFile(testFileName, Buffer.from(testData).toString('base64'));
    expect(result).toContain(testFileName);
  });

  test('should append chunk to file', async () => {
    const testFileName = 'test.txt';
    const testData = 'Hello World';
    
    fs.promises.appendFile.mockResolvedValue();
    fs.existsSync.mockReturnValue(false);
    
    const result = await fileEngine.appendChunk(testFileName, Buffer.from(testData).toString('base64'), true);
    expect(result).toContain(testFileName);
  });

  test('should read file as base64', async () => {
    const testData = 'Hello World';
    
    fs.existsSync.mockReturnValue(true);
    fs.promises.readFile.mockResolvedValue(Buffer.from(testData));
    
    const result = await fileEngine.readFileAsBase64('test.txt');
    expect(result).toBe(Buffer.from(testData).toString('base64'));
  });

  test('should return null for non-existent file', async () => {
    fs.existsSync.mockReturnValue(false);
    
    const result = await fileEngine.readFileAsBase64('nonexistent.txt');
    expect(result).toBeNull();
  });
});