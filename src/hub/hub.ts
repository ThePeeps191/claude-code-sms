import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Store, SessionRow } from "../shared/db.ts";
import { type Config, loadConfig, saveConfig, ConfigError } from "../shared/config.ts";
import { paths } from "../shared/paths.ts";
import { loadSecrets } from "../shared/secrets.ts";
import { maskNumber } from "../shared/e164.ts";
import { logger } from "../shared/log.ts";
import type { SmsProvider, InboundMessage, StatusEvent } from "../providers/provider.ts";
import { createProvider, destinationsFor } from "../providers/index.ts";
import { FakeProvider } from "../providers/fake.ts";
import { Outbox, type Tier, startOfToday } from "./outbox.ts";
import { parseCommand, HELP_TEXT, type Action, type SessionRef } from "./commands.ts";
import { Dispatcher, decisionToAction, defaultRunner, findClaude, type ClaudeRunner } from "./router.ts";
import { stripMarkdown, firstParagraph, fmtDuration, describeTool, isSubstantiveTool, parseClockTime, fmtClock } from "./text.ts";
import * as tmux from "./tmux.ts";
import { userIdleSeconds } from "./idle.ts";
import type { HubMsg, BridgeHello, BridgeRequest } from "../shared/protocol.ts";
import { VERSION } from "../shared/version.ts";

const log = logger("hub");

export type Mode = "home" | "away" | "paused";
interface ModeState { mode: Mode; since: number; prev?: Mode; until?: number }

interface SenderState {
  sticky?: { sessionId: string; at: number };
  capture?: { active: boolean; parts: string[]; target: string | null; lastAt: number };
  confirm?: { kind: string; data: any; prompt: string; expires: number };
  choice?: { kind: "route" | "screen" | "answer"; options: any[]; data: any; expires: number };
  lastLockNotice?: number;
}

export interface BridgeConn {
  send(msg: HubMsg): void;
  sessionId: string | null;
  claudePid: number | null;
  version: string;
}

interface Runtime {
  turnStart?: number;
  lastStopAt?: number;
  lastEventAt?: number;
  lastReplyAt?: number;
  lastSubstantiveAt?: number;
  lastInboundAt?: number;
  lastPeer?: string;
  doneTimer?: ReturnType<typeof setTimeout>;
  lastWaitingAt?: number;
  lastFailureAt?: number;
  lastStopMessage?: string;
}

const MODE_NOTICES: Record<Mode, string> = {
  away: "[claude-code-sms] The user has left the computer and is following by text. They won't see terminal output. Keep working normally. Your final message will be texted to them, so open it with a one-sentence outcome. If you need them, use sms_ask rather than AskUserQuestion. Follow the sms-updates skill.",
  home: "[claude-code-sms] The user is back at the computer. Don't use the sms tools; respond normally.",
  paused: "[claude-code-sms] The user paused texts. Don't send updates; use sms_ask only if you're fully blocked.",
};

const RESERVED_KEYWORDS = /^(stop|stopall|unsubscribe|cancel|end|quit|optout|revoke)$/i;

export interface HubOptions {
  runner?: ClaudeRunner;
  provider?: SmsProvider;
  configFile?: string;
  /** Disable timers (tests). */
  noTimers?: boolean;
}

export class Hub {
  cfg: Config;
  provider: SmsProvider;
  outbox: Outbox;
  dispatcher: Dispatcher;
  bridges = new Map<string, BridgeConn>();
  runtime = new Map<string, Runtime>();
  publicUrl: string | null = null;
  phoneListeners = new Set<(m: { to: string; body: string; ts: number }) => void>();
  private debounce = new Map<string, { texts: string[]; timer: ReturnType<typeof setTimeout> }>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private cfgMtime = 0;
  private secretsMtime = 0;
  private configFile: string;
  debounceMs = 3000;

  constructor(public store: Store, opts: HubOptions = {}) {
    this.configFile = opts.configFile ?? paths.config;
    this.cfg = loadConfig(this.configFile);
    this.cfgMtime = mtime(this.configFile);
    this.secretsMtime = mtime(paths.secrets);
    this.provider = opts.provider ?? this.makeProvider();
    this.outbox = new Outbox(store, () => this.cfg, () => this.provider, () =>
      this.publicUrl && this.provider.id === "twilio" ? `${this.publicUrl}/sms/twilio` : undefined);
    const runner = opts.runner ?? defaultRunner(findClaude(this.cfg.system.claudePath));
    this.dispatcher = new Dispatcher(runner, () => ({ router: this.cfg.router.model, summarizer: this.cfg.summarizer.model }));
    if (!opts.noTimers) this.startTimers();
  }

  private makeProvider(): SmsProvider {
    const p = createProvider(this.cfg, loadSecrets());
    if (p instanceof FakeProvider) p.setOnSend((to, body) => this.emitPhone(to, body));
    return p;
  }

  emitPhone(to: string, body: string) {
    for (const l of this.phoneListeners) { try { l({ to, body, ts: Date.now() }); } catch {} }
  }

  // ------------------------------------------------------------------ config & timers
  reloadIfChanged() {
    const cm = mtime(this.configFile);
    const sm = mtime(paths.secrets);
    if (cm === this.cfgMtime && sm === this.secretsMtime) return;
    const oldProviderKey = JSON.stringify([this.cfg.provider, this.secretsMtime]);
    try {
      this.cfg = loadConfig(this.configFile);
      this.cfgMtime = cm;
      this.secretsMtime = sm;
      log.info("config reloaded");
    } catch (e) {
      this.cfgMtime = cm;
      log.error("config reload rejected; keeping previous config", e instanceof ConfigError ? e.errors : e);
      return;
    }
    if (JSON.stringify([this.cfg.provider, this.secretsMtime]) !== oldProviderKey) {
      this.provider = this.makeProvider();
      log.info(`provider is now ${this.provider.id}`);
      if (this.publicUrl) void this.configureWebhook(this.publicUrl);
    }
  }

  private startTimers() {
    this.timers.push(setInterval(() => this.reloadIfChanged(), 3000));
    this.timers.push(setInterval(() => this.checkLiveness(), 15_000));
    this.timers.push(setInterval(() => this.checkIdle(), 20_000));
    this.timers.push(setInterval(() => this.checkModeTimers(), 30_000));
    this.timers.push(setInterval(() => this.store.prune(this.cfg.log.retentionDays), 6 * 3600_000));
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    for (const r of this.runtime.values()) if (r.doneTimer) clearTimeout(r.doneTimer);
  }

  // ------------------------------------------------------------------ modes
  modeState(): ModeState { return this.store.get<ModeState>("mode", { mode: "home", since: Date.now() }); }
  get mode(): Mode { return this.modeState().mode; }

  setMode(mode: Mode | "resume", opts: { until?: number; source?: string } = {}): Mode {
    const cur = this.modeState();
    let next: Mode;
    if (mode === "resume") next = cur.mode === "paused" ? cur.prev ?? "away" : cur.mode;
    else next = mode;
    const st: ModeState = { mode: next, since: Date.now() };
    if (next === "paused") { st.prev = cur.mode === "paused" ? cur.prev ?? "away" : cur.mode; if (opts.until) st.until = opts.until; }
    this.store.set("mode", st);
    log.info(`mode ${cur.mode} -> ${next}${opts.source ? ` (${opts.source})` : ""}`);
    if (cur.mode === "paused" && next !== "paused") this.outbox.releaseHeld();
    return next;
  }

