import 'dotenv/config';
import { Worker, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { parseEnvelope } from './parse-envelope';
import { processEnvelope } from './processor';
import { purge } from './retention';

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

/* ------------------------- Retention purge (FR-RET-1) ---------------------- */
const RETENTION_QUEUE = 'retention';
const retentionQueue = new Queue(RETENTION_QUEUE, { connection });

new Worker(
  RETENTION_QUEUE,
  async () => {
    const res = await purge();
    // eslint-disable-next-line no-console
    console.log(`[retention] purged events=${res.events} replays=${res.replays} maps=${res.maps}`);
  },
  { connection },
);

// Schedule a daily purge (idempotent repeatable job).
retentionQueue.add('daily', {}, { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: 'retention-daily' }).catch(() => {});

