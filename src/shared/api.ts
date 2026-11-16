import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { stateDir, ensureStateDir, INTERNAL_URL } from "./paths.ts";

/**
 * The hub's local API (/api/*) requires this per-install token, so web pages and other local
 * users can't drive it. Hooks (/hooks/*) can't carry it and are treated as low-trust activity data.
 */
export const tokenFile = () => join(stateDir(), "token");

export function getOrCreateToken(): string {
  ensureStateDir();
  const f = tokenFile();
  if (existsSync(f)) {
    const t = readFileSync(f, "utf8").trim();
    if (t.length >= 32) return t;
  }
  const t = randomBytes(24).toString("hex");
  writeFileSync(f, t + "\n", { mode: 0o600 });
  chmodSync(f, 0o600);
  return t;
}

export function readToken(): string {
  try { return readFileSync(tokenFile(), "utf8").trim(); } catch { return ""; }
}

export const TOKEN_HEADER = "x-ccsms-token";

/** fetch() against the local hub API with the token attached. */
export function hubFetch(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(TOKEN_HEADER, readToken());
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  return fetch(`${INTERNAL_URL}${path}`, {
    ...init,
    method: init.method ?? (body !== undefined ? "POST" : "GET"),
    headers,
    body,
    signal: init.signal === null ? undefined : init.signal ?? AbortSignal.timeout(20_000),
  });
}

export async function hubJson(path: string, json?: unknown): Promise<any> {
  const r = await hubFetch(path, json === undefined ? {} : { json });
  return r.json();
}
