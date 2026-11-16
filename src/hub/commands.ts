/**
 * Fast-path command parser. Matches the whole text (case-insensitive). Anything that isn't a
 * command returns null and goes to the router. Reserved carrier keywords (STOP, CANCEL, END,
 * QUIT, HELP, START, ...) are deliberately never used as commands.
 */

export type SessionRef = { num?: number; name?: string };

export type Action =
  | { type: "status"; cost?: boolean }
  | { type: "deliver"; target: SessionRef | null; text: string; kind: "prompt" | "question" | "answer"; inferred?: boolean }
  | { type: "mode"; mode: "home" | "away" | "paused" | "resume"; until?: string }
  | { type: "watch"; target: SessionRef; level: "watched" | "muted" | "default" }
  | { type: "capture_start"; target: SessionRef | null }
  | { type: "more" }
  | { type: "model"; which: "both" | "router" | "summarizer"; model?: string }
  | { type: "confirm"; yes: boolean }
  | { type: "choice"; n: number }
  | { type: "peek"; target: SessionRef | null }
  | { type: "halt"; target: SessionRef | null }
  | { type: "resume_session"; target: SessionRef | null }
  | { type: "spawn"; dir: string; prompt: string; worktree: boolean }
  | { type: "rename"; target: SessionRef; name: string }
  | { type: "retry"; target: SessionRef | null }
  | { type: "unlock"; pin: string }
  | { type: "lockdown" }
  | { type: "help" }
  | { type: "reply"; text: string; clarifyText?: string; clarifyKind?: "prompt" | "question" | "answer" };

function ref(s: string | undefined): SessionRef | null {
  if (!s) return null;
  const t = s.trim().replace(/^@/, "").replace(/:$/, "");
  if (!t) return null;
  if (/^\d+$/.test(t)) return { num: Number(t) };
  return { name: t.toLowerCase() };
}

export function parseCommand(input: string, ctx: { pendingChoice: boolean; pendingConfirm: boolean }): Action | null {
  const raw = input.trim();
  const t = raw.toLowerCase().replace(/\s+/g, " ");

  if (ctx.pendingConfirm && /^(y|n|ok|no)$/.test(t)) return { type: "confirm", yes: t === "y" || t === "ok" };
  if (ctx.pendingChoice && /^\d{1,2}$/.test(t)) return { type: "choice", n: Number(t) };

  if (t === "s" || t === "status") return { type: "status" };
  if (t === "status cost" || t === "cost") return { type: "status", cost: true };
  if (t === "?" || t === "cmds" || t === "commands") return { type: "help" };
  if (t === "more" || t === "m") return { type: "more" };
  if (t === "away") return { type: "mode", mode: "away" };
  if (t === "home" || t === "back" || t === "i'm back" || t === "im back") return { type: "mode", mode: "home" };
  if (t === "pause") return { type: "mode", mode: "paused" };
  if (t === "resume") return { type: "mode", mode: "resume" };
  let m = t.match(/^(?:quiet|pause) until (.+)$/);
  if (m) return { type: "mode", mode: "paused", until: m[1] };
  if (t === "lockdown") return { type: "lockdown" };
  m = raw.match(/^unlock\s+(\d{4,12})$/i);
  if (m) return { type: "unlock", pin: m[1] };

  m = t.match(/^model(?:\s+(router|summarizer|dispatcher))?(?:\s+([a-z0-9.\-\[\]_]+))?$/);
  if (m) {
    const which = m[1] === "router" || m[1] === "dispatcher" ? "router" : m[1] === "summarizer" ? "summarizer" : "both";
    return { type: "model", which, model: m[2] };
  }

  if (t === "prompt") return { type: "capture_start", target: null };
  m = t.match(/^prompt (?:for|to) (@?[a-z0-9_\-]+)$/);
  if (m) return { type: "capture_start", target: ref(m[1]) };

  m = t.match(/^(watch|mute|unmute)\s+(@?[a-z0-9_\-]+)$/);
  if (m) return { type: "watch", target: ref(m[2])!, level: m[1] === "watch" ? "watched" : m[1] === "mute" ? "muted" : "default" };

  m = t.match(/^(peek|halt|interrupt)(?:\s+(@?[a-z0-9_\-]+))?$/);
  if (m) return { type: m[1] === "peek" ? "peek" : "halt", target: ref(m[2]) };
  m = t.match(/^resume\s+(@?[a-z0-9_\-]+)$/);
  if (m) return { type: "resume_session", target: ref(m[1]) };
  m = t.match(/^retry(?:\s+(@?[a-z0-9_\-]+))?$/);
  if (m) return { type: "retry", target: ref(m[1]) };

  m = raw.match(/^call\s+(@?\S+)\s+(?:as\s+)?([A-Za-z0-9_\-]{1,10})$/i);
  if (m) return { type: "rename", target: ref(m[1])!, name: m[2] };

  m = raw.match(/^new\s+([^:]+?)(\s+wt)?\s*:\s*([\s\S]+)$/i);
  if (m) return { type: "spawn", dir: m[1].trim(), worktree: Boolean(m[2]), prompt: m[3].trim() };

  // Explicit addressing: "@name text" or "2: text"
  m = raw.match(/^@([A-Za-z0-9_\-]+)[:,]?\s+([\s\S]+)$/);
  if (m) return { type: "deliver", target: ref(m[1]), text: m[2].trim(), kind: "prompt" };
  m = raw.match(/^(\d{1,2})\s*:\s*([\s\S]+)$/);
  if (m) return { type: "deliver", target: { num: Number(m[1]) }, text: m[2].trim(), kind: "prompt" };

  return null;
}

export const HELP_TEXT =
  "Commands: status | @name msg or 2: msg | away/home/pause/resume | prompt (multi-text, then send/discard) " +
  "| watch/mute name | peek/halt name | new dir: prompt | model haiku | more | cost. Never text just STOP (it blocks this number; START undoes it).";
