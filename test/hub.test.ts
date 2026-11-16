import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "ccsms-test-"));
process.env.CCSMS_HOME = home;

const { Store } = await import("../src/shared/db.ts");
const { saveConfig, DEFAULT_CONFIG } = await import("../src/shared/config.ts");
const { Hub } = await import("../src/hub/hub.ts");
const { FakeProvider } = await import("../src/providers/fake.ts");

const OWNER = "+15550001234";
const STRANGER = "+15559999999";

type Sent = { to: string; body: string };

function makeHub(opts: { router?: (input: string) => any; summary?: string; cfg?: (c: any) => void } = {}) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.owners.numbers = [OWNER];
  cfg.modes.doneSettleSeconds = 0;
  cfg.tunnel.kind = "none";
  opts.cfg?.(cfg);
  const file = join(home, `config-${Math.random()}.toml`);
  saveConfig(cfg, file);
  const sent: Sent[] = [];
  const provider = new FakeProvider((to, body) => sent.push({ to, body }));
  const routerCalls: string[] = [];
  const runner = async (args: string[], input: string) => {
    if (args.includes("--json-schema")) {
      routerCalls.push(input);
      const d = opts.router?.(input) ?? { action: "answer", reply: "ok" };
      return { ok: true, stdout: JSON.stringify({ structured_output: d, is_error: false }), stderr: "" };
    }
    return { ok: true, stdout: JSON.stringify({ result: opts.summary ?? "Summarized.", is_error: false }), stderr: "" };
  };
  const hub = new Hub(new Store(":memory:"), { runner, provider, configFile: file, noTimers: true });
  hub.outbox.batchMs = 10;
  hub.debounceMs = 0;
  return { hub, sent, routerCalls };
}

function bridge(hub: InstanceType<typeof Hub>, sessionId: string, opts: { cwd?: string; inbound?: boolean; pid?: number } = {}) {
  const got: any[] = [];
  const conn = { sessionId: null as string | null, claudePid: null as number | null, version: "", send: (m: any) => got.push(m) };
  const w = hub.onBridgeHello(conn as any, {
    t: "hello", pid: 1, claudePid: opts.pid ?? process.pid, sessionId, cwd: opts.cwd ?? "/tmp/webapp", name: null,
    inbound: opts.inbound ?? true, tmuxPane: null, version: "test",
  });
  return { conn, got, welcome: w };
}

const flush = async (hub: InstanceType<typeof Hub>) => { await Bun.sleep(30); await hub.outbox.drain(); };
const text = (hub: InstanceType<typeof Hub>, body: string, from = OWNER) => hub.processText(from, body);

