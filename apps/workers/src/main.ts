import 'dotenv/config';
import { createServer } from 'node:http';
import { Worker, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { parseEnvelope } from './parse-envelope';
import { processEnvelope } from './processor';
import { purge } from './retention';
import { recordLatency } from './metrics';
import {
  redisOptions,
  wantsHtml,
  homePage,
  homeJson,
  notFoundPage,
  notFoundJson,
} from '@geniusdebug/shared';

const SHED_THRESHOLD = Number(process.env.QUEUE_SHED_THRESHOLD ?? 5000);

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const connection = new IORedis(REDIS_URL, redisOptions(REDIS_URL));

const INGEST_QUEUE = 'ingest';
const DLQ = 'ingest-dead';

interface BlobPointer {
  type: string;
  r2Key: string;
  size: number;
  filename?: string;
}
interface IngestJob {
  projectId: string;
  envelopeB64: string;
  eventId?: string;
  receivedAt: string;
  blobs?: BlobPointer[];
}

/** Dead-letter queue for poison events (FR-WRK-1 / NFR-REL-1). */
const dlq = new Queue(DLQ, { connection });

const ingestQueue = new Queue(INGEST_QUEUE, { connection });

const worker = new Worker<IngestJob>(
  INGEST_QUEUE,
  async (job) => {
    const started = Date.now();
    const bytes = Buffer.from(job.data.envelopeB64, 'base64');
    const parsed = parseEnvelope(bytes);
    // Back-pressure: shed low-value items when the queue is deep (FR-WRK-4).
    const waiting = await ingestQueue.getWaitingCount().catch(() => 0);
    await processEnvelope(job.data.projectId, parsed, { shedLowValue: waiting > SHED_THRESHOLD, blobs: job.data.blobs });
    await recordLatency(Date.now() - started).catch(() => {});
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

/* --------------------- Tiny HTTP face (home / health / 404) ---------------- */
// The workers process is a pure BullMQ consumer, but hosting platforms (Coolify)
// and humans still hit its URL. Serve a branded home + a real /health probe;
// browsers get HTML, everything else JSON. No app logic runs here.
const WORKERS_PORT = Number(process.env.WORKERS_PORT ?? 4003);
createServer((req, res) => {
  const html = wantsHtml(req.headers.accept);
  const url = (req.url ?? '/').split('?')[0];
  if (url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ service: 'workers', status: 'ok' }));
  }
  if (url === '/') {
    if (html) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(homePage('workers'));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(homeJson('workers')));
  }
  if (html) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(notFoundPage('workers'));
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  return res.end(JSON.stringify(notFoundJson('workers')));
}).listen(WORKERS_PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[workers] http face on :${WORKERS_PORT}`);
});

