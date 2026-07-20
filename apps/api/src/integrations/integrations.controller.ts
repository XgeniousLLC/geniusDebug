import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  Post,
  Req,
  UseGuards,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import type { Request } from 'express';
import { db, integrations } from '@geniusdebug/db';
import { and, eq } from 'drizzle-orm';
import { JwtGuard, type AuthPrincipal } from '../auth/jwt.guard';
import { encrypt, decrypt } from '../crypto';

const KINDS = ['r2', 'ses', 'deepseek'] as const;
type Kind = (typeof KINDS)[number];

/** Non-secret config keys we accept per kind (everything else is ignored). */
const CONFIG_KEYS: Record<Kind, string[]> = {
  r2: ['endpoint', 'bucket', 'accountId'],
  ses: ['region', 'from', 'fromName'],
  deepseek: ['model'], // AI fix-suggester (FR-AIF); single-key secret
};

/**
 * Service integrations (R2 blob store, AWS SES). Admin-only, org-scoped. Secret
 * material is AES-256-GCM encrypted at rest and NEVER returned to the client —
 * responses only expose non-secret config + a `connected` flag (NFR-SEC-5).
 */
@Controller('integrations')
@UseGuards(JwtGuard)
export class IntegrationsController {
  private assertKind(kind: string): Kind {
    if (!KINDS.includes(kind as Kind)) throw new BadRequestException(`unknown integration "${kind}"`);
    return kind as Kind;
  }
  private assertAdmin(req: Request & { user?: AuthPrincipal }) {
    if (req.user!.role !== 'admin') throw new ForbiddenException('admin only');
  }

  /** Status of every integration kind (no secrets). Admin-only surface. */
  @Get()
  async list(@Req() req: Request & { user?: AuthPrincipal }) {
    this.assertAdmin(req);
    const orgId = req.user!.orgId;
    const rows = await db
      .select({ kind: integrations.kind, config: integrations.config, secretEnc: integrations.secretEnc, isActive: integrations.isActive, updatedAt: integrations.updatedAt })
      .from(integrations)
      .where(eq(integrations.orgId, orgId));
    const byKind = new Map(rows.map((r) => [r.kind, r]));
    return KINDS.map((kind) => {
      const r = byKind.get(kind);
      const envConfigured = kind === 'r2' ? r2EnvSet() : kind === 'ses' ? sesEnvSet() : deepseekEnvSet();
      return {
        kind,
        connected: !!r && r.isActive && !!r.secretEnc,
        source: envConfigured ? 'env' : r ? 'dashboard' : 'none',
        config: (r?.config as Record<string, unknown>) ?? {},
        updatedAt: r?.updatedAt ?? null,
      };
    });
  }

  /** Create/update an integration. Secret fields are optional on update (kept if omitted). */
  @Put(':kind')
  async upsert(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param('kind') kindRaw: string,
    @Body() body: Record<string, unknown>,
  ) {
    this.assertAdmin(req);
    const kind = this.assertKind(kindRaw);
    const orgId = req.user!.orgId;

    const config: Record<string, unknown> = {};
    for (const k of CONFIG_KEYS[kind]) {
      if (body[k] !== undefined && body[k] !== '') config[k] = String(body[k]).trim();
    }

    // Secret fields arrive in plaintext only when the admin (re)enters them.
    // deepseek uses a single API key; r2/ses use an accessKey pair.
    let secretEnc: string | undefined;
    if (kind === 'deepseek') {
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      secretEnc = apiKey ? encrypt(JSON.stringify({ apiKey })) : undefined;
    } else {
      const accessKeyId = typeof body.accessKeyId === 'string' ? body.accessKeyId.trim() : '';
      const secretAccessKey = typeof body.secretAccessKey === 'string' ? body.secretAccessKey.trim() : '';
      secretEnc = accessKeyId && secretAccessKey ? encrypt(JSON.stringify({ accessKeyId, secretAccessKey })) : undefined;
    }
    const missingSecretMsg =
      kind === 'deepseek' ? 'apiKey is required' : 'accessKeyId and secretAccessKey are required';

    // Per-kind required non-secret fields.
    if (kind === 'r2' && (!config.endpoint || !config.bucket)) {
      throw new BadRequestException('endpoint and bucket are required');
    }
    if (kind === 'ses' && !config.from) {
      throw new BadRequestException('from address is required');
    }

    const existing = await db
      .select({ id: integrations.id, secretEnc: integrations.secretEnc })
      .from(integrations)
      .where(and(eq(integrations.orgId, orgId), eq(integrations.kind, kind)))
      .limit(1);

    if (existing.length === 0) {
      if (!secretEnc) throw new BadRequestException(missingSecretMsg);
      await db.insert(integrations).values({ orgId, kind, config, secretEnc, isActive: true });
    } else {
      const finalSecret = secretEnc ?? existing[0].secretEnc;
      if (!finalSecret) throw new BadRequestException(missingSecretMsg);
      await db
        .update(integrations)
        .set({ config, secretEnc: finalSecret, isActive: true, updatedAt: new Date() })
        .where(eq(integrations.id, existing[0].id));
    }
    return { ok: true };
  }