  private checkModeTimers() {
    const st = this.modeState();
    if (st.mode === "paused" && st.until && Date.now() >= st.until) this.setMode("resume", { source: "quiet-until" });
  }

  private checkIdle() {
    const idle = userIdleSeconds();
    if (idle === null) return;
    const st = this.modeState();
    if (this.cfg.modes.autoHome && st.mode === "away" && idle < 25 && Date.now() - st.since > 120_000) {
      this.setMode("home", { source: "auto-home: activity at the computer" });
    } else if (this.cfg.modes.autoAway && st.mode === "home" && idle > this.cfg.modes.autoAwayMinutes * 60 && Date.now() - st.since > 120_000) {
      this.setMode("away", { source: "auto-away: computer idle" });
    }
  }

  // ------------------------------------------------------------------ sessions
  rt(id: string): Runtime {
    let r = this.runtime.get(id);
    if (!r) { r = {}; this.runtime.set(id, r); }
    return r;
  }

  live(): SessionRow[] { return this.store.liveSessions(); }

  private ensureSession(id: string, cwd?: string): SessionRow {
    return this.store.session(id) && this.store.session(id)!.status !== "ended"
      ? this.store.session(id)!
      : this.store.upsertSession({ id, cwd });
  }

  /** Should an unprompted text of this tier go out for this session? */
  shouldNotify(s: SessionRow, tier: Tier): boolean {
    if (s.watch === "muted") return false;
    if (tier === "T5") return s.watch === "watched" && this.mode !== "home";
    if (this.mode === "home") return s.watch === "watched";
    return true;
  }

  private checkLiveness() {
    for (const s of this.live()) {
      if (s.pid && !pidAlive(s.pid)) {
        this.endSession(s, "exited");
      } else if (!s.pid && Date.now() - s.updated_at > 24 * 3600_000) {
        this.store.endSession(s.id, "stale");
      }
    }
  }

  private endSession(s: SessionRow, reason: string) {
    const r = this.rt(s.id);
    if (r.doneTimer) clearTimeout(r.doneTimer);
    this.store.endSession(s.id, reason);
    this.store.addEvent(s.id, "end", reason);
    this.bridges.delete(s.id);
    const unexpected = !["prompt_input_exit", "logout", "clear", "resume"].includes(reason);
    if (unexpected && this.shouldNotify(s, "T4")) {
      this.notify("T4", `${s.name}: session ended (${reason}). Text "resume ${s.name}" to restart it.`, s.id);
    }
  }

  /** Called at startup: sessions whose process died while the hub was down. */
  recoverAfterRestart() {
    const dead = this.live().filter((s) => s.pid && !pidAlive(s.pid));
    for (const s of dead) this.store.endSession(s.id, "reboot");
    if (!dead.length || this.mode === "home") return;
    const names = dead.map((s) => s.name).join(", ");
    for (const to of this.notifyTargets()) {
      this.setSender(to, { ...this.sender(to), confirm: { kind: "resume_many", data: dead.map((s) => s.id), prompt: "", expires: Date.now() + 6 * 3600_000 } });
    }
    this.notify("T4", `Computer restarted. ${dead.length} session(s) were running (${names}). Resume them? y/n`, null);
  }

  // ------------------------------------------------------------------ bridges
  onBridgeHello(conn: BridgeConn, h: BridgeHello & { prevSessionId?: string | null }): { sessionId: string; name: string; num: number } | null {
    if (!h.sessionId) return null;
    if (h.prevSessionId && h.prevSessionId !== h.sessionId && this.store.session(h.prevSessionId)) {
      // /clear: keep the same number and name for the new session id.
      const fresh = this.store.session(h.sessionId);
      if (fresh) this.store.db.query("DELETE FROM sessions WHERE id = ?").run(h.sessionId);
      this.store.rekeySession(h.prevSessionId, h.sessionId);
      this.bridges.delete(h.prevSessionId);
    }
    const row = this.store.upsertSession({
      id: h.sessionId, pid: h.claudePid, cwd: h.cwd, name: h.name ?? undefined, inbound: h.inbound, tmuxPane: h.tmuxPane,
    });
    conn.sessionId = row.id;
    conn.claudePid = h.claudePid;
    conn.version = h.version;
    this.bridges.set(row.id, conn);
    this.store.addEvent(row.id, "bridge", h.inbound ? "connected (can receive texts)" : "connected (send only)");
    if (h.version && h.version !== VERSION && isNewer(h.version, VERSION)) this.restartForUpdate(h.version);
    log.info(`bridge connected: ${row.num} ${row.name} inbound=${h.inbound}`);
    return { sessionId: row.id, name: row.name, num: row.num };
  }

  private restarting = false;
  /** A bridge from a newer plugin version connected: restart onto the new code (service-managed hubs only). */
  private restartForUpdate(newVersion: string) {
    const managed = Boolean(process.env.XPC_SERVICE_NAME?.includes("claude-code-sms") || process.env.INVOCATION_ID);
    if (this.restarting || !managed) { if (!managed) log.warn(`plugin updated to ${newVersion}; restart the hub to use it (ccsms restart)`); return; }
    this.restarting = true;
    log.info(`plugin updated (${VERSION} -> ${newVersion}); restarting the hub`);
    setTimeout(async () => { await this.outbox.drain(); process.exit(75); }, 2000);
  }

  onBridgeClose(conn: BridgeConn) {
    if (conn.sessionId && this.bridges.get(conn.sessionId) === conn) this.bridges.delete(conn.sessionId);
  }

