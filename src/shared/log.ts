import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let logFile: string | null = null;
let minLevel: Level = (process.env.CCSMS_LOG_LEVEL as Level) || "info";
let toStderr = true;

export function configureLog(opts: { file?: string | null; level?: Level; stderr?: boolean }) {
  if (opts.file !== undefined) {
    logFile = opts.file;
    if (logFile && !existsSync(dirname(logFile))) mkdirSync(dirname(logFile), { recursive: true });
  }
  if (opts.level) minLevel = opts.level;
  if (opts.stderr !== undefined) toStderr = opts.stderr;
}

function write(level: Level, scope: string, msg: string, extra?: unknown) {
  if (order[level] < order[minLevel]) return;
  let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (extra !== undefined) {
    try {
      line += " " + (extra instanceof Error ? (extra.stack || extra.message) : JSON.stringify(extra));
    } catch { line += " [unserializable]"; }
  }
  if (toStderr) process.stderr.write(line + "\n");
  if (logFile) {
    try { appendFileSync(logFile, line + "\n"); } catch {}
  }
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => write("debug", scope, m, e),
    info: (m: string, e?: unknown) => write("info", scope, m, e),
    warn: (m: string, e?: unknown) => write("warn", scope, m, e),
    error: (m: string, e?: unknown) => write("error", scope, m, e),
  };
}
export type Logger = ReturnType<typeof logger>;