describe("hub", () => {
  test("ignores texts from numbers that aren't owners", async () => {
    const { hub, sent, routerCalls } = makeHub();
    hub.onInbound({ kind: "message", id: "1", from: STRANGER, to: "", text: "status", mediaCount: 0 });
    await flush(hub);
    expect(sent).toEqual([]);
    expect(routerCalls).toEqual([]);
  });

  test("status lists sessions", async () => {
    const { hub, sent } = makeHub();
    bridge(hub, "s1", { cwd: "/code/webapp" });
    await text(hub, "status");
    await flush(hub);
    expect(sent[0].to).toBe(OWNER);
    expect(sent[0].body).toContain("1 webapp idle");
  });

  test("explicit @name delivers verbatim to the bridge without an ack", async () => {
    const { hub, sent } = makeHub();
    const b = bridge(hub, "s1", { cwd: "/code/webapp" });
    await text(hub, "@webapp add a dark mode toggle");
    await flush(hub);
    expect(b.got.find((m) => m.t === "deliver")).toMatchObject({ content: "add a dark mode toggle", meta: { kind: "prompt" } });
    expect(sent).toEqual([]);
  });

  test("router decides the target; text is never rewritten", async () => {
    const { hub } = makeHub({ router: () => ({ action: "deliver", target: 2, kind: "prompt", reply: "rewritten" }) });
    bridge(hub, "s1", { cwd: "/code/webapp" });
    const b2 = bridge(hub, "s2", { cwd: "/code/mlhw" });
    await text(hub, "use the cleaned dataset for fig 2");
    expect(b2.got.find((m) => m.t === "deliver")?.content).toBe("use the cleaned dataset for fig 2");
  });

  test("clarify then numeric choice delivers the original text", async () => {
    const { hub, sent } = makeHub({ router: () => ({ action: "clarify", reply: "Which? 1 webapp 2 mlhw" }) });
    bridge(hub, "s1", { cwd: "/code/webapp" });
    const b2 = bridge(hub, "s2", { cwd: "/code/mlhw" });
    await text(hub, "run the tests");
    await flush(hub);
    expect(sent.at(-1)!.body).toContain("Which?");
    await text(hub, "2");
    expect(b2.got.find((m) => m.t === "deliver")?.content).toBe("run the tests");
  });

  test("away: Stop -> DONE text with the first paragraph", async () => {
    const { hub, sent } = makeHub();
    bridge(hub, "s1", { cwd: "/code/webapp" });
    hub.setMode("away");
    hub.onHook("UserPromptSubmit", { session_id: "s1", prompt: "x" });
    hub.onHook("PostToolUse", { session_id: "s1", tool_name: "Edit", tool_input: { file_path: "/a/b.ts" } });
    hub.onHook("Stop", { session_id: "s1", last_assistant_message: "**Added the toggle.** Tests pass.\n\n## Details\nlots" });
    await Bun.sleep(20);
    await flush(hub);
    expect(sent.length).toBe(1);
    expect(sent[0].body).toMatch(/^webapp: DONE\. Added the toggle\. Tests pass\. Reply to continue\.$/);
  });

  test("home: no DONE unless the session is watched", async () => {
    const { hub, sent } = makeHub();
    bridge(hub, "s1");
    hub.onHook("Stop", { session_id: "s1", last_assistant_message: "Done." });
    await Bun.sleep(20); await flush(hub);
    expect(sent).toEqual([]);
    hub.store.updateSession("s1", { watch: "watched" });
    hub.onHook("Stop", { session_id: "s1", last_assistant_message: "Done again." });
    await Bun.sleep(20); await flush(hub);
    expect(sent.length).toBe(1);
  });

  test("no DONE while background tasks are running", async () => {
    const { hub, sent } = makeHub();
    bridge(hub, "s1");
    hub.setMode("away");
    hub.onHook("Stop", { session_id: "s1", last_assistant_message: "Waiting on agent.", background_tasks: [{ id: "a" }] });
    await Bun.sleep(20); await flush(hub);
    expect(sent).toEqual([]);
  });

  test("long final messages go through the summarizer", async () => {
    const { hub, sent } = makeHub({ summary: "Short summary." });
    bridge(hub, "s1");
    hub.setMode("away");
    hub.onHook("Stop", { session_id: "s1", last_assistant_message: "word ".repeat(120) });
    await Bun.sleep(30); await flush(hub);
    expect(sent[0].body).toContain("Short summary.");
  });

  test("sms_reply after the last edit suppresses the DONE duplicate", async () => {
    const { hub, sent } = makeHub();
    const b = bridge(hub, "s1");
    hub.setMode("away");
    hub.onHook("UserPromptSubmit", { session_id: "s1" });
    hub.onHook("PostToolUse", { session_id: "s1", tool_name: "Edit", tool_input: {} });
    await Bun.sleep(2);
    const r = await hub.onBridgeRequest(b.conn as any, { t: "req", id: 1, op: "reply", args: { text: "Fixed it." } });
    expect(r).toBe("sent");
    hub.onHook("Stop", { session_id: "s1", last_assistant_message: "Fixed it." });
    await Bun.sleep(20); await flush(hub);
    expect(sent.length).toBe(1);
    expect(sent[0].body).toBe("s1: Fixed it.".replace("s1", hub.store.session("s1")!.name));
  });

  test("capture mode: verbatim parts, send, confirm", async () => {
    const { hub, sent, routerCalls } = makeHub();
    const b = bridge(hub, "s1");
    await text(hub, "prompt");
    await text(hub, "Refactor auth.");
    await text(hub, "stop using redux");
    await text(hub, "Keep tests green.");
    await text(hub, "send");
    await flush(hub);
    expect(sent.at(-1)!.body).toContain("3 parts");
    await text(hub, "y");
    expect(b.got.find((m) => m.t === "deliver")?.content).toBe("Refactor auth.\n\nstop using redux\n\nKeep tests green.");
    expect(routerCalls).toEqual([]);
  });

  test("rapid texts right after 'prompt' are captured, not merged into the command", async () => {
    const { hub, sent, routerCalls } = makeHub();
    hub.debounceMs = 50;
    const b = bridge(hub, "s1");
    const t = (x: string) => hub.onInbound({ kind: "message", id: x, from: OWNER, to: "", text: x, mediaCount: 0 });
    t("prompt"); t("Create d.txt."); t("Content: captured"); t("send");
    await Bun.sleep(200); await flush(hub);
    expect(sent.at(-1)!.body).toContain("Send to");
    t("y");
    await Bun.sleep(100);
    expect(b.got.find((m) => m.t === "deliver")?.content).toContain("Create d.txt.");
    expect(b.got.find((m) => m.t === "deliver")?.content).toContain("Content: captured");
    expect(routerCalls).toEqual([]);
  });

  test("sms_ask with options: replying 1 delivers the answer", async () => {
    const { hub } = makeHub();
    const b = bridge(hub, "s1");
    hub.setMode("away");
    const r = await hub.onBridgeRequest(b.conn as any, { t: "req", id: 1, op: "ask", args: { question: "Which DB?", options: ["Redis", "SQLite"] } });
    expect(r).toContain("sent");
    await text(hub, "1");
    expect(b.got.find((m) => m.t === "deliver")).toMatchObject({ content: "1 (Redis)", meta: { kind: "answer" } });
  });

  test("paused holds outcomes and resume sends one digest", async () => {
    const { hub, sent } = makeHub();
    bridge(hub, "s1");
    hub.setMode("away");
    hub.setMode("paused");
    hub.onHook("Stop", { session_id: "s1", last_assistant_message: "All done." });
    await Bun.sleep(20); await flush(hub);
    expect(sent).toEqual([]);
    hub.setMode("resume");
    await flush(hub);
    expect(sent.length).toBe(1);
    expect(sent[0].body).toStartWith("While paused:");
    expect(hub.mode).toBe("away");
  });

  test("budget: outcomes are dropped once the daily budget is used", async () => {
    const { hub, sent } = makeHub({ cfg: (c) => { c.budget.dailySegments = 2; } });
    bridge(hub, "s1");
    hub.setMode("away");
    await text(hub, "status");
    await text(hub, "status");
    await flush(hub);
    const before = sent.length;
    hub.onHook("Stop", { session_id: "s1", last_assistant_message: "Done." });
    await Bun.sleep(20); await flush(hub);
    expect(sent.slice(before).some((s) => s.body.includes("DONE"))).toBe(false);
  });

  test("mode change is injected once via hook additionalContext", () => {
    const { hub } = makeHub();
    bridge(hub, "s1");
    expect(hub.onHook("PostToolUse", { session_id: "s1", tool_name: "Read", tool_input: {} })).toEqual({});
    hub.setMode("away");
    const r = hub.onHook("PostToolUse", { session_id: "s1", tool_name: "Read", tool_input: {} }) as any;
    expect(r.hookSpecificOutput.additionalContext).toContain("left the computer");
    expect(hub.onHook("PostToolUse", { session_id: "s1", tool_name: "Read", tool_input: {} })).toEqual({});
  });

  test("carrier opt-out keywords are never processed", async () => {
    const { hub, sent, routerCalls } = makeHub();
    hub.onInbound({ kind: "message", id: "1", from: OWNER, to: "", text: "STOP", mediaCount: 0 });
    await flush(hub);
    expect(sent).toEqual([]);
    expect(routerCalls).toEqual([]);
    expect(hub.store.get("optOutWarning", null)).not.toBeNull();
  });

  test("PIN locks prompts until unlocked", async () => {
    const { hub, sent } = makeHub({ cfg: (c) => { c.security.unlockPin = "4821"; } });
    const b = bridge(hub, "s1");
    await text(hub, "@s1 do it".replace("s1", hub.store.session("s1")!.name));
    await flush(hub);
    expect(sent.at(-1)!.body).toContain("Locked");
    expect(b.got.some((m) => m.t === "deliver")).toBe(false);
    await text(hub, "unlock 4821");
    await text(hub, `@${hub.store.session("s1")!.name} do it`);
    expect(b.got.some((m) => m.t === "deliver")).toBe(true);
  });

  test("sessions without the channel can't receive texts and say so", async () => {
    const { hub, sent } = makeHub();
    hub.onHook("SessionStart", { session_id: "plain", cwd: "/code/plain", source: "startup" });
    await text(hub, "@plain hi");
    await flush(hub);
    expect(sent.at(-1)!.body).toContain("can't receive texts");
  });

  test("milestone updates only for watched sessions and are superseded by DONE", async () => {
    const { hub, sent } = makeHub();
    const b = bridge(hub, "s1");
    hub.setMode("away");
    const r1 = await hub.onBridgeRequest(b.conn as any, { t: "req", id: 1, op: "update", args: { text: "Phase 1 done" } });
    expect(r1).toContain("not sent");
    hub.store.updateSession("s1", { watch: "watched" });
    hub.outbox.batchMs = 500;
    const r2 = await hub.onBridgeRequest(b.conn as any, { t: "req", id: 2, op: "update", args: { text: "Phase 1 done" } });
    expect(r2).toContain("queued");
    hub.onHook("Stop", { session_id: "s1", last_assistant_message: "All phases done." });
    await Bun.sleep(30);
    await hub.outbox.drain();
    expect(sent.length).toBe(1);
    expect(sent[0].body).toContain("DONE");
    expect(sent[0].body).not.toContain("Phase 1");
  });

  test("/clear re-keys the session and keeps its number", () => {
    const { hub } = makeHub();
    const b = bridge(hub, "old");
    const num = hub.store.session("old")!.num;
    hub.onBridgeHello(b.conn as any, { t: "hello", pid: 1, claudePid: process.pid, sessionId: "new", cwd: "/tmp/webapp", name: null, inbound: true, tmuxPane: null, version: "t", prevSessionId: "old" } as any);
    expect(hub.store.session("old")).toBeNull();
    expect(hub.store.session("new")!.num).toBe(num);
  });

  test("work started by text reports back even in home mode", async () => {
    const { hub, sent } = makeHub();
    const b = bridge(hub, "s1", { cwd: "/code/webapp" });
    await text(hub, "@webapp fix the tests");
    hub.onHook("UserPromptSubmit", { session_id: "s1" });
    hub.onHook("Stop", { session_id: "s1", last_assistant_message: "Fixed 2 tests." });
    await Bun.sleep(30); await flush(hub);
    expect(sent.some((x) => x.body.includes("DONE") && x.body.includes("Fixed 2 tests"))).toBe(true);
    // A later turn the user didn't start by text stays quiet at home.
    const n = sent.length;
    hub.onHook("UserPromptSubmit", { session_id: "s1" });
    hub.onHook("Stop", { session_id: "s1", last_assistant_message: "Other work." });
    await Bun.sleep(30); await flush(hub);
    expect(sent.length).toBe(n);
  });

  test("5 wrong PINs trigger lockdown; unlock texts are masked in the log", async () => {
    const { hub } = makeHub({ cfg: (c) => { c.security.unlockPin = "4821"; } });
    for (let i = 0; i < 5; i++) hub.onInbound({ kind: "message", id: `p${i}`, from: OWNER, to: "", text: `unlock 000${i}`, mediaCount: 0 });
    await Bun.sleep(50);
    expect(hub.store.get("lockdown", false)).toBe(true);
    expect(hub.store.lastMessages(50).filter((m) => m.direction === "in").every((m) => m.body === "unlock ****")).toBe(true);
  });

  test("ambiguous @prefix never guesses", async () => {
    const { hub, sent } = makeHub();
    const a = bridge(hub, "a", { cwd: "/code/webapp" });
    const w = bridge(hub, "w", { cwd: "/code/worker" });
    await text(hub, "@w deploy");
    await flush(hub);
    expect([...a.got, ...w.got].some((m) => m.t === "deliver")).toBe(false);
    expect(sent.at(-1)!.body).toContain('No session "w"');
  });

  test("an sms_ask answered in words clears the numbered choice", async () => {
    const { hub, sent } = makeHub();
    const b = bridge(hub, "s1");
    hub.setMode("away");
    await hub.onBridgeRequest(b.conn as any, { t: "req", id: 1, op: "ask", args: { question: "DB?", options: ["Redis", "SQLite"] } });
    await text(hub, `@${hub.store.session("s1")!.name} use sqlite`);
    expect(hub.sender(OWNER).choice).toBeUndefined();
  });

  test("a captured prompt is kept if delivery fails", async () => {
    const { hub } = makeHub();
    await text(hub, "prompt");
    await text(hub, "part one");
    await text(hub, "send");
    expect(hub.sender(OWNER).capture?.parts).toEqual(["part one"]);
  });

  test("long replies are paged with MORE", async () => {
    const { hub, sent } = makeHub();
    for (let i = 0; i < 9; i++) bridge(hub, `s${i}`, { cwd: `/code/project-number-${i}` });
    hub.store.db.query("UPDATE sessions SET last_summary = ?").run("x".repeat(70));
    await text(hub, "status");
    await flush(hub);
    expect(sent.at(-1)!.body).toContain("(MORE 1/");
    await text(hub, "more");
    await flush(hub);
    expect(sent.at(-1)!.body).toMatch(/\(\d\/\d\)|\(MORE \d\/\d\)/);
  });
});

