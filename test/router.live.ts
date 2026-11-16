#!/usr/bin/env bun
/**
 * Live dispatcher evaluation: runs real `claude -p` calls (uses your Claude login) against
 * realistic scenarios and checks each decision. Not part of `bun test` (it costs usage).
 *
 *   bun test/router.live.ts [model]
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CCSMS_HOME = mkdtempSync(join(tmpdir(), "ccsms-live-"));
const { Store } = await import("../src/shared/db.ts");
const { saveConfig, DEFAULT_CONFIG } = await import("../src/shared/config.ts");
const { Hub } = await import("../src/hub/hub.ts");
const { FakeProvider } = await import("../src/providers/fake.ts");
const { decisionToAction } = await import("../src/hub/router.ts");

const OWNER = "+15550001234";
const model = process.argv[2] ?? "sonnet";

function world(setup?: (hub: InstanceType<typeof Hub>) => void) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.owners.numbers = [OWNER];
  cfg.router.model = model;
  cfg.tunnel.kind = "none";
  const file = join(process.env.CCSMS_HOME!, `c${Math.random()}.toml`);
  saveConfig(cfg, file);
  const hub = new Hub(new Store(":memory:"), { provider: new FakeProvider(), configFile: file, noTimers: true });
  const conn = () => ({ sessionId: null, claudePid: null, version: "", send() {} });
  hub.onBridgeHello(conn() as any, { t: "hello", pid: 1, claudePid: process.pid, sessionId: "w", cwd: "/Users/me/code/webapp", name: null, inbound: true, tmuxPane: "%1", version: "x" });
  hub.onBridgeHello(conn() as any, { t: "hello", pid: 1, claudePid: process.pid, sessionId: "m", cwd: "/Users/me/school/ml-hw", name: null, inbound: true, tmuxPane: "%2", version: "x" });
  hub.store.updateSession("w", { status: "busy", busy_since: Date.now() - 12 * 60_000, last_activity: "editing login.tsx", last_summary: "Migrated auth to Prisma." });
  hub.store.updateSession("m", { status: "idle", last_summary: "Trained the model; figure 2 next." });
  setup?.(hub);
  return hub;
}

type Check = (a: any) => boolean;
const cases: { name: string; text: string; setup?: (hub: any) => void; expect: Check; want: string }[] = [
  {
    name: "answer to a waiting question", text: "cleaned",
    setup: (h) => h.store.updateSession("m", { pending_question: JSON.stringify({ question: "Fig 2 from cleaned or raw data?", via: "sms", at: Date.now() }) }),
    expect: (a) => a.type === "deliver" && a.target?.num === 2 && a.kind === "answer", want: "deliver to 2 as answer",
  },
  { name: "ambiguous instruction", text: "run the tests again", expect: (a) => a.type === "reply" && Boolean(a.clarifyText), want: "clarify" },
  {
    name: "sticky follow-up", text: "also add a dark mode toggle",
    setup: (h) => h.setSender(OWNER, { sticky: { sessionId: "w", at: Date.now() - 5 * 60_000 } }),
    expect: (a) => a.type === "deliver" && a.target?.num === 1, want: "deliver to 1",
  },
  {
    name: "natural yes to a confirmation", text: "yeah go for it",
    setup: (h) => {
      h.store.addMessage({ direction: "out", peer: OWNER, body: 'Start a session in ~/code/homework with "outline my essay"? y/n', segments: 1, cost: null, currency: null, provider_id: null, status: null, tier: "T1", session_id: null });
      h.setSender(OWNER, { confirm: { kind: "spawn", data: {}, prompt: "", expires: Date.now() + 600_000 } });
    },
    expect: (a) => a.type === "confirm" && a.yes === true, want: "confirm yes",
  },
  {
    name: "natural pick from a choice", text: "the ml one",
    setup: (h) => h.setSender(OWNER, { choice: { kind: "route", options: [1, 2], data: { text: "run it", kind: "prompt" }, expires: Date.now() + 600_000 } }),
    expect: (a) => a.type === "choice" && a.n === 2, want: "choose 2",
  },
  {
    name: "redirect a captured prompt", text: "send it to webapp instead",
    setup: (h) => h.setSender(OWNER, { capture: { active: false, parts: ["Refactor auth", "keep tests green"], target: "m", lastAt: Date.now() }, confirm: { kind: "capture_send", data: { sessionId: "m" }, prompt: "x", expires: Date.now() + 600_000 } }),
    expect: (a) => a.type === "capture_send" && a.target?.num === 1, want: "capture_send to 1",
  },
  { name: "leaving", text: "heading to class, text me if anything happens", expect: (a) => a.type === "mode" && a.mode === "away", want: "away" },
  { name: "quiet until", text: "don't text me until 3pm", expect: (a) => a.type === "mode" && a.mode === "paused" && /3/.test(a.until ?? ""), want: "paused until 3pm" },
  { name: "system question", text: "what's webapp doing?", expect: (a) => (a.type === "reply" && !a.clarifyText && /login|edit|busy|auth/i.test(a.text)) || a.type === "status", want: "answer from state" },
  { name: "spawn", text: "start a new session in homework and outline my essay", expect: (a) => a.type === "spawn" && /homework/.test(a.dir) && /essay/.test(a.prompt), want: "spawn homework" },
  { name: "question for a session", text: "ask webapp why it chose prisma", expect: (a) => a.type === "deliver" && a.target?.num === 1 && a.kind === "question", want: "deliver question to 1" },
  { name: "chit-chat", text: "lol thanks", expect: (a) => a.type === "reply" && !a.clarifyText, want: "short reply" },
  { name: "watch a session", text: "keep me posted on the ml session", expect: (a) => a.type === "watch" && a.target?.num === 2 && a.level === "watched", want: "watch 2" },
  { name: "change model", text: "use haiku for the dispatcher", expect: (a) => a.type === "model" && a.model === "haiku", want: "model haiku" },
];

let pass = 0;
for (const c of cases) {
  const hub = world(c.setup);
  const ctx = hub.routerContext(OWNER, c.text);
  const t0 = Date.now();
  const d = await hub.dispatcher.route(ctx);
  const a = d ? decisionToAction(d, c.text) : null;
  const ok = Boolean(a && c.expect(a));
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name.padEnd(32)} ${String(Date.now() - t0).padStart(5)}ms  ${ok ? "" : `want ${c.want}, got ${JSON.stringify(d)}`}`);
}
console.log(`\n${pass}/${cases.length} passed with model ${model}`);
process.exit(pass === cases.length ? 0 : 1);
