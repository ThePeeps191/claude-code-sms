import { existsSync, unlinkSync, chmodSync } from "node:fs";
import type { Hub, BridgeConn, Mode } from "./hub.ts";
import { LineDecoder, encode, type BridgeMsg, type HubMsg } from "../shared/protocol.ts";
import { paths, INTERNAL_PORT, PUBLIC_PORT } from "../shared/paths.ts";
import { logger } from "../shared/log.ts";
import { VERSION } from "../shared/version.ts";
import { normalizeE164 } from "../shared/e164.ts";
import { getOrCreateToken, TOKEN_HEADER } from "../shared/api.ts";

const log = logger("server");

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

/**
 * Internal server on 127.0.0.1 only: hooks, the CLI API and the fake phone.
 * Never reachable through the tunnel (the tunnel targets the public port).
 */
export function startInternalServer(hub: Hub, port = INTERNAL_PORT, token = getOrCreateToken()) {
  const okHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      // Defend against browsers (CSRF, DNS rebinding) and other local users.
      if (!okHosts.has(req.headers.get("host") ?? "")) return json({ error: "bad host" }, 403);
      if (req.headers.get("origin") || req.headers.get("sec-fetch-site")) return json({ error: "browser requests are not allowed" }, 403);
      if (req.method === "POST" && !(req.headers.get("content-type") ?? "").startsWith("application/json")) return json({ error: "json only" }, 415);
      if (p.startsWith("/api/") && p !== "/api/health" && req.headers.get(TOKEN_HEADER) !== token) return json({ error: "unauthorized" }, 401);
      try {
        if (p.startsWith("/hooks/") && req.method === "POST") {
          const event = p.slice("/hooks/".length);
          const body = await req.json().catch(() => ({}));
          return json(hub.onHook(event, body));
        }
        if (p === "/api/health") return json({ ok: true, version: VERSION, pid: process.pid });
        if (p === "/api/status") return json(hub.statusJson());
        if (p === "/api/mode" && req.method === "POST") {
          const b = (await req.json()) as { mode: Mode | "resume"; until?: number };
          const m = hub.setMode(b.mode, { until: b.until, source: "cli" });
          return json({ ok: true, mode: m });
        }
        if (p === "/api/watch" && req.method === "POST") {
          const b = (await req.json()) as { session: string; level: "watched" | "muted" | "default" };
          const s = hub.resolveTarget(/^\d+$/.test(b.session) ? { num: Number(b.session) } : { name: b.session.toLowerCase() }, "");
          if (!s) return json({ ok: false, error: "no such session" }, 404);
          hub.store.updateSession(s.id, { watch: b.level });
          return json({ ok: true, name: s.name });
        }
        if (p === "/api/unlock" && req.method === "POST") {
          hub.store.set("lockdown", false);
          hub.store.set("unlockedUntil", Date.now() + hub.cfg.security.unlockHours * 3600_000);
          hub.store.set("optOutWarning", null);
          return json({ ok: true });
        }
        if (p === "/api/test-text" && req.method === "POST") {
          const b = (await req.json().catch(() => ({}))) as { text?: string };
          const to = hub.notifyTargets();
          if (!to.length) return json({ ok: false, error: "no owner numbers configured" }, 400);
          for (const n of to) await hub.outbox.sendRaw(n, b.text || "claude-code-sms test text.", "T1", null);
          return json({ ok: true, lastSendError: hub.store.get("lastSendError", null) });
        }
        if (p === "/api/reload" && req.method === "POST") {
          hub.reloadIfChanged();
          if (hub.publicUrl) await hub.configureWebhook(hub.publicUrl);
          return json({ ok: true });
        }
        if (p === "/api/messages") {
          const since = Number(url.searchParams.get("since") ?? 0);
          const after = Number(url.searchParams.get("after") ?? 0);
          return json(hub.store.messagesSince(since, after));
        }
        if (p === "/api/fake/inbound" && req.method === "POST") {
          const b = (await req.json()) as { from?: string; text: string };
          const from = b.from ? normalizeE164(b.from) ?? b.from : hub.cfg.owners.numbers[0];
          if (!from) return json({ ok: false, error: "no owner number configured; run ccsms setup" }, 400);
          hub.onInbound({ kind: "message", id: `fake-in-${Date.now()}`, from, to: hub.cfg.provider.number, text: b.text, mediaCount: 0 });
          return json({ ok: true });
        }
        if (p === "/api/fake/stream") {
          let listener: ((m: any) => void) | null = null;
          const stream = new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              controller.enqueue(enc.encode(": connected\n\n"));
              listener = (m) => controller.enqueue(enc.encode(`data: ${JSON.stringify(m)}\n\n`));
              hub.phoneListeners.add(listener);
            },
            cancel() { if (listener) hub.phoneListeners.delete(listener); },
          });
          return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
        }
        return json({ error: "not found" }, 404);
      } catch (e: any) {
        log.error(`internal ${p} failed`, e);
        return json({ error: String(e?.message ?? e) }, 500);
      }
    },
  });
}

