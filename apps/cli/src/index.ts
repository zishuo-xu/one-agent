import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { AgentLoop, config } from '@one-agent/agent-core';

const WELCOME = `
🤖 One Agent CLI
Model: ${config.model}
Type your message and press Enter. Use /exit or /quit to leave.
`;

export async function runRepl(): Promise<void> {
  console.log(WELCOME);

  const rl = readline.createInterface({ input, output });
  const agent = new AgentLoop();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const userInput = await rl.question('You: ');
    const trimmed = userInput.trim();

    if (!trimmed) continue;
    if (trimmed === '/exit' || trimmed === '/quit') {
      console.log('Bye!');
      rl.close();
      return;
    }

    if (trimmed === '/history') {
      console.log('\n--- History ---');
      for (const msg of agent.getHistory()) {
        console.log(`${msg.role}: ${msg.content}`);
      }
      console.log('---\n');
      continue;
    }

    try {
      const reply = await agent.chat(trimmed);
      console.log(`\nAgent: ${reply}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\nError: ${message}\n`);
    }
  }
}

runRepl().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