  /** Disconnect (delete) an integration. */
  @Delete(':kind')
  @HttpCode(204)
  async remove(@Req() req: Request & { user?: AuthPrincipal }, @Param('kind') kindRaw: string) {
    this.assertAdmin(req);
    const kind = this.assertKind(kindRaw);
    await db.delete(integrations).where(and(eq(integrations.orgId, req.user!.orgId), eq(integrations.kind, kind)));
  }

  /** Live connection test against the saved credentials. Never leaks the secret. */
  @Post(':kind/test')
  async test(@Req() req: Request & { user?: AuthPrincipal }, @Param('kind') kindRaw: string) {
    this.assertAdmin(req);
    const kind = this.assertKind(kindRaw);
    const orgId = req.user!.orgId;

    const rows = await db
      .select({ config: integrations.config, secretEnc: integrations.secretEnc })
      .from(integrations)
      .where(and(eq(integrations.orgId, orgId), eq(integrations.kind, kind)))
      .limit(1);
    if (rows.length === 0 || !rows[0].secretEnc) return { ok: false, error: 'not configured — save credentials first' };

    let secret: { accessKeyId?: string; secretAccessKey?: string; apiKey?: string };
    try {
      secret = JSON.parse(decrypt(rows[0].secretEnc));
    } catch {
      return { ok: false, error: 'stored credentials could not be decrypted (encryption key changed?)' };
    }
    const config = rows[0].config as Record<string, string>;

    try {
      if (kind === 'deepseek') {
        const res = await fetch('https://api.deepseek.com/models', {
          headers: { authorization: `Bearer ${secret.apiKey}` },
        });
        if (!res.ok) return { ok: false, error: `DeepSeek ${res.status} — check the API key` };
        return { ok: true, detail: 'DeepSeek API key valid' };
      }
      if (kind === 'r2') {
        const { S3Client, ListObjectsV2Command, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
        const c = new S3Client({
          region: 'auto',
          endpoint: config.endpoint,
          credentials: { accessKeyId: secret.accessKeyId ?? '', secretAccessKey: secret.secretAccessKey ?? '' },
        });
        // Read test — verify bucket is reachable.
        await c.send(new ListObjectsV2Command({ Bucket: config.bucket, MaxKeys: 1 }));
        // Write test — upload a small file, read it back, delete it.
        const testKey = `__gd_test_${Date.now()}.txt`;
        const testBody = Buffer.from('geniusDebug R2 write test');
        await c.send(new PutObjectCommand({ Bucket: config.bucket, Key: testKey, Body: testBody, ContentType: 'text/plain' }));
        const obj = await c.send(new GetObjectCommand({ Bucket: config.bucket, Key: testKey }));
        const chunks: Buffer[] = [];
        for await (const chunk of obj.Body as AsyncIterable<Buffer>) chunks.push(chunk);
        const readBack = Buffer.concat(chunks).toString('utf8');
        await c.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: testKey }));
        if (readBack !== 'geniusDebug R2 write test') {
          return { ok: false, error: 'write succeeded but read-back mismatch' };
        }
        return { ok: true, detail: `bucket "${config.bucket}" reachable — write + read verified` };
      }
      const { SESClient, GetSendQuotaCommand } = await import('@aws-sdk/client-ses');
      const c = new SESClient({
        region: config.region ?? 'us-east-1',
        credentials: { accessKeyId: secret.accessKeyId ?? '', secretAccessKey: secret.secretAccessKey ?? '' },
      });
      const q = await c.send(new GetSendQuotaCommand({}));
      return { ok: true, detail: `SES reachable — 24h quota ${q.Max24HourSend ?? '?'}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}

function r2EnvSet(): boolean {
  return !!(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_ENDPOINT && process.env.R2_BUCKET);
}
function sesEnvSet(): boolean {
  return !!(process.env.SES_ACCESS_KEY_ID && process.env.SES_SECRET_ACCESS_KEY && process.env.SES_FROM);
}
function deepseekEnvSet(): boolean {
  return !!process.env.DEEPSEEK_API_KEY;
}