  async onBridgeRequest(conn: BridgeConn, req: BridgeRequest): Promise<string> {
    const s = conn.sessionId ? this.store.session(conn.sessionId) : null;
    if (!s) return "error: this session is not registered with the claude-code-sms hub yet; try again in a few seconds";
    const r = this.rt(s.id);
    const args = req.args ?? {};
    const text = String(args.text ?? args.question ?? "").trim();
    switch (req.op) {
      case "status":
        return this.modeLine(s);
      case "watch": {
        const lv = String(args.level ?? "on");
        const watch = lv === "on" ? "watched" : lv === "off" ? "muted" : "default";
        this.store.updateSession(s.id, { watch });
        return watch === "watched"
          ? `ok: the user will get texts about this session (finished, blocked, milestones) even while at the computer. ${this.modeLine(s)}`
          : watch === "muted" ? "ok: no more texts about this session." : `ok: texts follow the global mode. ${this.modeLine(s)}`;
      }
      case "reply": {
        if (!text) return "error: text is required";
        const recentlyTexted = r.lastInboundAt && Date.now() - r.lastInboundAt < 6 * 3600_000;
        if (this.mode === "home" && s.watch !== "watched" && !recentlyTexted) return "not sent: the user is at the computer";
        if (s.watch === "muted" && !recentlyTexted) return "not sent: the user muted texts for this session";
        const to = r.lastPeer && recentlyTexted ? [r.lastPeer] : this.notifyTargets();
        const res = this.outbox.enqueue({ tier: recentlyTexted ? "T1" : "T3", text: `${s.name}: ${text}`, sessionId: s.id, to });
        if (res.sent) { r.lastReplyAt = Date.now(); this.store.addEvent(s.id, "sms_reply", text.slice(0, 80)); }
        this.budgetCheck();
        return res.sent ? "sent" : `not sent: ${res.reason}`;
      }
      case "update": {
        if (!text) return "error: text is required";
        if (s.watch !== "watched") return "not sent: milestone updates are only sent for watched sessions (held by policy). Keep working.";
        if (this.mode === "home") return "not sent: the user is at the computer";
        const minGap = this.cfg.modes.updateMinMinutes * 60_000;
        if (s.last_update_at && Date.now() - s.last_update_at < minGap) return "not sent (held by policy: too soon after the last text). Keep working; don't retry.";
        const res = this.outbox.enqueue({ tier: "T5", text: `${s.name}: ${text}`, sessionId: s.id, key: `upd:${s.id}` });
        if (res.sent) this.store.updateSession(s.id, { last_update_at: Date.now() });
        return res.sent ? "queued (may be merged or dropped if you finish first)" : `not sent (held by policy: ${res.reason}). Keep working; don't retry.`;
      }
      case "ask": {
        if (!text) return "error: question is required";
        if (!this.shouldNotify(s, "T2") && !(r.lastInboundAt && Date.now() - r.lastInboundAt < 6 * 3600_000)) {
          return "not sent: the user is at the computer; ask them directly in the terminal";
        }
        const options = Array.isArray(args.options) ? (args.options as unknown[]).map(String).slice(0, 9) : [];
        const dflt = args.default ? String(args.default) : "";
        let body = `${s.name}: Q: ${text}`;
        if (options.length) body += " " + options.map((o, i) => `${i + 1} ${o}`).join(" ");
        if (dflt) body += ` Going with ${dflt} unless you say otherwise.`;
        this.store.updateSession(s.id, { pending_question: JSON.stringify({ question: text, options, via: "sms", at: Date.now() }) });
        const to = r.lastPeer && r.lastInboundAt && Date.now() - r.lastInboundAt < 6 * 3600_000 ? [r.lastPeer] : this.notifyTargets();
        if (options.length) for (const p of to) this.setSender(p, { ...this.sender(p), choice: { kind: "answer", options, data: { sessionId: s.id }, expires: Date.now() + 12 * 3600_000 } });
        const res = this.outbox.enqueue({ tier: "T2", text: body, sessionId: s.id, to });
        this.budgetCheck();
        if (!res.sent && !res.queued) return `not sent: ${res.reason}`;
        return dflt
          ? "sent. Keep working with your default; if the user answers, it arrives as a channel message (kind=answer)."
          : "sent. End your turn now; the answer will arrive as a channel message (kind=answer).";
      }
    }
    return "error: unknown operation";
  }

  private modeLine(s: SessionRow): string {
    const m = this.mode;
    const desc = m === "home" ? "home (the user is at the computer; texts are off)" : m === "away" ? "away (the user follows by text)" : "paused (texts held)";
    return `mode: ${desc}; this session: ${s.watch}`;
  }

  // ------------------------------------------------------------------ hooks
  onHook(event: string, body: any): Record<string, unknown> {
    const id: string | undefined = body?.session_id;
    if (!id) return {};
    const now = Date.now();
    switch (event) {
      case "SessionStart": {
        if (body.source === "clear") return {};
        this.ensureSession(id, body.cwd);
        this.store.addEvent(id, "start", body.source);
        return {};
      }
      case "UserPromptSubmit": {
        const s = this.ensureSession(id, body.cwd);
        const r = this.rt(id);
        if (r.doneTimer) { clearTimeout(r.doneTimer); r.doneTimer = undefined; }
        r.turnStart = now; r.lastEventAt = now;
        this.store.updateSession(id, { status: "busy", busy_since: s.busy_since ?? now });
        this.store.addEvent(id, "prompt", String(body.prompt ?? "").slice(0, 60));
        return this.modeNotice(id, "UserPromptSubmit");
      }
      case "PreToolUse": {
        if (body.tool_name === "AskUserQuestion") this.onScreenQuestion(id, body.tool_input);
        return {};
      }
      case "PostToolUse": {
        const s = this.ensureSession(id, body.cwd);
        const r = this.rt(id);
        if (r.doneTimer) { clearTimeout(r.doneTimer); r.doneTimer = undefined; }
        r.lastEventAt = now;
        if (!r.turnStart) r.turnStart = now;
        const tool = String(body.tool_name ?? "");
        if (isSubstantiveTool(tool)) r.lastSubstantiveAt = now;
        if (!tool.startsWith("mcp__plugin_sms") && !/sms_(reply|update|ask|watch)$/.test(tool)) {
          const act = describeTool(tool, body.tool_input);
          this.store.updateSession(id, { status: "busy", busy_since: s.busy_since ?? now, last_activity: act });
          this.store.addEvent(id, "tool", act);
        }
        return this.modeNotice(id, "PostToolUse");
      }
      case "Notification": {
        const s = this.ensureSession(id, body.cwd);
        const type = String(body.notification_type ?? "");
        if (["permission_prompt", "elicitation_dialog", "agent_needs_input"].includes(type)) {
          const r = this.rt(id);
          if (this.shouldNotify(s, "T2") && !(r.lastWaitingAt && now - r.lastWaitingAt < 10 * 60_000)) {
            r.lastWaitingAt = now;
            const msg = String(body.message ?? "needs input").replace(/\s+/g, " ").slice(0, 90);
            this.notify("T2", `${s.name}: WAITING on screen: ${msg}. Text "peek ${s.name}" to see it.`, id);
          }
          this.store.addEvent(id, "waiting", type);
        }
        return {};
      }
      case "Stop": {
        const s = this.ensureSession(id, body.cwd);
        const r = this.rt(id);
        r.lastStopAt = now;
        r.lastStopMessage = String(body.last_assistant_message ?? "");
        const summary = firstParagraph(stripMarkdown(r.lastStopMessage)).slice(0, 200);
        this.store.updateSession(id, { status: "idle", busy_since: null, last_summary: summary || s.last_summary });
        this.store.addEvent(id, "stop", summary.slice(0, 80));
        const bg = body.background_tasks;
        log.debug(`stop ${s.name}: background_tasks=${JSON.stringify(bg ?? null).slice(0, 400)}`);
        const hasBackground = Array.isArray(bg) ? bg.length > 0 : bg && typeof bg === "object" ? Object.keys(bg).length > 0 : false;
        if (!hasBackground) this.scheduleDone(id);
        return {};
      }
      case "StopFailure": {
        const s = this.ensureSession(id, body.cwd);
        const r = this.rt(id);
        this.store.updateSession(id, { status: "idle", busy_since: null });
        this.store.addEvent(id, "failure", String(body.error ?? "error"));
        if (this.shouldNotify(s, "T4") && !(r.lastFailureAt && now - r.lastFailureAt < 30 * 60_000)) {
          r.lastFailureAt = now;
          const kind = body.error === "rate_limit" ? "usage limit reached" : String(body.error ?? "error").replace(/_/g, " ");
          this.notify("T4", `${s.name}: STOPPED (${kind}). Text "retry ${s.name}" when you want it to continue.`, id);
        }
        return {};
      }
      case "SessionEnd": {
        const s = this.store.session(id);
        if (!s || s.status === "ended") return {};
        if (body.reason === "clear") return {};
        this.endSession(s, String(body.reason ?? "other"));
        return {};
      }
    }
    return {};
  }

  private modeNotice(id: string, hookEventName: string): Record<string, unknown> {
    const s = this.store.session(id);
    if (!s) return {};
    const m = this.mode;
    if (s.notified_mode === m) return {};
    this.store.updateSession(id, { notified_mode: m });
    if (s.notified_mode === null && m === "home") return {};
    return { hookSpecificOutput: { hookEventName, additionalContext: MODE_NOTICES[m] } };
  }

