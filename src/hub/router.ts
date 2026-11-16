import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { paths, ensureStateDir } from "../shared/paths.ts";
import { logger } from "../shared/log.ts";
import type { Action } from "./commands.ts";

const log = logger("router");

export const ROUTER_PROMPT = `You are the dispatcher for claude-code-sms. A user texts from their phone to control the Claude Code sessions running on their computer. For each text you decide what it means and return exactly one JSON action. You never do tasks yourself and never rewrite the user's words: when you deliver a text to a session, the hub forwards the user's original text verbatim.

You get the current state: the time, the texting mode, the numbered sessions (name, folder, busy or idle, whether it can receive texts, recent activity, last summary, any question it is waiting on), the sticky target (the session the user was last talking to), anything the hub is waiting for from the user, recent messages (oldest first), and the new text.

Decide in this order:
1. The hub is waiting for a yes/no confirmation: if the text answers it ("yeah", "sure, go", "do it", "nope", "never mind"), return "confirm" with yes true or false. If the text instead changes the request, handle the new request.
2. The hub is waiting for a numbered choice: if the text picks an option ("2", "the second one", "the ml one"), return "choose" with that option's number (the number shown in the options).
3. A captured multi-text prompt is waiting: "send it to webapp" or "to 1" -> "capture_send" with target; "scrap it" -> "capture_discard".
4. A session is waiting on a question and the text reads like the answer -> "deliver" to it with kind "answer".
5. Work for a session (an instruction, follow-up or question for it):
   - A session named or numbered in the text wins.
   - Otherwise the sticky target if it was set in the last 30 minutes and the text plausibly continues that thread.
   - Otherwise, if exactly one session can receive texts, that one.
   - If more than one session plausibly fits, return "clarify" with a reply listing numbered options (use the session numbers). Never guess between sessions: a misrouted prompt does real work in the wrong project.
   - kind is "question" when the user wants information from the session ("ask webapp why it picked Prisma"), otherwise "prompt".
   - If the target session cannot receive texts, still deliver (the hub explains).
6. Questions about the system itself ("what's running?", "is webapp done?", "how many texts today?") -> "answer" with a short reply built only from the state you were given, or "status" for a full list. Never invent facts.
7. Texting preferences: leaving, back, stop texting for now, quiet until a time -> "set_mode" (away, home, pause, resume, or quiet with until like "3pm"). Per-session: "text me about webapp" -> "watch" with level watched; "stop texting about webapp" -> "watch" with level muted.
8. Session control: start a new session -> "spawn" with dir (folder name as said) and prompt (the task, in the user's words); restart an ended one -> "resume" (ended sessions have no number: put its name in "name"); interrupt -> "interrupt"; see its screen -> "peek"; "continue after the limit" -> "retry"; rename -> "rename" with name; "the next texts are my prompt" -> "capture_start".
9. Changing the dispatcher model -> "model" with model (an alias like haiku, sonnet, opus). Rest of a long message -> "more". Help -> "help".
10. Chit-chat or anything unclear -> "answer" with a short helpful reply (mention "?" for commands if useful).

Replies are for a phone: at most 160 characters, plain characters only, no markdown or emoji. Omit reply when the action speaks for itself.`;

export const ROUTER_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["deliver", "clarify", "answer", "status", "set_mode", "watch", "confirm", "choose", "capture_start", "capture_send", "capture_discard",
        "spawn", "resume", "interrupt", "peek", "retry", "rename", "model", "more", "help"],
    },
    target: { type: "integer", description: "session number" },
    kind: { type: "string", enum: ["prompt", "question", "answer"] },
    mode: { type: "string", enum: ["away", "home", "pause", "resume", "quiet"] },
    until: { type: "string" },
    level: { type: "string", enum: ["watched", "muted", "default"] },
    yes: { type: "boolean" },
    option: { type: "integer" },
    dir: { type: "string" },
    prompt: { type: "string" },
    name: { type: "string" },
    model: { type: "string" },
    reply: { type: "string" },
    confident: { type: "boolean", description: "false if the target was a guess among several plausible sessions" },
  },
  required: ["action"],
  additionalProperties: false,
};

export const SUMMARIZER_PROMPT = `Rewrite a coding session's final report as one SMS of at most 250 characters, plain characters only, no markdown, emoji, curly quotes or dashes other than '-'. Order: the outcome; anything the user must do or decide; one key number if useful. Keep any question the report asks the user. Omit file paths, code and process details. Output only the SMS.`;

