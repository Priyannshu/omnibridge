const LayoutEngine = require('../core/layoutEngine');

describe('LayoutEngine', () => {
  let layoutEngine;

  beforeEach(() => {
    layoutEngine = new LayoutEngine();
  });

  test('should initialize with empty systems array', () => {
    expect(layoutEngine.systems).toEqual([]);
    expect(layoutEngine.currentSystemId).toBe('local');
  });

  test('should add system correctly', () => {
    const system = {
      id: 'test-system',
      name: 'Test System',
      position: 'right',
      active: true
    };

    layoutEngine.addSystem(system);
    expect(layoutEngine.systems).toContainEqual(system);
  });

  test('should detect right boundary correctly', () => {
    // Test with 1920x1080 screen
    const result = layoutEngine.checkBoundary(1915, 540, 1920, 1080);
    expect(result).toBe('right');
  });

  test('should detect left boundary correctly', () => {
    // Test with 1920x1080 screen
    const result = layoutEngine.checkBoundary(3, 540, 1920, 1080);
    expect(result).toBe('left');
  });

  test('should return null when not at boundary', () => {
    // Test with cursor in middle of screen
    const result = layoutEngine.checkBoundary(960, 540, 1920, 1080);
    expect(result).toBeNull();
  });

  test('should get next system by boundary', () => {
    const system = {
      id: 'test-system',
      name: 'Test System',
      position: 'right',
      active: true
    };

    layoutEngine.addSystem(system);
    const result = layoutEngine.getNextSystem('right');
    expect(result).toEqual(system);
  });
});