  private onScreenQuestion(id: string, input: any) {
    const s = this.store.session(id);
    if (!s || !this.shouldNotify(s, "T2")) return;
    const q = Array.isArray(input?.questions) ? input.questions[0] : input;
    const question = String(q?.question ?? q?.header ?? "a question").replace(/\s+/g, " ").slice(0, 100);
    const options: string[] = Array.isArray(q?.options) ? q.options.map((o: any) => String(o?.label ?? o)).slice(0, 6) : [];
    this.store.updateSession(id, { pending_question: JSON.stringify({ question, options, via: "screen", at: Date.now() }) });
    let body = `${s.name}: Q on screen: ${question}`;
    if (options.length) body += " " + options.map((o, i) => `${i + 1} ${o.slice(0, 25)}`).join(" ");
    if (s.tmux_pane && options.length) {
      body += " (reply a number)";
      for (const p of this.notifyTargets()) this.setSender(p, { ...this.sender(p), choice: { kind: "screen", options, data: { sessionId: id }, expires: Date.now() + 6 * 3600_000 } });
    } else {
      body += ` (answer at the computer)`;
    }
    this.notify("T2", body, id);
  }

  private scheduleDone(id: string) {
    const r = this.rt(id);
    if (r.doneTimer) clearTimeout(r.doneTimer);
    const stopAt = r.lastStopAt ?? Date.now();
    r.doneTimer = setTimeout(() => { r.doneTimer = undefined; void this.maybeSendDone(id, stopAt); }, this.cfg.modes.doneSettleSeconds * 1000);
  }

  async maybeSendDone(id: string, stopAt: number) {
    const s = this.store.session(id);
    const r = this.rt(id);
    if (!s || s.status !== "idle") return;
    if ((r.lastEventAt ?? 0) > stopAt) return; // woke up again
    if (!this.shouldNotify(s, "T3")) { r.turnStart = undefined; return; }
    // The turn ended on a texted question: the question already went out; no "done" yet.
    const pq = s.pending_question ? safeJson(s.pending_question) : null;
    if (pq?.via === "sms" && pq.at >= (r.turnStart ?? stopAt - 3600_000)) { r.turnStart = undefined; return; }
    // An sms_reply after the last substantive work already delivered the result.
    if (r.lastReplyAt && r.lastReplyAt >= (r.lastSubstantiveAt ?? 0) && r.lastReplyAt >= (r.turnStart ?? 0)) { r.turnStart = undefined; return; }
    const dur = r.turnStart && stopAt - r.turnStart >= 60_000 ? ` ${fmtDuration(stopAt - r.turnStart)}` : "";
    r.turnStart = undefined;
    const plain = stripMarkdown(r.lastStopMessage ?? "");
    let summary = firstParagraph(plain);
    if (summary.length > 300) summary = (await this.dispatcher.summarize(plain).catch(() => null)) ?? summary.slice(0, 280) + "...";
    this.outbox.cancelPending((i) => i.sessionId === id && i.tier === "T5");
    this.notify("T3", `${s.name}: DONE${dur}. ${summary || "Finished."}${summary.endsWith("?") ? "" : " Reply to continue."}`.replace(/\s+/g, " "), id, `done:${id}`);
  }

  // ------------------------------------------------------------------ outbound helpers
  notifyTargets(): string[] {
    const n = this.cfg.owners.numbers;
    if (!n.length) return [];
    return this.cfg.owners.notify === "all" ? [...n] : [n[0]];
  }

  notify(tier: Tier, text: string, sessionId: string | null, key?: string) {
    this.outbox.enqueue({ tier, text, sessionId, key });
    this.budgetCheck();
  }

  reply(to: string, text: string, maxSegments = 3) {
    this.outbox.sendPaged(to, text, maxSegments, "T1", null);
    this.budgetCheck();
  }

  private budgetCheck() {
    const b = this.outbox.budget();
    if (b.level === "ok") return;
    const key = `budgetWarned:${startOfToday()}`;
    if (this.store.get(key, false)) return;
    this.store.set(key, true);
    for (const to of this.notifyTargets()) {
      void this.outbox.sendRaw(to, `Budget ${Math.round((b.used / b.limit) * 100)}% used (${b.used}/${b.limit} texts today): essentials only until midnight.`, "T1", null);
    }
  }

  // ------------------------------------------------------------------ inbound
  sender(num: string): SenderState { return this.store.get<SenderState>(`sender:${num}`, {}); }
  setSender(num: string, st: SenderState) { this.store.set(`sender:${num}`, st); }

  isOwner(num: string): boolean { return this.cfg.owners.numbers.includes(num); }

  /** Entry point for a verified inbound text. */
  onInbound(msg: InboundMessage) {
    if (!this.isOwner(msg.from)) {
      const k = `ignored:${msg.from}`;
      if (!this.store.get(k, false)) { log.info(`ignored text from non-owner ${maskNumber(msg.from)}`); this.store.set(k, true); }
      return;
    }
    const text = msg.text.trim();
    this.store.addMessage({ direction: "in", peer: msg.from, body: msg.text, segments: 1, cost: null, currency: null, provider_id: msg.id, status: "received", tier: null, session_id: null });
    if (!text) {
      if (msg.mediaCount) this.reply(msg.from, "Pictures aren't supported yet; please text words.", 1);
      return;
    }
    if (RESERVED_KEYWORDS.test(text)) {
      log.warn(`owner texted the carrier keyword "${text}"; the provider may now block texts to this number until they text START`);
      this.store.set("optOutWarning", { at: Date.now(), from: msg.from, keyword: text });
      return;
    }
    // Commands (and every text while capturing) are handled immediately and in order;
    // other texts are merged for a moment because phones split long messages.
    const st = this.sender(msg.from);
    const immediate = st.capture?.active || /^(send|discard)$/i.test(text) || parseCommand(text, { pendingChoice: Boolean(st.choice), pendingConfirm: Boolean(st.confirm) }) !== null;
    if (immediate) {
      this.flushDebounce(msg.from);
      this.enqueueText(msg.from, msg.text);
      return;
    }
    const d = this.debounce.get(msg.from);
    if (d) { clearTimeout(d.timer); d.texts.push(msg.text); }
    const entry = d ?? { texts: [msg.text], timer: null as any };
    entry.timer = setTimeout(() => this.flushDebounce(msg.from), this.debounceMs);
    this.debounce.set(msg.from, entry);
  }

  private flushDebounce(from: string) {
    const d = this.debounce.get(from);
    if (!d) return;
    clearTimeout(d.timer);
    this.debounce.delete(from);
    this.enqueueText(from, d.texts.join("\n"));
  }

  private queues = new Map<string, Promise<void>>();
  /** Process texts from one sender strictly in arrival order. */
  enqueueText(from: string, text: string): Promise<void> {
    const prev = this.queues.get(from) ?? Promise.resolve();
    const next = prev.then(() => this.processText(from, text)).catch((e) => log.error("processing a text failed", e));
    this.queues.set(from, next);
    return next;
  }

