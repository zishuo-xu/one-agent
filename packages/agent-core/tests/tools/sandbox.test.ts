import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Sandbox } from '../../src/tools/sandbox.js';

describe('Sandbox', () => {
  it('resolves relative paths inside workspace', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-test-')));
    const sandbox = new Sandbox(root);

    expect(sandbox.resolve('notes.txt')).toBe(path.join(root, 'notes.txt'));
    expect(sandbox.resolve('dir/file.md')).toBe(path.join(root, 'dir', 'file.md'));

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects path traversal', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-test-'));
    const sandbox = new Sandbox(root);

    expect(() => sandbox.resolve('../secret.txt')).toThrow('Path traversal is not allowed');

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates workspace directory if missing', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-test-')));
    fs.rmSync(root, { recursive: true, force: true });

    const sandbox = new Sandbox(root);
    expect(fs.existsSync(root)).toBe(true);
    expect(sandbox.rootPath).toBe(root);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('identifies text files by extension', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-test-'));
    const sandbox = new Sandbox(root);

    expect(sandbox.isTextFile('file.txt')).toBe(true);
    expect(sandbox.isTextFile('file.md')).toBe(true);
    expect(sandbox.isTextFile('file.ts')).toBe(true);
    expect(sandbox.isTextFile('file.json')).toBe(true);
    expect(sandbox.isTextFile('file.exe')).toBe(false);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
