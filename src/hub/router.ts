import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { paths, ensureStateDir } from "../shared/paths.ts";
import { logger } from "../shared/log.ts";
import type { Action } from "./commands.ts";

const log = logger("router");

export const ROUTER_PROMPT = `You route text messages from a user to the Claude Code sessions running on their computer.
You never perform tasks yourself and never rewrite the user's words; you only decide where a message goes and what kind it is, and return one JSON action.

You get: the time, the mode, a numbered table of sessions (name, folder, status, recent activity, any question a session is waiting on), the current sticky target, recent messages, and the new message.

Routing:
- A session named or numbered in the message wins.
- If a session is waiting on a question and the message reads like an answer, deliver it there with kind "answer".
- Otherwise use the sticky target if it was set in the last 30 minutes and the message plausibly continues that thread.
- If only one session can receive texts and the message is an instruction or question for it, deliver it there.
- If more than one session fits, choose "clarify" with a reply listing numbered options. Never guess between sessions; a misrouted prompt does real work in the wrong repo.
- Questions about what is running or what a session is doing: "answer" with a reply built only from the table.
- Questions meant for the session itself ("ask webapp why..."): "deliver" with kind "question".
- Starting a new session: "spawn" with dir (a folder name) and prompt. Resuming an ended session: "resume". Interrupting: "interrupt". Viewing a screen: "peek".
- "The next few texts are my prompt" or similar: "capture_start" (with target if named).
- Messages about texting itself (stop texting me, pause, I'm back, I'm leaving, quiet until 3pm) map to "set_mode" with mode away, home, pause, resume or quiet (quiet needs until, like "3pm").
- If the message is chit-chat or unclear, use "answer" with a short helpful reply.

Replies are for a phone: at most 160 characters, plain characters, no markdown. Omit reply when the action speaks for itself.`;

export const ROUTER_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["deliver", "clarify", "answer", "set_mode", "capture_start", "spawn", "resume", "interrupt", "peek", "none"] },
    target: { type: "integer", description: "session number" },
    kind: { type: "string", enum: ["prompt", "question", "answer"] },
    mode: { type: "string", enum: ["away", "home", "pause", "resume", "quiet"] },
    until: { type: "string" },
    dir: { type: "string" },
    prompt: { type: "string" },
    reply: { type: "string" },
    confident: { type: "boolean", description: "false if the target was a guess among several plausible sessions" },
  },
  required: ["action"],
  additionalProperties: false,
};

export const SUMMARIZER_PROMPT = `Rewrite a coding session's final report as one SMS of at most 300 characters, plain characters only, no markdown, emoji, curly quotes or dashes other than '-'. Order: the outcome; anything the user must do or decide; one key number if useful. Keep any question the report asks the user. Omit file paths, code and process details. Output only the SMS.`;

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
  const proc = Bun.spawn([claudePath, ...args, input], {
    cwd: paths.routerCwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
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
  dir?: string;
  prompt?: string;
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
  switch (d.action) {
    case "deliver":
      return { type: "deliver", target, text: originalText, kind: d.kind ?? "prompt", inferred: d.confident === false ? true : undefined };
    case "set_mode": {
      const mode = d.mode === "pause" || d.mode === "quiet" ? "paused" : d.mode === "resume" ? "resume" : d.mode === "away" ? "away" : "home";
      return { type: "mode", mode, until: d.mode === "quiet" ? d.until : undefined };
    }
    case "capture_start": return { type: "capture_start", target };
    case "spawn": return { type: "spawn", dir: d.dir ?? "", prompt: d.prompt ?? originalText, worktree: false };
    case "resume": return { type: "resume_session", target };
    case "interrupt": return { type: "halt", target };
    case "peek": return { type: "peek", target };
    case "clarify":
      return { type: "reply", text: d.reply || "Which session? Text status to see them.", clarifyText: originalText, clarifyKind: d.kind ?? "prompt" };
    case "answer":
    case "none":
    default:
      return { type: "reply", text: d.reply || "Not sure what you mean. Text ? for commands." };
  }
}
