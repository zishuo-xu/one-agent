import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(projectRoot, 'src');
const outputRoot = path.join(projectRoot, 'dist');
const assets = ['index.html', 'styles.css', 'app.js'];

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });
for (const asset of assets) {
  fs.copyFileSync(path.join(sourceRoot, asset), path.join(outputRoot, asset));
}
