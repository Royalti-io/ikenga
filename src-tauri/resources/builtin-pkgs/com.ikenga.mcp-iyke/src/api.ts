// HTTP client for the Iyke server. Mirrors `iyke-cli/src/api.rs` —
// same bearer-token contract, same endpoints, same timeouts.

import type { ControlFile } from './control.ts';

export class IykeClient {
  private base: string;
  private token: string;

  constructor(cf: ControlFile) {
    this.base = `http://127.0.0.1:${cf.port}`;
    this.token = cf.token;
  }

  async get(path: string, params?: Record<string, unknown>): Promise<unknown> {
    const qs = params ? buildQuery(params) : '';
    return this.fetch(`${path}${qs}`, { method: 'GET' });
  }

  async post(path: string, body: unknown, timeoutMs?: number): Promise<unknown> {
    return this.fetch(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
  }

  private async fetch(path: string, init: RequestInit, timeoutMs = 5000): Promise<unknown> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${this.token}`,
        },
        signal: ac.signal,
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError') {
        throw new Error(`iyke ${path} timed out (5s). Is the PA desktop app running?`);
      }
      throw new Error(
        `could not reach iyke server at ${path}: ${e.message}. Is the PA desktop app running?`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${path} returned HTTP ${res.status}: ${body}`);
    }

    const text = await res.text();
    if (text.length === 0) return { ok: true };
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`parse response from ${path}: ${text}`);
    }
  }
}

function buildQuery(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}
