/**
 * AWS SES email sender (FR-ALR-6) — server-side creds only. Config resolves from
 * env (ops override) first, else the DB `integrations` row saved via the
 * dashboard (secret AES-GCM decrypted here). Logs in dev when SES is not
 * configured so the throttle/ledger path is still exercised end-to-end.
 */
import { getActiveIntegration } from '@geniusdebug/db';
import { decrypt } from '@geniusdebug/shared';

interface SesConfig {
  region: string;
  from: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const TTL_MS = 30_000;
let cache: { cfg: SesConfig | null; at: number } | null = null;
const clients = new Map<string, Promise<any>>();

function fromEnv(): SesConfig | null {
  const { SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY, SES_FROM, SES_REGION } = process.env;
  if (SES_ACCESS_KEY_ID && SES_SECRET_ACCESS_KEY && SES_FROM) {
    return { region: SES_REGION ?? 'us-east-1', from: SES_FROM, accessKeyId: SES_ACCESS_KEY_ID, secretAccessKey: SES_SECRET_ACCESS_KEY };
  }
  return null;
}

async function resolveConfig(): Promise<SesConfig | null> {
  const env = fromEnv();
  if (env) return env;
  if (cache && Date.now() - cache.at < TTL_MS) return cache.cfg;
  let cfg: SesConfig | null = null;
  try {
    const row = await getActiveIntegration('ses');
    if (row?.secretEnc) {
      const sec = JSON.parse(decrypt(row.secretEnc)) as { accessKeyId?: string; secretAccessKey?: string };
      const c = row.config as { region?: string; from?: string };
      if (c.from && sec.accessKeyId && sec.secretAccessKey) {
        cfg = { region: c.region ?? 'us-east-1', from: c.from, accessKeyId: sec.accessKeyId, secretAccessKey: sec.secretAccessKey };
      }
    }
  } catch {
    cfg = null;
  }
  cache = { cfg, at: Date.now() };
  return cfg;
}

export async function sesConfigured(): Promise<boolean> {
  return (await resolveConfig()) !== null;
}

async function client(cfg: SesConfig) {
  const fp = `${cfg.region}|${cfg.accessKeyId}`;
  let p = clients.get(fp);
  if (!p) {
    p = (async () => {
      const { SESClient } = await import('@aws-sdk/client-ses');
      return new SESClient({
        region: cfg.region,
        credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      });
    })();
    clients.set(fp, p);
  }
  return p;
}

export async function sendAlertEmail(to: string[], subject: string, html: string): Promise<void> {
  const cfg = await resolveConfig();
  if (!cfg || to.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`[ses:dev] → ${to.join(', ') || '(none)'}: ${subject}`);
    return;
  }
  const { SendEmailCommand } = await import('@aws-sdk/client-ses');
  const c = await client(cfg);
  await c.send(
    new SendEmailCommand({
      Source: cfg.from,
      Destination: { ToAddresses: to },
      Message: { Subject: { Data: subject }, Body: { Html: { Data: html } } },
    }),
  );
}
