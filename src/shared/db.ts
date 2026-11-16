import { Database } from "bun:sqlite";
import { paths, ensureStateDir } from "./paths.ts";

export type SessionStatus = "busy" | "idle" | "ended";
export type WatchLevel = "default" | "watched" | "muted";

export interface SessionRow {
  id: string;
  pid: number | null;
  cwd: string;
  name: string;
  num: number;
  status: SessionStatus;
  inbound: number; // 1 if the session can receive texts (bridge connected with channel flag)
  watch: WatchLevel;
  tmux_pane: string | null;
  created_at: number;
  updated_at: number;
  busy_since: number | null;
  ended_at: number | null;
  end_reason: string | null;
  last_summary: string | null;
  last_activity: string | null;
  notified_mode: string | null;
  last_update_at: number | null;
  pending_question: string | null; // JSON {question, options?, via: "sms"|"screen"}
}

export interface MessageRow {
  id: number;
  direction: "in" | "out";
  peer: string;
  body: string;
  segments: number;
  cost: number | null;
  currency: string | null;
  provider_id: string | null;
  status: string | null;
  tier: string | null;
  session_id: string | null;
  ts: number;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 3000;
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  pid INTEGER,
  cwd TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  num INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  inbound INTEGER NOT NULL DEFAULT 0,
  watch TEXT NOT NULL DEFAULT 'default',
  tmux_pane TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  busy_since INTEGER,
  ended_at INTEGER,
  end_reason TEXT,
  last_summary TEXT,
  last_activity TEXT,
  notified_mode TEXT,
  last_update_at INTEGER,
  pending_question TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  type TEXT NOT NULL,
  summary TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, ts);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL,
  peer TEXT NOT NULL,
  body TEXT NOT NULL,
  segments INTEGER NOT NULL DEFAULT 0,
  cost REAL,
  currency TEXT,
  provider_id TEXT,
  status TEXT,
  tier TEXT,
  session_id TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts);
