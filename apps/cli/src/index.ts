import './load-env.js';
import { runRepl } from './repl.js';

runRepl().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
