import { getActiveIntegration } from '@geniusdebug/db';
import { decrypt } from './crypto';

/**
 * API-side SES sender (env → DB integrations, same resolution as the workers).
 * Used for transactional emails triggered from the dashboard (e.g. sending SDK
 * setup instructions to a developer). Returns { sent:false } gracefully when SES
 * is not configured so callers can offer a copy/mailto fallback.
 */
interface SesConfig {
  region: string;
  from: string;
  fromName?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Format the SES Source with a professional display name ("Name <addr>"). */
function formatSource(cfg: SesConfig): string {
  if (cfg.from.includes('<')) return cfg.from;
  const name = (cfg.fromName ?? 'geniusDebug').replace(/["<>]/g, '').trim();
  return name ? `"${name}" <${cfg.from}>` : cfg.from;
}

function fromEnv(): SesConfig | null {
  const { SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY, SES_FROM, SES_FROM_NAME, SES_REGION } = process.env;
  if (SES_ACCESS_KEY_ID && SES_SECRET_ACCESS_KEY && SES_FROM) {
    return { region: SES_REGION ?? 'us-east-1', from: SES_FROM, fromName: SES_FROM_NAME, accessKeyId: SES_ACCESS_KEY_ID, secretAccessKey: SES_SECRET_ACCESS_KEY };
  }
  return null;
}

async function resolveConfig(orgId?: string): Promise<SesConfig | null> {
  const env = fromEnv();
  if (env) return env;
  try {
    const row = await getActiveIntegration('ses', orgId);
    if (row?.secretEnc) {
      const sec = JSON.parse(decrypt(row.secretEnc)) as { accessKeyId?: string; secretAccessKey?: string };
      const c = row.config as { region?: string; from?: string; fromName?: string };
      if (c.from && sec.accessKeyId && sec.secretAccessKey) {
        return { region: c.region ?? 'us-east-1', from: c.from, fromName: c.fromName, accessKeyId: sec.accessKeyId, secretAccessKey: sec.secretAccessKey };
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function sesConfigured(orgId?: string): Promise<boolean> {
  return (await resolveConfig(orgId)) !== null;
}

export async function sendEmail(
  to: string[],
  subject: string,
  html: string,
  orgId?: string,
): Promise<{ sent: boolean; reason?: string }> {
  const cfg = await resolveConfig(orgId);
  if (!cfg) return { sent: false, reason: 'email (SES) not configured' };
  if (to.length === 0) return { sent: false, reason: 'no recipient' };
  // Never let an SES/SDK failure become a 500 — the caller offers a copy/mailto
  // fallback on { sent:false }. Surface the real cause (bad creds, unverified
  // sender, sandbox recipient, region, or a missing @aws-sdk/client-ses install).
  try {
    const { SESClient, SendEmailCommand } = await import('@aws-sdk/client-ses');
    const client = new SESClient({
      region: cfg.region,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
    await client.send(
      new SendEmailCommand({
        Source: formatSource(cfg),
        Destination: { ToAddresses: to },
        Message: { Subject: { Data: subject }, Body: { Html: { Data: html } } },
      }),
    );
    return { sent: true };
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'SES send failed';
    // eslint-disable-next-line no-console
    console.error('[mailer] SES send failed:', reason);
    return { sent: false, reason };
  }
}