  async processText(from: string, rawText: string): Promise<void> {
    const text = rawText.trim();
    const t = text.toLowerCase();
    let st = this.sender(from);
    const now = Date.now();

    if (this.store.get("lockdown", false)) {
      if (!st.lastLockNotice || now - st.lastLockNotice > 3600_000) {
        this.setSender(from, { ...st, lastLockNotice: now });
        this.reply(from, "Locked down: texts are ignored until you run 'ccsms unlock' at the computer.", 1);
      }
      return;
    }

    if (this.cfg.security.unlockPin) {
      const unlockedUntil = this.store.get<number>("unlockedUntil", 0);
      const m = text.match(/^unlock\s+(\d{4,12})$/i);
      if (m) { await this.execute(from, { type: "unlock", pin: m[1] }); return; }
      if (unlockedUntil < now && !/^(s|status|\?|cmds|away|home|pause|resume|more)$/.test(t)) {
        if (!st.lastLockNotice || now - st.lastLockNotice > 600_000) {
          this.setSender(from, { ...st, lastLockNotice: now });
          this.reply(from, "Locked. Text: unlock <your PIN>", 1);
        }
        return;
      }
    }

    // Capture mode
    if (st.capture) {
      if (st.capture.active && now - st.capture.lastAt > 30 * 60_000) st.capture.active = false;
      if (t === "send" && st.capture.parts.length) { await this.previewCapture(from, st); return; }
      if (t === "discard") {
        this.setSender(from, { ...st, capture: undefined });
        this.reply(from, "Discarded.", 1);
        return;
      }
      if (st.capture.active) {
        st.capture.parts.push(rawText.trim());
        st.capture.lastAt = now;
        this.setSender(from, st);
        return;
      }
    }

    if (st.confirm && st.confirm.expires < now) { st = { ...st, confirm: undefined }; this.setSender(from, st); }
    if (st.choice && st.choice.expires < now) { st = { ...st, choice: undefined }; this.setSender(from, st); }

    let action = parseCommand(text, { pendingChoice: Boolean(st.choice), pendingConfirm: Boolean(st.confirm) });
    if (!action) action = await this.route(from, text);
    await this.execute(from, action);
  }

  private async route(from: string, text: string): Promise<Action> {
    const live = this.live();
    const inbound = live.filter((s) => s.inbound && this.bridges.has(s.id));
    const ctx = this.routerContext(from, text, live);
    const d = await this.dispatcher.route(ctx);
    if (d) return decisionToAction(d, text);
    // Dispatcher unavailable: deliver to the only session that can receive texts, if unambiguous.
    const st = this.sender(from);
    const sticky = st.sticky && Date.now() - st.sticky.at < 30 * 60_000 ? st.sticky.sessionId : null;
    const target = inbound.find((s) => s.id === sticky) ?? (inbound.length === 1 ? inbound[0] : null);
    if (target) return { type: "deliver", target: { num: target.num }, text, kind: "prompt" };
    return { type: "reply", text: "Dispatcher unavailable right now. Address a session directly (@name msg or 2: msg) or text ? for commands." };
  }

  routerContext(from: string, text: string, live = this.live()): string {
    const st = this.sender(from);
    const lines: string[] = [];
    lines.push(`Time: ${new Date().toString()}`);
    lines.push(`Mode: ${this.mode}`);
    lines.push("Sessions:");
    if (!live.length) lines.push("  (none running)");
    for (const s of live) {
      const canText = s.inbound && this.bridges.has(s.id) ? "can receive texts" : "CANNOT receive texts";
      const busy = s.status === "busy" ? `busy ${fmtDuration(Date.now() - (s.busy_since ?? Date.now()))}` : "idle";
      const pq = s.pending_question ? safeJson(s.pending_question)?.question : null;
      lines.push(`  ${s.num} ${s.name} | folder ${s.cwd} | ${busy} | ${canText} | last: ${s.last_activity ?? "-"} | summary: ${s.last_summary ?? "-"}${pq ? ` | WAITING ON QUESTION: ${pq}` : ""}`);
    }
    const ended = this.store.recentEnded(5);
    if (ended.length) lines.push("Recently ended (can be resumed): " + ended.map((s) => s.name).join(", "));
    if (st.sticky) {
      const s = this.store.session(st.sticky.sessionId);
      if (s) lines.push(`Sticky target: ${s.num} ${s.name}, set ${fmtDuration(Date.now() - st.sticky.at)} ago`);
    }
    // What the hub is waiting for from this user.
    const lastOut = [...this.store.recentMessages(from, 6)].reverse().find((m) => m.direction === "out");
    if (st.confirm && st.confirm.expires > Date.now()) {
      lines.push(`Hub is waiting for a yes/no confirmation (${st.confirm.kind}) to its last message: ${JSON.stringify(lastOut?.body ?? "")}`);
    }
    if (st.choice && st.choice.expires > Date.now()) {
      const c = st.choice;
      const opts = c.kind === "route"
        ? (c.options as number[]).map((n) => `${n} = session ${n} ${this.live().find((x) => x.num === n)?.name ?? ""}`.trim())
        : (c.options as string[]).map((o, i) => `${i + 1} = ${o}`);
      const what = c.kind === "route" ? "which session should get the user's text" : c.kind === "answer" ? "an answer to a session's question" : "an answer to a question on a session's screen";
      lines.push(`Hub is waiting for a numbered choice (${what}): ${opts.join("; ")}`);
    }
    if (st.capture?.parts.length) {
      const t = st.capture.target ? this.store.session(st.capture.target)?.name : null;
      lines.push(`A captured multi-text prompt (${st.capture.parts.length} parts) is ${st.capture.active ? "still being collected" : "waiting to be sent"}${t ? `, proposed target ${t}` : ""}.`);
    }
    const recent = this.store.recentMessages(from, 10);
    if (recent.length) {
      lines.push("Recent messages (oldest first):");
      for (const m of recent) lines.push(`  ${m.direction === "in" ? "user" : "hub"}: ${m.body.replace(/\s+/g, " ").slice(0, 160)}`);
    }
    lines.push(`New message: ${JSON.stringify(text)}`);
    return lines.join("\n");
  }

  resolveTarget(ref: SessionRef | null, from: string, opts: { includeEnded?: boolean } = {}): SessionRow | null {
    const live = this.live();
    if (!ref) {
      const st = this.sender(from);
      if (st.sticky && Date.now() - st.sticky.at < 30 * 60_000) {
        const s = this.store.session(st.sticky.sessionId);
        if (s && s.status !== "ended") return s;
      }
      const inbound = live.filter((s) => s.inbound && this.bridges.has(s.id));
      return inbound.length === 1 ? inbound[0] : null;
    }
    const pool = opts.includeEnded ? [...live, ...this.store.recentEnded(20)] : live;
    if (ref.num !== undefined) return pool.find((s) => s.num === ref.num && s.status !== "ended") ?? (opts.includeEnded ? null : null);
    const name = ref.name!;
    return pool.find((s) => s.name === name) ?? pool.find((s) => s.name.startsWith(name)) ?? null;
  }

  private sessionListShort(filter: (s: SessionRow) => boolean = () => true): string {
    return this.live().filter(filter).map((s) => `${s.num} ${s.name}`).join(" ");
  }

