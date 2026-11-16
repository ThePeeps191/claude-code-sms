import { existsSync, mkdirSync, writeFileSync, unlinkSync, openSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join, dirname } from "node:path";
import { paths, INTERNAL_URL, ensureStateDir } from "../shared/paths.ts";

export const LABEL = "com.claude-code-sms.hub";
const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const unitPath = () => join(homedir(), ".config", "systemd", "user", "claude-code-sms.service");

function sh(cmd: string[]): { ok: boolean; out: string } {
  try {
    const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return { ok: p.exitCode === 0, out: (p.stdout.toString() + p.stderr.toString()).trim() };
  } catch (e: any) { return { ok: false, out: String(e?.message ?? e) }; }
}

export async function hubHealthy(timeoutMs = 800): Promise<{ ok: boolean; version?: string; pid?: number }> {
  try {
    const r = await fetch(`${INTERNAL_URL}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { ok: false };
    const j = (await r.json()) as any;
    return { ok: true, version: j.version, pid: j.pid };
  } catch { return { ok: false }; }
}

export async function waitForHub(ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await hubHealthy()).ok) return true;
    await Bun.sleep(400);
  }
  return false;
}

/** PATH for the service: launchd/systemd start with a minimal PATH. */
function servicePath(): string {
  const dirs = new Set<string>();
  for (const b of ["bun", "claude", "tmux", "cloudflared"]) {
    const w = Bun.which(b);
    if (w) dirs.add(dirname(w));
  }
  for (const d of [join(homedir(), ".bun/bin"), join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]) dirs.add(d);
  return [...dirs].join(":");
}

export function serviceKind(): "launchd" | "systemd" | "none" {
  if (platform() === "darwin") return "launchd";
  if (platform() === "linux" && sh(["systemctl", "--user", "--version"]).ok) return "systemd";
  return "none";
}

export function serviceInstalled(): boolean {
  const k = serviceKind();
  return k === "launchd" ? existsSync(plistPath()) : k === "systemd" ? existsSync(unitPath()) : false;
}

export function installService(): { ok: boolean; detail: string } {
  ensureStateDir();
  const k = serviceKind();
  const shim = paths.shim;
  if (k === "launchd") {
    const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xmlEsc(shim)}</string><string>hub</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEsc(servicePath())}</string>
    <key>HOME</key><string>${xmlEsc(homedir())}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xmlEsc(join(paths.logs, "hub.out"))}</string>
  <key>StandardErrorPath</key><string>${xmlEsc(join(paths.logs, "hub.out"))}</string>
</dict>
</plist>
`;
    mkdirSync(dirname(plistPath()), { recursive: true });
    const uid = userInfo().uid;
    sh(["launchctl", "bootout", `gui/${uid}/${LABEL}`]);
    writeFileSync(plistPath(), plist);
    const r = sh(["launchctl", "bootstrap", `gui/${uid}`, plistPath()]);
    return { ok: r.ok || /already/i.test(r.out), detail: r.ok ? `launchd agent ${LABEL}` : r.out };
  }
  if (k === "systemd") {
    const unit = `[Unit]
Description=claude-code-sms hub
After=network-online.target

[Service]
ExecStart=${shim} hub
Restart=on-failure
RestartSec=10
Environment=PATH=${servicePath()}

[Install]
WantedBy=default.target
`;
    mkdirSync(dirname(unitPath()), { recursive: true });
    writeFileSync(unitPath(), unit);
    sh(["systemctl", "--user", "daemon-reload"]);
    const r = sh(["systemctl", "--user", "enable", "--now", "claude-code-sms.service"]);
    return { ok: r.ok, detail: r.ok ? "systemd user service claude-code-sms (tip: 'loginctl enable-linger' keeps it running after logout)" : r.out };
  }
  return { ok: false, detail: "no supported service manager; use 'ccsms start' after each login" };
}

export function uninstallService(): void {
  const k = serviceKind();
  if (k === "launchd") {
    sh(["launchctl", "bootout", `gui/${userInfo().uid}/${LABEL}`]);
    try { unlinkSync(plistPath()); } catch {}
  } else if (k === "systemd") {
    sh(["systemctl", "--user", "disable", "--now", "claude-code-sms.service"]);
    try { unlinkSync(unitPath()); } catch {}
    sh(["systemctl", "--user", "daemon-reload"]);
  }
}

export async function startHub(): Promise<{ ok: boolean; how: string }> {
  if ((await hubHealthy()).ok) return { ok: true, how: "already running" };
  const k = serviceKind();
  if (k === "launchd" && existsSync(plistPath())) {
    const uid = userInfo().uid;
    const r = sh(["launchctl", "kickstart", `gui/${uid}/${LABEL}`]);
    if (!r.ok) sh(["launchctl", "bootstrap", `gui/${uid}`, plistPath()]);
    return { ok: await waitForHub(), how: "launchd" };
  }
  if (k === "systemd" && existsSync(unitPath())) {
    sh(["systemctl", "--user", "start", "claude-code-sms.service"]);
    return { ok: await waitForHub(), how: "systemd" };
  }
  // No service installed: run detached.
  ensureStateDir();
  const out = openSync(join(paths.logs, "hub.out"), "a");
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "..", "hub", "main.ts")], {
    stdout: out, stderr: out, stdin: "ignore", env: { ...process.env, PATH: servicePath() },
  });
  p.unref();
  return { ok: await waitForHub(), how: "background process" };
}

export async function stopHub(): Promise<void> {
  const k = serviceKind();
  if (k === "launchd" && existsSync(plistPath())) {
    sh(["launchctl", "kill", "SIGTERM", `gui/${userInfo().uid}/${LABEL}`]);
  } else if (k === "systemd" && existsSync(unitPath())) {
    sh(["systemctl", "--user", "stop", "claude-code-sms.service"]);
  }
  const h = await hubHealthy();
  if (h.ok && h.pid) { try { process.kill(h.pid, "SIGTERM"); } catch {} }
  for (let i = 0; i < 25 && (await hubHealthy(300)).ok; i++) await Bun.sleep(200);
}

export async function restartHub(): Promise<{ ok: boolean; how: string }> {
  const k = serviceKind();
  if (k === "launchd" && existsSync(plistPath())) {
    sh(["launchctl", "kickstart", "-k", `gui/${userInfo().uid}/${LABEL}`]);
    await Bun.sleep(500);
    return { ok: await waitForHub(), how: "launchd" };
  }
  await stopHub();
  return startHub();
}
