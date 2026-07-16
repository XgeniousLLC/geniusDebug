import 'dotenv/config';
import { Worker, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { parseEnvelope } from './parse-envelope';
import { processEnvelope } from './processor';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

const INGEST_QUEUE = 'ingest';
const DLQ = 'ingest-dead';

interface IngestJob {
  projectId: string;
  envelopeB64: string;
  eventId?: string;
  receivedAt: string;
}

/** Dead-letter queue for poison events (FR-WRK-1 / NFR-REL-1). */
const dlq = new Queue(DLQ, { connection });

const worker = new Worker<IngestJob>(
  INGEST_QUEUE,
  async (job) => {
    const bytes = Buffer.from(job.data.envelopeB64, 'base64');
    const parsed = parseEnvelope(bytes);
    await processEnvelope(job.data.projectId, parsed);
  },
  {
    connection,
    concurrency: 8, // FR-WRK-1
  },
);

worker.on('completed', (job) => {
  // eslint-disable-next-line no-console
  console.log(`[worker] processed ${job.id}`);
});

worker.on('failed', async (job, err) => {
  // eslint-disable-next-line no-console
  console.error(`[worker] job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message);
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    // Exhausted retries → dead-letter, never block the pipeline.
    await dlq.add('dead', { ...job.data, error: err.message }, { removeOnComplete: false });
    // eslint-disable-next-line no-console
    console.error(`[worker] → dead-lettered ${job.id}`);
  }
});

// eslint-disable-next-line no-console
console.log('[worker] consuming queue "ingest" (concurrency 8)');
