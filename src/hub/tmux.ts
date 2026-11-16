import { logger } from "../shared/log.ts";
const log = logger("tmux");

function run(args: string[], timeoutMs = 5000): { ok: boolean; out: string; err: string } {
  try {
    const p = Bun.spawnSync(["tmux", ...args], { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    return { ok: p.exitCode === 0, out: p.stdout.toString(), err: p.stderr.toString() };
  } catch (e: any) {
    return { ok: false, out: "", err: String(e?.message ?? e) };
  }
}

export function tmuxAvailable(): boolean {
  return run(["-V"]).ok;
}

export function paneAlive(pane: string): boolean {
  const r = run(["display-message", "-p", "-t", pane, "#{pane_id}"]);
  return r.ok && r.out.trim() === pane;
}

/** Visible pane text (plus some scrollback). */
export function capturePane(pane: string, scrollback = 60): string | null {
  const r = run(["capture-pane", "-p", "-J", "-t", pane, "-S", `-${scrollback}`]);
  return r.ok ? r.out : null;
}

/** Last N meaningful lines of a pane, with box-drawing and blank lines removed. */
export function peekPane(pane: string, lines = 8): string | null {
  const raw = capturePane(pane, 80);
  if (raw === null) return null;
  let all = raw.split("\n");
  // Claude Code's screen ends with: conversation, a rule, the input box, a rule, the status bar.
  // Keep only what's above the input box when we can find it.
  const promptIdx = findLastIndex(all, (l) => /^\s*[❯>]\s/.test(l) || /^\s*[❯>]\s*$/.test(l));
  if (promptIdx > 0) {
    const ruleIdx = findLastIndex(all.slice(0, promptIdx), (l) => /^[\s─━]{20,}$/.test(l) && /[─━]/.test(l));
    all = all.slice(0, ruleIdx > 0 ? ruleIdx : promptIdx);
  }
  const cleaned = all
    .map((l) => l.replace(/[─-╿▀-▟▐-▟▐▛▜▝▘▙▟]/g, " ").replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 1 && !/^[>\-|.:·•\s]*$/.test(l))
    .filter((l) => !/Channels \(experimental\)|restart without --dangerously|^stop$|auto mode on|shift\+tab|\? for shortcuts/i.test(l));
  return cleaned.slice(-lines).join("\n");
}

function findLastIndex<T>(arr: T[], pred: (x: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

export function sendKeys(pane: string, ...keys: string[]): boolean {
  const r = run(["send-keys", "-t", pane, ...keys]);
  if (!r.ok) log.warn(`send-keys to ${pane} failed: ${r.err.trim()}`);
  return r.ok;
}

/** Type literal text into a pane (no key-name interpretation). */
export function sendText(pane: string, text: string): boolean {
  return run(["send-keys", "-t", pane, "-l", text]).ok;
}

export function sessionExists(name: string): boolean {
  return run(["has-session", "-t", `=${name}`]).ok;
}

/** Start a detached tmux session running `command` in `cwd`. Returns the pane id. */
export function newDetachedSession(name: string, cwd: string, command: string[], env: Record<string, string> = {}): string | null {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const r = run(["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", name, "-c", cwd, ...envArgs, ...command], 10_000);
  if (!r.ok) {
    log.error(`new-session ${name} failed: ${r.err.trim()}`);
    return null;
  }
  return r.out.trim() || null;
}

/**
 * Wait for a pane to show `pattern`, then press keys. Used to accept the development-channels
 * warning for sessions the hub starts. Resolves true when the pattern was seen.
 */
export async function waitForAndPress(pane: string, pattern: RegExp, keys: string[], timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const txt = capturePane(pane, 40);
    if (txt && pattern.test(txt)) {
      await Bun.sleep(400);
      sendKeys(pane, ...keys);
      return true;
    }
    await Bun.sleep(500);
  }
  return false;
}
