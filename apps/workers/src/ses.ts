/**
 * AWS SES email sender (FR-ALR-6) — server-side creds only. Logs in dev when SES
 * is not configured so the throttle/ledger path is still exercised end-to-end.
 */
let clientPromise: Promise<any> | null = null;

export function sesConfigured(): boolean {
  return !!(process.env.SES_ACCESS_KEY_ID && process.env.SES_SECRET_ACCESS_KEY && process.env.SES_FROM);
}

async function client() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { SESClient } = await import('@aws-sdk/client-ses');
      return new SESClient({
        region: process.env.SES_REGION ?? 'us-east-1',
        credentials: {
          accessKeyId: process.env.SES_ACCESS_KEY_ID!,
          secretAccessKey: process.env.SES_SECRET_ACCESS_KEY!,
        },
      });
    })();
  }
  return clientPromise;
}

export async function sendAlertEmail(to: string[], subject: string, html: string): Promise<void> {
  if (!sesConfigured() || to.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`[ses:dev] → ${to.join(', ') || '(none)'}: ${subject}`);
    return;
  }
  const { SendEmailCommand } = await import('@aws-sdk/client-ses');
  const c = await client();
  await c.send(
    new SendEmailCommand({
      Source: process.env.SES_FROM!,
      Destination: { ToAddresses: to },
      Message: { Subject: { Data: subject }, Body: { Html: { Data: html } } },
    }),
  );
}
