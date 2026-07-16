import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/** BullMQ requires maxRetriesPerRequest: null for blocking connections. */
export const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

export const INGEST_QUEUE = 'ingest';

/** Single shared queue; workers consume from it (FR-ING-3 → FR-WRK-1). */
export const ingestQueue = new Queue(INGEST_QUEUE, { connection });

export interface IngestJob {
  projectId: string;
  /** base64 of the raw (already gunzipped) envelope bytes. */
  envelopeB64: string;
  eventId?: string;
  receivedAt: string;
}