  async execute(from: string, a: Action): Promise<void> {
    const st = this.sender(from);
    switch (a.type) {
      case "help": return this.reply(from, HELP_TEXT, 3);
      case "status": return this.reply(from, a.cost ? this.costText() : this.statusText(), 3);
      case "more":
        if (!this.outbox.sendMore(from)) this.reply(from, "Nothing more.", 1);
        return;
      case "mode": {
        let until: number | undefined;
        if (a.until) {
          const d = parseClockTime(a.until);
          if (!d) return this.reply(from, `Didn't understand the time "${a.until}". Try: quiet until 3pm`, 1);
          until = d.getTime();
        }
        const m = this.setMode(a.mode, { until, source: "text" });
        const msg = m === "away" ? "Away: I'll text when sessions finish, fail or need you."
          : m === "home" ? "Home: texts off (replies to your texts still work)."
          : until ? `Paused until ${fmtClock(until)}. I'll send one catch-up text then.` : "Paused. Text resume for a catch-up.";
        return this.reply(from, msg, 1);
      }
      case "watch": {
        const s = this.resolveTarget(a.target, from);
        if (!s) return this.reply(from, `No session "${refText(a.target)}". Running: ${this.sessionListShort() || "none"}`, 1);
        this.store.updateSession(s.id, { watch: a.level });
        return this.reply(from, a.level === "watched" ? `Watching ${s.name}: milestones too.` : a.level === "muted" ? `Muted ${s.name}.` : `${s.name} follows the mode again.`, 1);
      }
      case "capture_start": {
        const s = a.target ? this.resolveTarget(a.target, from) : null;
        if (a.target && !s) return this.reply(from, `No session "${refText(a.target)}". Running: ${this.sessionListShort() || "none"}`, 1);
        this.setSender(from, { ...st, capture: { active: true, parts: [], target: s?.id ?? null, lastAt: Date.now() } });
        return this.reply(from, `OK, send your prompt in as many texts as you like${s ? ` (for ${s.name})` : ""}. Then text send, or discard.`, 1);
      }
      case "model": {
        if (!a.model) return this.reply(from, `Dispatcher: ${this.cfg.router.model}, summarizer: ${this.cfg.summarizer.model}. Change: model haiku`, 1);
        const next = structuredClone(this.cfg);
        if (a.which !== "summarizer") next.router.model = a.model;
        if (a.which !== "router") next.summarizer.model = a.model;
        try { saveConfig(next, this.configFile); this.cfg = next; this.cfgMtime = mtime(this.configFile); }
        catch (e: any) { return this.reply(from, `Couldn't change the model: ${e.message}`, 1); }
        return this.reply(from, `Now using ${a.model} for ${a.which === "both" ? "dispatcher and summarizer" : a.which}.`, 1);
      }
      case "unlock": {
        if (!this.cfg.security.unlockPin) return this.reply(from, "No PIN is set; nothing to unlock.", 1);
        if (a.pin !== this.cfg.security.unlockPin) return this.reply(from, "Wrong PIN.", 1);
        this.store.set("unlockedUntil", Date.now() + this.cfg.security.unlockHours * 3600_000);
        return this.reply(from, `Unlocked for ${this.cfg.security.unlockHours}h.`, 1);
      }
      case "lockdown":
        this.store.set("lockdown", true);
        return this.reply(from, "Locked down. Texts are ignored until you run 'ccsms unlock' at the computer.", 1);
      case "confirm":
        if (!st.confirm) return this.reply(from, "Nothing is waiting for a yes/no right now.", 1);
        return this.onConfirm(from, st, a.yes);
      case "choice":
        if (!st.choice) return this.reply(from, "Nothing is waiting for a choice right now.", 1);
        return this.onChoice(from, st, a.n);
      case "capture_send": {
        const cap = st.capture;
        if (!cap?.parts.length) return this.reply(from, "No captured prompt to send. Text prompt to start one.", 1);
        this.setSender(from, { ...st, capture: undefined, confirm: undefined, choice: undefined });
        return this.deliver(from, a.target, cap.parts.join("\n\n"), "prompt");
      }
      case "capture_discard":
        this.setSender(from, { ...st, capture: undefined, confirm: st.confirm?.kind === "capture_send" ? undefined : st.confirm });
        return this.reply(from, "Discarded.", 1);
      case "reply": {
        if (a.clarifyText) {
          const opts = this.live().filter((s) => s.inbound && this.bridges.has(s.id)).map((s) => s.num);
          this.setSender(from, { ...st, choice: { kind: "route", options: opts, data: { text: a.clarifyText, kind: a.clarifyKind ?? "prompt" }, expires: Date.now() + 30 * 60_000 } });
        }
        return this.reply(from, a.text, 2);
      }
      case "deliver": return this.deliver(from, a.target, a.text, a.kind, a.inferred);
      case "peek": {
        const s = this.resolveTarget(a.target, from);
        if (!s) return this.reply(from, `Which session? ${this.sessionListShort() || "None running."}`, 1);
        if (!s.tmux_pane || !tmux.paneAlive(s.tmux_pane)) return this.reply(from, `${s.name} isn't running in tmux, so I can't see its screen. Start sessions with claude-sms.`, 1);
        const screen = tmux.peekPane(s.tmux_pane, 12) ?? "";
        return this.reply(from, `${s.name} screen:\n${screen || "(blank)"}`, 2);
      }
      case "halt": {
        const s = this.resolveTarget(a.target, from);
        if (!s) return this.reply(from, `Which session? ${this.sessionListShort() || "None running."}`, 1);
        if (!s.tmux_pane || !tmux.paneAlive(s.tmux_pane)) return this.reply(from, `${s.name} isn't running in tmux, so I can't interrupt it.`, 1);
        this.setSender(from, { ...st, confirm: { kind: "halt", data: s.id, prompt: "", expires: Date.now() + 10 * 60_000 } });
        return this.reply(from, `Interrupt ${s.name} (press Esc)? y/n`, 1);
      }
      case "resume_session": {
        const s = this.resolveTarget(a.target, from, { includeEnded: true });
        if (!s) return this.reply(from, `No session "${refText(a.target)}" to resume.`, 1);
        if (s.status !== "ended" && s.pid && pidAlive(s.pid)) return this.reply(from, `${s.name} is still running.`, 1);
        this.setSender(from, { ...st, confirm: { kind: "resume", data: s.id, prompt: "", expires: Date.now() + 10 * 60_000 } });
        return this.reply(from, `Resume ${s.name} in ${shortPath(s.cwd)}? y/n`, 1);
      }
      case "spawn": {
        const check = this.checkSpawn(a.dir);
        if ("error" in check) return this.reply(from, check.error, 2);
        this.setSender(from, { ...st, confirm: { kind: "spawn", data: { dir: check.dir, prompt: a.prompt, worktree: a.worktree }, prompt: "", expires: Date.now() + 10 * 60_000 } });
        return this.reply(from, `Start a session in ${shortPath(check.dir)} with "${a.prompt.slice(0, 60)}"? y/n`, 2);
      }
      case "rename": {
        const s = this.resolveTarget(a.target, from);
        if (!s) return this.reply(from, `No session "${refText(a.target)}".`, 1);
        const n = this.store.renameSession(s.id, a.name);
        return this.reply(from, `${s.num} is now ${n}.`, 1);
      }
      case "retry": {
        const s = a.target ? this.resolveTarget(a.target, from) : this.live().filter((x) => x.inbound).sort((x, y) => (this.rt(y.id).lastFailureAt ?? 0) - (this.rt(x.id).lastFailureAt ?? 0))[0];
        if (!s) return this.reply(from, "Which session? Text status.", 1);
        return this.deliver(from, { num: s.num }, "Please continue where you left off.", "prompt");
      }
    }
  }

