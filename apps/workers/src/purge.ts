import 'dotenv/config';
import { runPurgeOnce } from './retention';

/** Manual retention purge (also scheduled daily in the worker). */
runPurgeOnce().catch((err) => {
  console.error('[retention] failed:', err);
  process.exit(1);
});
