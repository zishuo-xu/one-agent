import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Sandbox } from '../../src/tools/sandbox.js';
import {
  createReadFileTool,
  createWriteFileTool,
  createListFilesTool,
} from '../../src/tools/built-in/index.js';

describe('built-in file tools', () => {
  let root: string;
  let sandbox: Sandbox;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-tools-test-')));
    sandbox = new Sandbox(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('read_file returns file content', () => {
    fs.writeFileSync(path.join(root, 'hello.txt'), 'Hello World', 'utf-8');
    const tool = createReadFileTool(sandbox);

    const result = tool.execute({ path: 'hello.txt' });

    expect(result).toEqual({ content: 'Hello World' });
  });

  it('read_file rejects non-text files', () => {
    fs.writeFileSync(path.join(root, 'data.bin'), 'binary', 'utf-8');
    const tool = createReadFileTool(sandbox);

    expect(() => tool.execute({ path: 'data.bin' })).toThrow('Only text files are allowed');
  });

  it('read_file throws when file missing', () => {
    const tool = createReadFileTool(sandbox);
    expect(() => tool.execute({ path: 'missing.txt' })).toThrow('File not found: missing.txt');
  });

  it('write_file creates file and returns metadata', () => {
    const tool = createWriteFileTool(sandbox);

    const result = tool.execute({ path: 'notes.md', content: '# Notes' });

    expect(result).toEqual({ path: 'notes.md', bytes: 7 });
    expect(fs.readFileSync(path.join(root, 'notes.md'), 'utf-8')).toBe('# Notes');
  });

  it('write_file creates parent directories', () => {
    const tool = createWriteFileTool(sandbox);

    tool.execute({ path: 'dir/nested/file.txt', content: 'nested' });

    expect(fs.existsSync(path.join(root, 'dir/nested/file.txt'))).toBe(true);
  });

  it('list_files returns workspace entries', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'a', 'utf-8');
    fs.mkdirSync(path.join(root, 'folder'));
    const tool = createListFilesTool(sandbox);

    const result = tool.execute({ path: '' });

    expect(result).toEqual({
      path: '',
      files: expect.arrayContaining(['a.txt', 'folder/']),
    });
  });
});