  private async previewCapture(from: string, st: SenderState) {
    const cap = st.capture!;
    const all = cap.parts.join("\n\n");
    const first = cap.parts[0].replace(/\s+/g, " ").slice(0, 30);
    const last = cap.parts[cap.parts.length - 1].replace(/\s+/g, " ").slice(-25);
    cap.active = false;
    const target = cap.target ? this.store.session(cap.target) : this.resolveTarget(null, from);
    const head = `${cap.parts.length} part${cap.parts.length > 1 ? "s" : ""}, ${all.length} chars. "${first}..."${cap.parts.length > 1 ? ` ... "...${last}"` : ""}.`;
    if (target && target.status !== "ended") {
      this.setSender(from, { ...st, capture: cap, confirm: { kind: "capture_send", data: { sessionId: target.id }, prompt: all, expires: Date.now() + 30 * 60_000 } });
      return this.reply(from, `${head} Send to ${target.name}? y/n`, 2);
    }
    const opts = this.live().filter((s) => s.inbound && this.bridges.has(s.id));
    if (!opts.length) {
      this.setSender(from, { ...st, capture: cap });
      return this.reply(from, `${head} No session can receive it right now. Start one with claude-sms, then text send again.`, 2);
    }
    this.setSender(from, { ...st, capture: cap, choice: { kind: "route", options: opts.map((s) => s.num), data: { text: all, kind: "prompt", fromCapture: true }, expires: Date.now() + 30 * 60_000 } });
    return this.reply(from, `${head} Send to? ${opts.map((s) => `${s.num} ${s.name}`).join(" ")}`, 2);
  }

  private async onConfirm(from: string, st: SenderState, yes: boolean) {
    const c = st.confirm!;
    this.setSender(from, { ...st, confirm: undefined });
    if (!yes) {
      if (c.kind === "capture_send") this.setSender(from, { ...this.sender(from), capture: { ...st.capture!, active: false } });
      return this.reply(from, c.kind === "capture_send" ? "Not sent. Text send to try again, or discard." : "OK, cancelled.", 1);
    }
    switch (c.kind) {
      case "capture_send": {
        this.setSender(from, { ...this.sender(from), capture: undefined });
        const s = this.store.session(c.data.sessionId);
        if (!s) return this.reply(from, "That session is gone. Text send to pick another.", 1);
        return this.deliver(from, { num: s.num }, c.prompt, "prompt");
      }
      case "halt": {
        const s = this.store.session(c.data);
        if (!s?.tmux_pane || !tmux.sendKeys(s.tmux_pane, "Escape")) return this.reply(from, "Couldn't interrupt it.", 1);
        return this.reply(from, `Interrupted ${s.name}.`, 1);
      }
      case "resume": {
        const s = this.store.session(c.data);
        if (!s) return this.reply(from, "Session not found.", 1);
        const r = await this.launchSession(s.cwd, ["--resume", s.id], s.name);
        return this.reply(from, r.ok ? `Resuming ${s.name}. Text it in a moment.` : `Couldn't resume: ${r.error}`, 1);
      }
      case "resume_many": {
        const out: string[] = [];
        for (const id of c.data as string[]) {
          const s = this.store.session(id);
          if (!s) continue;
          const r = await this.launchSession(s.cwd, ["--resume", s.id], s.name);
          out.push(`${s.name} ${r.ok ? "ok" : "failed"}`);
        }
        return this.reply(from, `Resume: ${out.join(", ") || "nothing to resume"}.`, 1);
      }
      case "spawn": {
        const live = this.live().length;
        if (live >= this.cfg.spawn.max) return this.reply(from, `Already ${live} sessions (max ${this.cfg.spawn.max}).`, 1);
        const args = c.data.worktree ? ["--worktree"] : [];
        const r = await this.launchSession(c.data.dir, [...args, c.data.prompt], undefined);
        return this.reply(from, r.ok ? `Started a session in ${shortPath(c.data.dir)}. I'll text when it finishes.` : `Couldn't start it: ${r.error}`, 1);
      }
    }
  }

  private async onChoice(from: string, st: SenderState, n: number) {
    const c = st.choice!;
    switch (c.kind) {
      case "route": {
        if (!c.options.includes(n)) return this.reply(from, `Pick one of: ${c.options.join(" ")}`, 1);
        this.setSender(from, { ...st, choice: undefined, capture: c.data.fromCapture ? undefined : st.capture });
        return this.deliver(from, { num: n }, c.data.text, c.data.kind ?? "prompt");
      }
      case "answer": {
        const opt = c.options[n - 1];
        if (opt === undefined) return this.reply(from, `Pick 1-${c.options.length}.`, 1);
        this.setSender(from, { ...st, choice: undefined });
        const s = this.store.session(c.data.sessionId);
        if (!s) return this.reply(from, "That session is gone.", 1);
        return this.deliver(from, { num: s.num }, `${n} (${opt})`, "answer");
      }
      case "screen": {
        const opt = c.options[n - 1];
        if (opt === undefined) return this.reply(from, `Pick 1-${c.options.length}.`, 1);
        this.setSender(from, { ...st, choice: undefined });
        const s = this.store.session(c.data.sessionId);
        if (!s?.tmux_pane || !tmux.paneAlive(s.tmux_pane)) return this.reply(from, "Can't reach that screen anymore.", 1);
        tmux.sendKeys(s.tmux_pane, String(n));
        await Bun.sleep(300);
        tmux.sendKeys(s.tmux_pane, "Enter");
        this.store.updateSession(s.id, { pending_question: null });
        return this.reply(from, `Picked ${n} (${opt}) for ${s.name}.`, 1);
      }
    }
  }

  async deliver(from: string, ref: SessionRef | null, text: string, kind: "prompt" | "question" | "answer", inferred?: boolean): Promise<void> {
    const s = this.resolveTarget(ref, from);
    const st = this.sender(from);
    if (!s) {
      const opts = this.live().filter((x) => x.inbound && this.bridges.has(x.id));
      if (ref) return this.reply(from, `No session "${refText(ref)}". ${opts.length ? `Running: ${opts.map((x) => `${x.num} ${x.name}`).join(" ")}` : "None can receive texts."}`, 1);
      if (!opts.length) return this.reply(from, "No session can receive texts right now. Start one with claude-sms (or text: new <folder>: <prompt>).", 1);
      this.setSender(from, { ...st, choice: { kind: "route", options: opts.map((x) => x.num), data: { text, kind }, expires: Date.now() + 30 * 60_000 } });
      return this.reply(from, `Which session? ${opts.map((x) => `${x.num} ${x.name}`).join(" ")}`, 1);
    }
    const bridge = this.bridges.get(s.id);
    if (!s.inbound || !bridge) {
      return this.reply(from, `${s.name} can't receive texts (it wasn't started with claude-sms). It will still text you when it finishes.`, 1);
    }
    let k = kind;
    if (s.pending_question && k !== "question") { k = "answer"; this.store.updateSession(s.id, { pending_question: null }); }
    const msgId = String(Date.now());
    bridge.send({ t: "deliver", content: text, meta: { kind: k, msg_id: msgId } });
    const r = this.rt(s.id);
    r.lastInboundAt = Date.now();
    r.lastPeer = from;
    this.setSender(from, { ...this.sender(from), sticky: { sessionId: s.id, at: Date.now() } });
    this.store.addEvent(s.id, "sms_in", `${k}: ${text.slice(0, 60)}`);
    // Watched-or-not, a session the user is texting should report back.
    if (s.status === "busy") {
      return this.reply(from, `${s.name} is busy (${fmtDuration(Date.now() - (s.busy_since ?? Date.now()))}); it'll see this after its current step.`, 1);
    }
    if (inferred && this.live().filter((x) => x.inbound).length > 1) return this.reply(from, `-> ${s.name}`, 1);
  }

