import { describe, it, expect } from 'vitest';
import { config } from '../src/config.js';

describe('config', () => {
  it('has default values', () => {
    expect(config.port).toBe(3000);
    expect(config.host).toBe('127.0.0.1');
    expect(config.model).toBeDefined();
    expect(config.systemPrompt).toBeDefined();
    expect(config.openai).toBeDefined();
  });
});
