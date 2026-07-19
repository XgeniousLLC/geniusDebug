import { getActiveIntegration } from '@geniusdebug/db';
import { decrypt } from '@geniusdebug/shared';

/**
 * DeepSeek client (OpenAI-compatible chat completions) — server-side only
 * (NFR-SEC-5). Resolves the API key from env (ops override) first, else the DB
 * `integrations` row (kind `deepseek`, AES-GCM secret). The sole AI provider for
 * the fix-suggester (FR-AIF).
 */
const API = 'https://api.deepseek.com/chat/completions';
const TTL_MS = 30_000;
let cache: { key: string | null; model: string; at: number } | null = null;

async function resolve(): Promise<{ key: string; model: string } | null> {
  const envKey = process.env.DEEPSEEK_API_KEY;
  const envModel = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';
  if (envKey) return { key: envKey, model: envModel };
  if (cache && Date.now() - cache.at < TTL_MS) return cache.key ? { key: cache.key, model: cache.model } : null;

  let key: string | null = null;
  let model = 'deepseek-chat';
  try {
    const row = await getActiveIntegration('deepseek');
    if (row?.secretEnc) {
      const sec = JSON.parse(decrypt(row.secretEnc)) as { apiKey?: string };
      const cfg = (row.config as { model?: string }) ?? {};
      if (sec.apiKey) {
        key = sec.apiKey;
        if (cfg.model) model = cfg.model;
      }
    }
  } catch {
    key = null;
  }
  cache = { key, model, at: Date.now() };
  return key ? { key, model } : null;
}

export async function deepseekConfigured(): Promise<boolean> {
  return (await resolve()) !== null;
}

export interface DeepSeekResult<T> {
  ok: boolean;
  data?: T;
  model?: string;
  reason?: string;
  usage?: { prompt: number; completion: number };
}

/**
 * Call DeepSeek with a system + user prompt, forcing a JSON object response
 * (`response_format: json_object`). Returns parsed JSON or a graceful reason.
 */
export async function deepseekJson<T>(system: string, user: string): Promise<DeepSeekResult<T>> {
  const cfg = await resolve();
  if (!cfg) return { ok: false, reason: 'DeepSeek not configured — add an API key in Integrations' };

  let res: Response;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 2000,
        stream: false,
      }),
    });
  } catch (err) {
    return { ok: false, reason: `DeepSeek request failed: ${(err as Error).message}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, reason: `DeepSeek ${res.status}: ${body.slice(0, 200)}` };
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = json.choices?.[0]?.message?.content;
  if (!content) return { ok: false, reason: 'DeepSeek returned no content' };
  try {
    return {
      ok: true,
      data: JSON.parse(content) as T,
      model: cfg.model,
      usage: { prompt: json.usage?.prompt_tokens ?? 0, completion: json.usage?.completion_tokens ?? 0 },
    };
  } catch {
    return { ok: false, reason: 'DeepSeek returned invalid JSON' };
  }
}