  // ------------------------------------------------------------------ spawning
  private checkSpawn(dirInput: string): { dir: string } | { error: string } {
    const roots = this.cfg.spawn.roots.map(expandHome);
    if (!roots.length) return { error: "Starting sessions by text is off. Enable it at the computer: ccsms config set spawn.roots ~/code" };
    if (!tmux.tmuxAvailable()) return { error: "tmux isn't installed, so I can't start sessions." };
    const want = dirInput.trim();
    const candidates: string[] = [];
    if (want.startsWith("/") || want.startsWith("~")) candidates.push(resolve(expandHome(want)));
    else for (const r of roots) candidates.push(join(r, want));
    for (const c of candidates) {
      if (!roots.some((r) => c === r || c.startsWith(r.endsWith("/") ? r : r + "/"))) continue;
      try { if (statSync(c).isDirectory()) return { dir: c }; } catch {}
    }
    return { error: `No folder "${want}" under ${roots.map(shortPath).join(", ")}.` };
  }

  channelSpec(): string {
    try {
      const j = JSON.parse(readFileSync(paths.installJson, "utf8"));
      if (j.channelSpec) return j.channelSpec;
    } catch {}
    return "plugin:sms@claude-code-sms";
  }

  async launchSession(dir: string, claudeArgs: string[], name?: string): Promise<{ ok: boolean; name?: string; error?: string }> {
    if (!tmux.tmuxAvailable()) return { ok: false, error: "tmux not installed" };
    if (!existsSync(dir)) return { ok: false, error: "folder not found" };
    const base = (name ?? dir.split("/").filter(Boolean).pop() ?? "session").toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 10);
    let tname = `ccsms-${base}`;
    for (let i = 2; tmux.sessionExists(tname) && i < 50; i++) tname = `ccsms-${base}-${i}`;
    const claude = findClaude(this.cfg.system.claudePath);
    const cmd = [claude, `--dangerously-load-development-channels=${this.channelSpec()}`, ...claudeArgs];
    const pane = tmux.newDetachedSession(tname, dir, cmd, { CCSMS_CHANNEL: "1" });
    if (!pane) return { ok: false, error: "tmux failed to start" };
    // Accept the development-channels warning (the user opted into starting sessions by text).
    const accepted = await tmux.waitForAndPress(pane, /local development/i, ["Enter"], 30_000);
    if (!accepted) {
      const screen = tmux.capturePane(pane, 30) ?? "";
      if (/trust/i.test(screen)) {
        tmux.sendKeys(pane, "Escape");
        return { ok: false, error: "the folder isn't trusted yet; open it once with claude at the computer" };
      }
    }
    await Bun.sleep(2500);
    if (!tmux.paneAlive(pane)) return { ok: false, error: "claude exited right after starting (try it at the computer: claude-sms)" };
    return { ok: true, name: base };
  }

  // ------------------------------------------------------------------ provider events
  onStatus(ev: StatusEvent) {
    if (!ev.providerId) return;
    this.store.updateMessageByProviderId(ev.providerId, { status: ev.status, cost: ev.cost, currency: ev.currency });
  }

  async configureWebhook(publicUrl: string) {
    this.publicUrl = publicUrl;
    if (this.provider.id === "fake" || !this.cfg.provider.number) return;
    const url = `${publicUrl}/sms/${this.provider.id}`;
    try {
      const updates = await this.provider.configureWebhook(this.cfg.provider.number, url, {
        destinations: destinationsFor(this.cfg.owners.numbers),
        profileId: this.cfg.provider.messagingProfileId || undefined,
      } as any);
      if (updates.messagingProfileId && updates.messagingProfileId !== this.cfg.provider.messagingProfileId) {
        const next = structuredClone(this.cfg);
        next.provider.messagingProfileId = updates.messagingProfileId;
        saveConfig(next, this.configFile);
        this.cfg = next;
        this.cfgMtime = mtime(this.configFile);
      }
      this.store.set("webhook", { url, at: Date.now(), ok: true });
      log.info(`webhook set: ${url}`);
    } catch (e: any) {
      this.store.set("webhook", { url, at: Date.now(), ok: false, error: String(e?.message ?? e) });
      log.error("could not configure the provider webhook", e?.message ?? e);
    }
  }

  // ------------------------------------------------------------------ status text
  statusText(): string {
    const live = this.live();
    const lines = [`Mode: ${this.mode}${this.modeState().until ? ` until ${fmtClock(this.modeState().until!)}` : ""}.`];
    if (!live.length) lines.push("No sessions running.");
    for (const s of live) {
      const pq = s.pending_question ? " Q waiting." : "";
      const recv = s.inbound && this.bridges.has(s.id) ? "" : " (no texts in)";
      const tag = s.watch === "watched" ? " [watched]" : s.watch === "muted" ? " [muted]" : "";
      if (s.status === "busy") lines.push(`${s.num} ${s.name} BUSY ${fmtDuration(Date.now() - (s.busy_since ?? Date.now()))}: ${s.last_activity ?? "working"}.${pq}${recv}${tag}`);
      else lines.push(`${s.num} ${s.name} idle.${pq}${s.last_summary ? ` ${s.last_summary.slice(0, 70)}` : ""}${recv}${tag}`);
    }
    return lines.join("\n");
  }

  costText(): string {
    const day = this.store.usageSince(startOfToday());
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const mon = this.store.usageSince(monthStart.getTime());
    const cur = mon.currency ?? "USD";
    return `Today: ${day.outSegments} out, ${day.inSegments} in, ${day.cost.toFixed(3)} ${cur}. Month: ${mon.outSegments} out, ${mon.inSegments} in, ${mon.cost.toFixed(2)} ${cur}. Budget ${this.cfg.budget.dailySegments}/day.`;
  }

  statusJson() {
    return {
      mode: this.modeState(),
      provider: this.provider.id,
      number: this.cfg.provider.number,
      owners: this.cfg.owners.numbers.length,
      publicUrl: this.publicUrl,
      webhook: this.store.get("webhook", null),
      lastSendError: this.store.get("lastSendError", null),
      optOutWarning: this.store.get("optOutWarning", null),
      lockdown: this.store.get("lockdown", false),
      budget: this.outbox.budget(),
      cost: this.costText(),
      sessions: this.live().map((s) => ({
        num: s.num, name: s.name, id: s.id, status: s.status, cwd: s.cwd, watch: s.watch,
        canReceive: Boolean(s.inbound && this.bridges.has(s.id)), tmux: Boolean(s.tmux_pane),
        activity: s.last_activity, summary: s.last_summary,
      })),
      models: { router: this.cfg.router.model, summarizer: this.cfg.summarizer.model },
    };
  }
}

// ------------------------------------------------------------------ utils
function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0); }
  return false;
}
function mtime(f: string): number {
  try { return statSync(f).mtimeMs; } catch { return 0; }
}
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}
function safeJson(s: string): any { try { return JSON.parse(s); } catch { return null; } }
function refText(r: SessionRef | null): string { return r ? (r.name ?? String(r.num)) : "?"; }
function expandHome(p: string): string { return p.startsWith("~") ? join(homedir(), p.slice(1)) : p; }
function shortPath(p: string): string { const h = homedir(); return p.startsWith(h) ? "~" + p.slice(h.length) : p; }
