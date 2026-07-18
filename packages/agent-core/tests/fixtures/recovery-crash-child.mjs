import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  AgentLoop,
  ToolRegistry,
  ThreadStore,
  createConnection,
} from '../../dist/index.js';

const [phase, scenario, dbPath, workspace, resumeRunId] = process.argv.slice(2);
const threadId = `crash-${scenario}`;

class CrashHarnessProvider {
  name = 'crash-harness';
  model = 'deterministic';

  async complete(request) {
    const systemText = String(request.messages[0]?.content ?? '');
    if (systemText.includes('planning assistant')) {
      const toolName = scenario === 'write' ? 'write_file' : 'read_file';
      return {
        content: JSON.stringify({
          reasoning: `Exercise ${scenario} recovery`,
          steps: [{
            id: '1',
            description: `Execute ${toolName}`,
            toolName,
            expectedOutcome: 'The controlled operation completes once.',
          }],
        }),
      };
    }

    assertToolCallsPaired(request.messages);
    if (phase === 'initial' && scenario === 'model') {
      await hangUntilKilled();
    }

    const toolName = scenario === 'write' ? 'write_file' : 'read_file';
    const argumentsJson = scenario === 'write'
      ? JSON.stringify({ path: 'result.txt', content: 'written-once' })
      : JSON.stringify({ path: 'input.txt' });
    return {
      content: `Calling ${toolName}.`,
      toolCalls: [{ id: `${scenario}-tool-call`, name: toolName, arguments: argumentsJson }],
    };
  }

  async *stream() {
    yield { content: `${scenario} recovery completed` };
  }
}

function assertToolCallsPaired(messages) {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== 'assistant' || !message.tool_calls) continue;
    for (const call of message.tool_calls) {
      const paired = messages.slice(i + 1).some(
        (candidate) => candidate.role === 'tool' && candidate.tool_call_id === call.id,
      );
      if (!paired) throw new Error(`Unpaired historical tool call: ${call.id}`);
    }
  }
}

function createTools() {
  const tools = new ToolRegistry();
  tools.register({
    name: 'read_file',
    description: 'Controlled read for crash recovery tests',
    parameters: z.object({ path: z.string() }),
    execute: async ({ path: relativePath }) => {
      fs.appendFileSync(path.join(workspace, 'read-count.txt'), 'read\n');
      if (phase === 'initial' && scenario === 'read') await hangUntilKilled();
      return { content: fs.readFileSync(path.join(workspace, relativePath), 'utf8') };
    },
  });
  tools.register({
    name: 'write_file',
    description: 'Controlled write for crash recovery tests',
    parameters: z.object({ path: z.string(), content: z.string() }),
    execute: async ({ path: relativePath, content }) => {
      fs.appendFileSync(path.join(workspace, 'write-count.txt'), 'write\n');
      fs.writeFileSync(path.join(workspace, relativePath), content, 'utf8');
      if (phase === 'initial' && scenario === 'write') await hangUntilKilled();
      return { written: true };
    },
  });
  return tools;
}

function hangUntilKilled() {
  return new Promise(() => {
    setInterval(() => {}, 1_000);
  });
}

async function main() {
  fs.mkdirSync(workspace, { recursive: true });
  const inputPath = path.join(workspace, 'input.txt');
  if (!fs.existsSync(inputPath)) fs.writeFileSync(inputPath, 'fixture input', 'utf8');

  const db = createConnection({ path: dbPath });
  const threadStore = new ThreadStore(db);
  if (!threadStore.getById(threadId)) threadStore.create({ id: threadId });
  const agent = new AgentLoop({
    threadId,
    db,
    tools: createTools(),
    modelProvider: new CrashHarnessProvider(),
    enablePlanning: true,
    subAgents: false,
  });

  try {
    const result = phase === 'resume'
      ? await agent.resumeRun(resumeRunId)
      : await agent.chat(`Run the ${scenario} crash scenario`);
    console.log(JSON.stringify({ ok: true, runId: result.runId, reply: result.reply }));
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  } finally {
    db.close();
  }
}

await main();
