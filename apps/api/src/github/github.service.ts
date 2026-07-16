import { Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { db, githubApps } from '@geniusdebug/db';
import { eq } from 'drizzle-orm';
import { decrypt } from '../crypto';

const GH_API = 'https://api.github.com';

interface AppCreds {
  appId: string;
  slug: string;
  privateKey: string;
  clientId: string;
}

/** GitHub App auth + REST helpers for the manifest flow (FR-GH-1/3, FR-GH-8). */
@Injectable()
export class GithubService {
  async appForOrg(orgId: string): Promise<AppCreds | null> {
    const rows = await db.select().from(githubApps).where(eq(githubApps.orgId, orgId)).limit(1);
    if (rows.length === 0) return null;
    const a = rows[0];
    return { appId: a.appId, slug: a.slug, clientId: a.clientId, privateKey: decrypt(a.privateKeyEnc) };
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
      headers: { authorization: `Bearer ${installToken}`, accept: 'application/vnd.github+json' },
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
    const res = await fetch(`${GH_API}/app-manifest/${code}/conversions`, {
      method: 'POST',
      headers: { accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`manifest conversion failed: ${res.status}`);
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
      { headers: { authorization: `Bearer ${installToken}`, accept: 'application/vnd.github+json' } },
    );
    if (!res.ok) throw new Error(`commits failed: ${res.status}`);
    const body = (await res.json()) as {
      sha: string;
      html_url: string;
      commit: { message: string; author: { name: string; date: string } };
    }[];
    return body.map((c) => ({ sha: c.sha, message: c.commit.message, author: c.commit.author.name, date: c.commit.author.date, url: c.html_url }));
  }

  /** Create a GitHub Issue prefilled from a geniusDebug issue (FR-GH-6). */
  async createIssue(installToken: string, owner: string, repo: string, title: string, body: string): Promise<string> {
    const res = await fetch(`${GH_API}/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      headers: { authorization: `Bearer ${installToken}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
      body: JSON.stringify({ title, body }),
    });
    if (!res.ok) throw new Error(`create issue failed: ${res.status}`);
    const created = (await res.json()) as { html_url: string };
    return created.html_url;
  }

  private appHeaders(creds: AppCreds): Record<string, string> {
    return { authorization: `Bearer ${this.appJwt(creds)}`, accept: 'application/vnd.github+json' };
  }
}