afterEach(() => {});
process.on("exit", () => { try { rmSync(home, { recursive: true, force: true }); } catch {} });

describe("servers", () => {
  test("internal API rejects browsers, wrong hosts and missing tokens; hooks still work", async () => {
    const { startInternalServer } = await import("../src/hub/server.ts");
    const { hub } = makeHub();
    const port = 47000 + Math.floor(Math.random() * 900);
    const srv = startInternalServer(hub, port, "t".repeat(40));
    const base = `http://127.0.0.1:${port}`;
    const post = (path: string, headers: Record<string, string>, body = "{}") => fetch(base + path, { method: "POST", headers, body });
    expect((await post("/api/fake/inbound", { "content-type": "application/json" }, '{"text":"status"}')).status).toBe(401);
    expect((await post("/api/fake/inbound", { "content-type": "text/plain", "x-ccsms-token": "t".repeat(40) }, '{"text":"status"}')).status).toBe(415);
    expect((await post("/api/fake/inbound", { "content-type": "application/json", origin: "https://evil.example", "x-ccsms-token": "t".repeat(40) }, '{"text":"status"}')).status).toBe(403);
    expect((await fetch(base + "/api/status", { headers: { host: "evil.example:" + port, "x-ccsms-token": "t".repeat(40) } })).status).toBe(403);
    expect((await fetch(base + "/api/status", { headers: { "x-ccsms-token": "t".repeat(40) } })).status).toBe(200);
    const hook = await post("/hooks/SessionStart", { "content-type": "application/json" }, JSON.stringify({ session_id: "h1", cwd: "/x/proj", source: "startup" }));
    expect(hook.status).toBe(200);
    expect(hub.store.session("h1")).not.toBeNull();
    srv.stop(true);
  });

  test("bridge socket delivers large messages intact", async () => {
    const { startBridgeSocket } = await import("../src/hub/server.ts");
    const { LineDecoder, encode } = await import("../src/shared/protocol.ts");
    const { hub } = makeHub();
    const sockPath = join(home, `t${Math.random().toString(36).slice(2, 8)}.sock`);
    const srv = startBridgeSocket(hub, sockPath);
    const got: any[] = [];
    const dec = new LineDecoder();
    const client = await Bun.connect({ unix: sockPath, socket: { data(_s, b) { dec.push(b.toString(), (m) => got.push(m)); } } });
    client.write(encode({ t: "hello", pid: 1, claudePid: process.pid, sessionId: "big", cwd: "/x/big", name: null, inbound: true, tmuxPane: null, version: "t" }));
    for (let i = 0; i < 50 && !got.some((m) => m.t === "welcome"); i++) await Bun.sleep(10);
    const big = "x".repeat(200_000);
    hub.bridges.get("big")!.send({ t: "deliver", content: big, meta: { kind: "prompt" } });
    hub.bridges.get("big")!.send({ t: "deliver", content: "after", meta: { kind: "prompt" } });
    for (let i = 0; i < 200 && got.filter((m) => m.t === "deliver").length < 2; i++) await Bun.sleep(10);
    const delivered = got.filter((m) => m.t === "deliver");
    expect(delivered[0].content.length).toBe(200_000);
    expect(delivered[1].content).toBe("after");
    client.end();
    srv.stop(true);
  });
});
