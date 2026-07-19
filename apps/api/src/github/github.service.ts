import { Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { db, githubApps } from '@geniusdebug/db';
import { eq } from 'drizzle-orm';
import { decrypt } from '../crypto';

const GH_API = 'https://api.github.com';
// GitHub REST API rejects requests without a User-Agent (403). Node's global
// fetch (undici) sends none by default, so set it on every call. (FR-GH-1)
const GH_UA = 'geniusDebug';

interface AppCreds {
  appId: string;
  slug: string;
  privateKey: string;
  clientId: string;
}

/** GitHub App auth + REST helpers for the manifest flow (FR-GH-1/3, FR-GH-8). */
@Injectable()
export class GithubService {
  /** All GitHub Apps connected by an org (an org may connect several) — FR-GH-1. */
  async appsForOrg(orgId: string): Promise<AppCreds[]> {
    const rows = await db.select().from(githubApps).where(eq(githubApps.orgId, orgId));
    return rows.map((a) => ({ appId: a.appId, slug: a.slug, clientId: a.clientId, privateKey: decrypt(a.privateKeyEnc) }));
  }

  /**
   * An installation belongs to exactly one of the org's apps, but the callback
   * only gives us the installation id — so try each app's creds until one mints
   * a token (FR-GH-1).
   */
  async installationTokenForOrg(orgId: string, installationId: string): Promise<string | null> {
    for (const creds of await this.appsForOrg(orgId)) {
      try {
        return await this.installationToken(creds, installationId);
      } catch {
        // wrong app for this installation — try the next one
      }
    }
    return null;
  }

  /** Short-lived App JWT (RS256, iss = app id) — authenticates as the App itself. */
  appJwt(creds: AppCreds): string {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign({ iat: now - 30, exp: now + 540, iss: creds.appId }, creds.privateKey, { algorithm: 'RS256' });
  }

  /** Exchange an installation id for a short-lived installation access token. */
  async installationToken(creds: AppCreds, installationId: string): Promise<string> {
    const res = await fetch(`${GH_API}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: this.appHeaders(creds),
    });
    if (!res.ok) throw new Error(`installation token failed: ${res.status}`);
    const body = (await res.json()) as { token: string };
    return body.token;
  }

  /** Repos the installation can access (org or personal) — FR-GH-1. */
  async listInstallationRepos(installToken: string): Promise<{ owner: string; name: string; defaultBranch: string }[]> {
    const res = await fetch(`${GH_API}/installation/repositories?per_page=100`, {
      headers: { authorization: `Bearer ${installToken}`, accept: 'application/vnd.github+json', 'user-agent': GH_UA },
    });
    if (!res.ok) throw new Error(`list repos failed: ${res.status}`);
    const body = (await res.json()) as { repositories: { owner: { login: string }; name: string; default_branch: string }[] };
    return body.repositories.map((r) => ({ owner: r.owner.login, name: r.name, defaultBranch: r.default_branch }));
  }

  /** Convert a manifest `code` into full App credentials (one-time). */
  async convertManifest(code: string): Promise<{
    id: number;
    slug: string;
    pem: string;
    client_id: string;
    client_secret: string;
    webhook_secret?: string;
    owner: { login: string };
  }> {
    const res = await fetch(`${GH_API}/app-manifests/${code}/conversions`, {
      method: 'POST',
      headers: { accept: 'application/vnd.github+json', 'user-agent': GH_UA },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`manifest conversion failed: ${res.status} ${detail.slice(0, 300)}`);
    }
    return res.json() as never;
  }

  /** Commits that last touched a file → suspect commits (FR-GH-4). */
  async commitsForFile(
    installToken: string,
    owner: string,
    repo: string,
    path: string,
  ): Promise<{ sha: string; message: string; author: string; date: string; url: string }[]> {
    const res = await fetch(
      `${GH_API}/repos/${owner}/${repo}/commits?path=${encodeURIComponent(path)}&per_page=5`,
      { headers: { authorization: `Bearer ${installToken}`, accept: 'application/vnd.github+json', 'user-agent': GH_UA } },
    );
    if (!res.ok) throw new Error(`commits failed: ${res.status}`);
    const body = (await res.json()) as {
      sha: string;
      html_url: string;
      commit: { message: string; author: { name: string; date: string } };
    }[];
    return body.map((c) => ({ sha: c.sha, message: c.commit.message, author: c.commit.author.name, date: c.commit.author.date, url: c.html_url }));
  }

  /**
   * Fetch a file's text at a given ref (commit sha or branch) for AI grounding
   * (FR-AIF P2). Returns null on any error so the caller degrades gracefully.
   */
  async getFileContent(installToken: string, owner: string, repo: string, path: string, ref?: string): Promise<string | null> {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const res = await fetch(`${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}${q}`, {
      headers: { authorization: `Bearer ${installToken}`, accept: 'application/vnd.github+json', 'user-agent': GH_UA },
    }).catch(() => null);
    if (!res || !res.ok) return null;
    const body = (await res.json().catch(() => null)) as { content?: string; encoding?: string; size?: number } | null;
    if (!body?.content || body.encoding !== 'base64') return null;
    if ((body.size ?? 0) > 400_000) return null; // skip huge files
    try {
      return Buffer.from(body.content, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }

  /** Create a GitHub Issue prefilled from a geniusDebug issue (FR-GH-6). */
  async createIssue(installToken: string, owner: string, repo: string, title: string, body: string): Promise<string> {
    const res = await fetch(`${GH_API}/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      headers: { authorization: `Bearer ${installToken}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': GH_UA },
      body: JSON.stringify({ title, body }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // 403 usually = App lacks `issues: write` (re-approve permissions); 410 = issues disabled on repo.
      throw new Error(`create issue failed: ${res.status} ${detail.slice(0, 300)}`);
    }
    const created = (await res.json()) as { html_url: string };
    return created.html_url;
  }

  private appHeaders(creds: AppCreds): Record<string, string> {
    return { authorization: `Bearer ${this.appJwt(creds)}`, accept: 'application/vnd.github+json', 'user-agent': GH_UA };
  }
}
