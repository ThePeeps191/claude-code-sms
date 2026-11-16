/** Text helpers for turning Claude's markdown into short SMS text. */

export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")            // code blocks
    .replace(/`([^`]+)`/g, "$1")                // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")       // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")    // links
    .replace(/^#{1,6}\s+/gm, "")                // headings
    .replace(/^\s*>\s?/gm, "")                  // quotes
    .replace(/^\s*[-*+]\s+/gm, "- ")            // bullets
    .replace(/^\s*\d+\.\s+/gm, (m) => m.trim() + " ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1$2")
    .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, "$1$2")
    .replace(/^\s*\|.*\|\s*$/gm, "")            // tables
    .replace(/^\s*[-=]{3,}\s*$/gm, "")          // rules
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** First paragraph of plain text (stops at a blank line). */
export function firstParagraph(text: string): string {
  const para = text.split(/\n\s*\n/)[0] ?? "";
  return para.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
}

export function minutesSince(ts: number | null | undefined): number {
  if (!ts) return 0;
  return Math.max(0, Math.round((Date.now() - ts) / 60000));
}

export function fmtDuration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `${m % 60}m` : ""}`;
}

/** Short one-line description of a tool call for the activity trail. */
export function describeTool(toolName: string, input: any): string {
  const s = (v: unknown, n = 50) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
  const file = (p: unknown) => String(p ?? "").split("/").pop() ?? "";
  switch (toolName) {
    case "Edit": case "MultiEdit": case "Write": case "NotebookEdit":
      return `editing ${file(input?.file_path ?? input?.notebook_path)}`;
    case "Read": return `reading ${file(input?.file_path)}`;
    case "Bash": return `ran ${s(input?.description || input?.command, 45)}`;
    case "Grep": case "Glob": return `searching ${s(input?.pattern, 30)}`;
    case "WebFetch": case "WebSearch": return `researching ${s(input?.query ?? input?.url, 40)}`;
    case "Task": case "Agent": return `delegating: ${s(input?.description, 40)}`;
    case "TodoWrite": {
      const todos = Array.isArray(input?.todos) ? input.todos : [];
      const done = todos.filter((t: any) => t?.status === "completed").length;
      return `todo ${done}/${todos.length}`;
    }
    default: return toolName.replace(/^mcp__/, "").slice(0, 40);
  }
}

/** Tools that change things (used to decide whether an earlier sms_reply already covered the result). */
export function isSubstantiveTool(toolName: string): boolean {
  return /^(Edit|MultiEdit|Write|NotebookEdit|Bash)$/.test(toolName);
}

export function parseClockTime(s: string, now = new Date()): Date | null {
  const m = s.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  const d = new Date(now);
  d.setHours(h, min, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

export function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s/g, "").toLowerCase();
}