CREATE INDEX IF NOT EXISTS messages_provider ON messages(provider_id);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS seen_webhooks (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL
);
`;

export class Store {
  db: Database;

  constructor(file = paths.db) {
    if (file !== ":memory:") ensureStateDir();
    this.db = new Database(file, { create: true });
    this.db.exec(SCHEMA);
  }

  close() { this.db.close(); }

  // ---------- kv ----------
  get<T>(key: string, fallback: T): T {
    const row = this.db.query("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | null;
    if (!row) return fallback;
    try { return JSON.parse(row.value) as T; } catch { return fallback; }
  }
  set(key: string, value: unknown) {
    if (value === undefined || value === null) {
      this.db.query("DELETE FROM kv WHERE key = ?").run(key);
      return;
    }
    this.db.query("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }

  // ---------- sessions ----------
  session(id: string): SessionRow | null {
    return this.db.query("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | null;
  }
  liveSessions(): SessionRow[] {
    return this.db.query("SELECT * FROM sessions WHERE status != 'ended' ORDER BY num").all() as SessionRow[];
  }
  recentEnded(limit = 10): SessionRow[] {
    return this.db.query("SELECT * FROM sessions WHERE status = 'ended' ORDER BY ended_at DESC LIMIT ?").all(limit) as SessionRow[];
  }
  sessionByPid(pid: number): SessionRow | null {
    return this.db.query("SELECT * FROM sessions WHERE pid = ? AND status != 'ended' ORDER BY updated_at DESC LIMIT 1").get(pid) as SessionRow | null;
  }

  private nextNum(): number {
    const used = new Set((this.db.query("SELECT num FROM sessions WHERE status != 'ended'").all() as { num: number }[]).map((r) => r.num));
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }

  private uniqueName(base: string, excludeId?: string): string {
    const clean = (base || "session").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 10) || "session";
    const taken = new Set(
      (this.db.query("SELECT name FROM sessions WHERE status != 'ended' AND id != ?").all(excludeId ?? "") as { name: string }[]).map((r) => r.name),
    );
    if (!taken.has(clean)) return clean;
    for (let i = 2; i < 100; i++) {
      const cand = `${clean.slice(0, 8)}-${i}`;
      if (!taken.has(cand)) return cand;
    }
    return `${clean.slice(0, 6)}-${Date.now() % 1000}`;
  }

  /** Create or refresh a session. Returns the row. */
  upsertSession(s: { id: string; pid?: number | null; cwd?: string; name?: string; inbound?: boolean; tmuxPane?: string | null }): SessionRow {
    const now = Date.now();
    const existing = this.session(s.id);
    if (existing) {
      const revived = existing.status === "ended";
      this.db.query(
        `UPDATE sessions SET pid = COALESCE(?, pid), cwd = COALESCE(?, cwd), inbound = MAX(inbound, ?),
         tmux_pane = COALESCE(?, tmux_pane), updated_at = ?, status = CASE WHEN status = 'ended' THEN 'idle' ELSE status END,
         ended_at = CASE WHEN status = 'ended' THEN NULL ELSE ended_at END,
         num = ?, name = ? WHERE id = ?`,
      ).run(
        s.pid ?? null, s.cwd ?? null, s.inbound ? 1 : 0, s.tmuxPane ?? null, now,
        revived ? this.nextNum() : existing.num,
        revived ? this.uniqueName(existing.name, existing.id) : existing.name,
        s.id,
      );
      return this.session(s.id)!;
    }
    const base = s.name || (s.cwd ? s.cwd.split("/").filter(Boolean).pop() : "") || "session";
    this.db.query(
      `INSERT INTO sessions(id, pid, cwd, name, num, status, inbound, watch, tmux_pane, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, 'idle', ?, 'default', ?, ?, ?)`,
    ).run(s.id, s.pid ?? null, s.cwd ?? "", this.uniqueName(base), this.nextNum(), s.inbound ? 1 : 0, s.tmuxPane ?? null, now, now);
    return this.session(s.id)!;
  }

  updateSession(id: string, fields: Partial<SessionRow>) {
    const keys = Object.keys(fields).filter((k) => k !== "id");
    if (!keys.length) return;
    const sql = `UPDATE sessions SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`;
    this.db.query(sql).run(...keys.map((k) => (fields as any)[k]), Date.now(), id);
  }

  renameSession(id: string, name: string): string {
    const n = this.uniqueName(name, id);
    this.updateSession(id, { name: n });
    return n;
  }

  /** Re-key a session after /clear: new id, same process, same number and name. */
  rekeySession(oldId: string, newId: string) {
    if (this.session(newId)) return;
    this.db.query("UPDATE sessions SET id = ?, updated_at = ? WHERE id = ?").run(newId, Date.now(), oldId);
    this.db.query("UPDATE events SET session_id = ? WHERE session_id = ?").run(newId, oldId);
  }

  endSession(id: string, reason: string) {
    this.db.query("UPDATE sessions SET status = 'ended', ended_at = ?, end_reason = ?, busy_since = NULL, updated_at = ? WHERE id = ?")
      .run(Date.now(), reason, Date.now(), id);
  }

  // ---------- events ----------
  addEvent(sessionId: string | null, type: string, summary?: string) {
    this.db.query("INSERT INTO events(session_id, type, summary, ts) VALUES(?, ?, ?, ?)").run(sessionId, type, summary ?? null, Date.now());
  }
  recentEvents(sessionId: string, limit = 8): { type: string; summary: string | null; ts: number }[] {
    return this.db.query("SELECT type, summary, ts FROM events WHERE session_id = ? ORDER BY ts DESC, id DESC LIMIT ?").all(sessionId, limit) as any;
  }

  // ---------- messages ----------
  addMessage(m: Omit<MessageRow, "id" | "ts"> & { ts?: number }): number {
    const r = this.db.query(
      `INSERT INTO messages(direction, peer, body, segments, cost, currency, provider_id, status, tier, session_id, ts)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(m.direction, m.peer, m.body, m.segments, m.cost, m.currency, m.provider_id, m.status, m.tier, m.session_id, m.ts ?? Date.now());
    return Number(r.lastInsertRowid);
  }
  updateMessageByProviderId(providerId: string, fields: { status?: string; cost?: number | null; currency?: string | null }) {
    const sets: string[] = [];
    const vals: any[] = [];
    if (fields.status !== undefined) { sets.push("status = ?"); vals.push(fields.status); }
    if (fields.cost !== undefined && fields.cost !== null) { sets.push("cost = ?"); vals.push(fields.cost); }
    if (fields.currency) { sets.push("currency = ?"); vals.push(fields.currency); }
    if (!sets.length) return;
    this.db.query(`UPDATE messages SET ${sets.join(", ")} WHERE provider_id = ?`).run(...vals, providerId);
  }
  recentMessages(peer: string, limit = 10): MessageRow[] {
    return (this.db.query("SELECT * FROM messages WHERE peer = ? ORDER BY ts DESC, id DESC LIMIT ?").all(peer, limit) as MessageRow[]).reverse();
  }
  lastMessages(limit = 20): MessageRow[] {
    return (this.db.query("SELECT * FROM messages ORDER BY ts DESC, id DESC LIMIT ?").all(limit) as MessageRow[]).reverse();
  }
  messagesSince(sinceTs: number, afterId = 0): MessageRow[] {
    return this.db.query("SELECT * FROM messages WHERE ts >= ? AND id > ? ORDER BY id").all(sinceTs, afterId) as MessageRow[];
  }

  /** Segments and cost (in/out) since a timestamp. */
  usageSince(ts: number): { outSegments: number; inSegments: number; cost: number; currency: string | null } {
    const out = this.db.query("SELECT COALESCE(SUM(segments),0) s FROM messages WHERE direction='out' AND ts >= ?").get(ts) as { s: number };
    const inn = this.db.query("SELECT COALESCE(SUM(segments),0) s FROM messages WHERE direction='in' AND ts >= ?").get(ts) as { s: number };
    const cost = this.db.query("SELECT COALESCE(SUM(cost),0) c, MAX(currency) cur FROM messages WHERE ts >= ?").get(ts) as { c: number; cur: string | null };
    return { outSegments: out.s, inSegments: inn.s, cost: cost.c, currency: cost.cur };
  }

  /** Webhook idempotency: returns true the first time an id is seen. */
  firstSeen(id: string): boolean {
    const r = this.db.query("INSERT OR IGNORE INTO seen_webhooks(id, ts) VALUES(?, ?)").run(id, Date.now());
    return r.changes > 0;
  }

  prune(retentionDays: number) {
    const cutoff = Date.now() - retentionDays * 86400_000;
    this.db.query("DELETE FROM messages WHERE ts < ?").run(cutoff);
    this.db.query("DELETE FROM events WHERE ts < ?").run(cutoff);
    this.db.query("DELETE FROM seen_webhooks WHERE ts < ?").run(Date.now() - 2 * 86400_000);
    this.db.query("DELETE FROM sessions WHERE status = 'ended' AND ended_at < ?").run(cutoff);
  }
}
