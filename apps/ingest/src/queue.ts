import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { redisOptions } from '@geniusdebug/shared';

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/** BullMQ requires maxRetriesPerRequest: null; rediss:// → accept self-signed cert. */
export const connection = new IORedis(REDIS_URL, redisOptions(REDIS_URL));

export const INGEST_QUEUE = 'ingest';

/** Single shared queue; workers consume from it (FR-ING-3 → FR-WRK-1). */
export const ingestQueue = new Queue(INGEST_QUEUE, { connection });

export interface BlobPointer {
  type: string;
  r2Key: string;
  size: number;
  filename?: string;
}

export interface IngestJob {
  projectId: string;
  /** base64 of the raw (already gunzipped) envelope bytes — oversized blobs removed. */
  envelopeB64: string;
  eventId?: string;
  receivedAt: string;
  /** Pointers to oversized replay/attachment blobs streamed to R2 (FR-ING-4). */
  blobs?: BlobPointer[];
}