/** Locate the claude executable. The hub runs under launchd with a minimal PATH. */
export function findClaude(configured?: string): string {
  if (configured && existsSync(configured)) return configured;
  const candidates = [
    Bun.which("claude"),
    join(homedir(), ".local/bin/claude"),
    join(homedir(), ".claude/local/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ].filter(Boolean) as string[];
  return candidates.find((c) => existsSync(c)) ?? "claude";
}

export interface ClaudeRunner {
  (args: string[], input: string, timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string }>;
}

export const defaultRunner = (claudePath: string): ClaudeRunner => async (args, input, timeoutMs) => {
  ensureStateDir();
  const env = { ...process.env, CCSMS_INTERNAL: "1" } as Record<string, string>;
  // Never let a nested-session marker leak into the dispatcher run.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  const proc = Bun.spawn([claudePath, ...args], {
    cwd: paths.routerCwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: new Blob([input]),
  });
  const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { ok: code === 0, stdout, stderr };
};

function baseArgs(model: string, systemPrompt: string): string[] {
  return [
    "-p",
    "--restricted",
    "--strict-mcp-config",
    "--tools", "",
    "--no-session-persistence",
    "--model", model,
    "--system-prompt", systemPrompt,
    "--output-format", "json",
  ];
}

export interface RouterDecision {
  action: string;
  target?: number;
  kind?: "prompt" | "question" | "answer";
  mode?: string;
  until?: string;
  level?: "watched" | "muted" | "default";
  yes?: boolean;
  option?: number;
  dir?: string;
  prompt?: string;
  name?: string;
  model?: string;
  reply?: string;
  confident?: boolean;
}

export class Dispatcher {
  constructor(private runner: ClaudeRunner, private getModels: () => { router: string; summarizer: string }) {}

  async route(context: string): Promise<RouterDecision | null> {
    const args = [...baseArgs(this.getModels().router, ROUTER_PROMPT), "--json-schema", JSON.stringify(ROUTER_SCHEMA)];
    const t0 = Date.now();
    const r = await this.runner(args, context, 90_000);
    if (!r.ok) {
      log.warn(`router call failed: ${r.stderr.slice(0, 300) || r.stdout.slice(0, 300)}`);
      return null;
    }
    try {
      const j = JSON.parse(r.stdout);
      if (j.is_error) { log.warn(`router error: ${String(j.result).slice(0, 200)}`); return null; }
      const d = j.structured_output ?? (typeof j.result === "string" ? JSON.parse(j.result) : null);
      log.info(`routed in ${Date.now() - t0}ms: ${JSON.stringify(d)}`);
      return d && typeof d.action === "string" ? d : null;
    } catch (e) {
      log.warn("router output unparseable", r.stdout.slice(0, 300));
      return null;
    }
  }

  async summarize(report: string): Promise<string | null> {
    const r = await this.runner(baseArgs(this.getModels().summarizer, SUMMARIZER_PROMPT), report.slice(0, 20_000), 90_000);
    if (!r.ok) { log.warn(`summarizer failed: ${r.stderr.slice(0, 200)}`); return null; }
    try {
      const j = JSON.parse(r.stdout);
      return j.is_error ? null : String(j.result ?? "").trim() || null;
    } catch { return null; }
  }
}

/** Map a router decision onto a hub action. */
export function decisionToAction(d: RouterDecision, originalText: string): Action {
  const target = typeof d.target === "number" ? { num: d.target } : null;
  const say = (fallback: string): Action => ({ type: "reply", text: d.reply || fallback });
  switch (d.action) {
    case "deliver":
      return { type: "deliver", target, text: originalText, kind: d.kind ?? "prompt", inferred: d.confident === false ? true : undefined };
    case "set_mode": {
      const mode = d.mode === "pause" || d.mode === "quiet" ? "paused" : d.mode === "resume" ? "resume" : d.mode === "away" ? "away" : "home";
      return { type: "mode", mode, until: d.mode === "quiet" ? d.until : undefined };
    }
    case "status": return { type: "status" };
    case "help": return { type: "help" };
    case "more": return { type: "more" };
    case "watch": return target ? { type: "watch", target, level: d.level ?? "watched" } : say("Which session? Text status to see them.");
    case "confirm": return typeof d.yes === "boolean" ? { type: "confirm", yes: d.yes } : say("Yes or no?");
    case "choose": return typeof d.option === "number" ? { type: "choice", n: d.option } : say("Which number?");
    case "capture_start": return { type: "capture_start", target };
    case "capture_send": return { type: "capture_send", target };
    case "capture_discard": return { type: "capture_discard" };
    case "spawn": return { type: "spawn", dir: d.dir ?? "", prompt: d.prompt || originalText, worktree: false };
    case "resume": return { type: "resume_session", target: target ?? (d.name ? { name: d.name.toLowerCase() } : null) };
    case "interrupt": return { type: "halt", target };
    case "peek": return { type: "peek", target };
    case "retry": return { type: "retry", target };
    case "rename": return target && d.name ? { type: "rename", target, name: d.name } : say("Rename which session to what?");
    case "model": return { type: "model", which: "both", model: d.model };
    case "clarify":
      return { type: "reply", text: d.reply || "Which session? Text status to see them.", clarifyText: originalText, clarifyKind: d.kind ?? "prompt" };
    case "answer":
    default:
      return say("Not sure what you mean. Text ? for commands.");
  }
}