/**
 * Public server: the tunnel points here. Only provider webhooks and a health check.
 * Signature verification happens in the provider adapter.
 */
export function startPublicServer(hub: Hub, port = PUBLIC_PORT) {
  const seenWarn = new Set<string>();
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return new Response("ok");
      const m = url.pathname.match(/^\/sms\/(telnyx|twilio)$/);
      if (!m || req.method !== "POST") return new Response("not found", { status: 404 });
      if (m[1] !== hub.provider.id) return new Response("provider mismatch", { status: 404 });
      const rawBody = await req.text();
      const publicUrl = (hub.publicUrl ?? `${url.protocol}//${url.host}`) + url.pathname;
      const events = await hub.provider.verifyAndParse({ headers: req.headers, rawBody, publicUrl });
      if (events === null) {
        const k = req.headers.get("user-agent") ?? "?";
        if (!seenWarn.has(k)) { seenWarn.add(k); log.warn("rejected a webhook with a missing or invalid signature"); }
        return new Response("invalid signature", { status: 403 });
      }
      queueMicrotask(() => {
        for (const ev of events) {
          try {
            if (ev.kind === "message") {
              if (hub.store.firstSeen(`in:${ev.id}`)) hub.onInbound(ev);
            } else {
              if (!ev.eventId || hub.store.firstSeen(`st:${ev.eventId}`)) hub.onStatus(ev);
            }
          } catch (e) { log.error("webhook event failed", e); }
        }
      });
      const r = hub.provider.webhookResponse();
      return new Response(r.body, { headers: { "Content-Type": r.contentType } });
    },
  });
}

/** Unix socket for bridges (one connection per Claude Code session). */
export function startBridgeSocket(hub: Hub, socketPath = paths.socket) {
  if (existsSync(socketPath)) { try { unlinkSync(socketPath); } catch {} }
  type Data = { conn: BridgeConn; dec: LineDecoder; pending: Buffer | null };
  const server = Bun.listen<Data>({
    unix: socketPath,
    socket: {
      open(socket) {
        const conn: BridgeConn = {
          sessionId: null, claudePid: null, version: "",
          send: (msg: HubMsg) => writeAll(socket, Buffer.from(encode(msg))),
        };
        socket.data = { conn, dec: new LineDecoder(), pending: null };
      },
      drain(socket) {
        const p = socket.data.pending;
        socket.data.pending = null;
        if (p) writeAll(socket, p);
      },
      data(socket, buf) {
        socket.data.dec.push(buf.toString(), async (msg: BridgeMsg) => {
          const conn = socket.data.conn;
          if (msg.t === "hello") {
            const w = hub.onBridgeHello(conn, msg as any);
            if (w) conn.send({ t: "welcome", ...w });
          } else if (msg.t === "req") {
            try {
              const result = await hub.onBridgeRequest(conn, msg);
              conn.send({ t: "res", id: msg.id, ok: true, result });
            } catch (e: any) {
              conn.send({ t: "res", id: msg.id, ok: false, error: String(e?.message ?? e) });
            }
          }
        });
      },
      close(socket) { hub.onBridgeClose(socket.data.conn); },
      error(socket, err) { log.warn("bridge socket error", err?.message); },
    },
  });
  try { chmodSync(socketPath, 0o600); } catch {}
  return server;
}

/** Bun's socket.write may write only part of the buffer; keep the rest for the drain event. */
function writeAll(socket: { write(b: Buffer): number; data: { pending: Buffer | null } }, buf: Buffer) {
  try {
    if (socket.data.pending) { socket.data.pending = Buffer.concat([socket.data.pending, buf]); return; }
    const n = socket.write(buf);
    if (n < buf.length) socket.data.pending = buf.subarray(Math.max(0, n));
  } catch {}
}
