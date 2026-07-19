import { describe, expect, it } from 'vitest';
import {
  isModelCredentialConfigured,
  sanitizeModelEndpoint,
} from '../../src/model/credentials.js';

describe('model credential diagnostics', () => {
  it('treats empty and template credentials as unconfigured', () => {
    expect(isModelCredentialConfigured(undefined)).toBe(false);
    expect(isModelCredentialConfigured('  ')).toBe(false);
    expect(isModelCredentialConfigured('your-api-key')).toBe(false);
    expect(isModelCredentialConfigured('sk-real-value')).toBe(true);
  });

  it('removes URL credentials and redacts sensitive query parameters', () => {
    const endpoint = sanitizeModelEndpoint(
      'https://user:password@example.test/v1?api_key=secret&region=cn',
    );

    expect(endpoint).toContain('https://example.test/v1');
    expect(endpoint).toContain('api_key=%5Bredacted%5D');
    expect(endpoint).toContain('region=cn');
    expect(endpoint).not.toContain('user');
    expect(endpoint).not.toContain('password');
    expect(endpoint).not.toContain('secret');
  });
});
