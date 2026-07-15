// One-off migration: dump TS scenario definitions to JSON dataset files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtInEvalTasks, realModelBenchmarkTasks } from '../packages/agent-core/src/eval/scenarios/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const outRoot = path.join(here, '..', 'packages', 'agent-core', 'eval-datasets');

const realIds = new Set(realModelBenchmarkTasks.map((t) => t.id));
const allTasks = [...builtInEvalTasks];
for (const task of realModelBenchmarkTasks) {
  if (!allTasks.some((t) => t.id === task.id)) allTasks.push(task);
}

let mockCount = 0;
let realCount = 0;
for (const task of allTasks) {
  const subdir = realIds.has(task.id) ? 'real' : 'mock';
  const dir = path.join(outRoot, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${task.id}.json`);
  fs.writeFileSync(file, JSON.stringify(task, null, 2) + '\n', 'utf-8');
  if (subdir === 'real') realCount++;
  else mockCount++;
  console.log(`wrote ${subdir}/${task.id}.json`);
}
console.log(`\nDone: ${mockCount} mock + ${realCount} real = ${allTasks.length} tasks`);
