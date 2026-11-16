import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, chmodSync, existsSync } from "node:fs";

/** Root of all claude-code-sms state. Override with CCSMS_HOME (used by tests). */
export function stateDir(): string {
  return process.env.CCSMS_HOME || join(homedir(), ".claude-code-sms");
}

export const paths = {
  get root() { return stateDir(); },
  get config() { return join(stateDir(), "config.toml"); },
  get secrets() { return join(stateDir(), "secrets.env"); },
  get db() { return join(stateDir(), "hub.db"); },
  get logs() { return join(stateDir(), "logs"); },
  get hubLog() { return join(stateDir(), "logs", "hub.log"); },
  get socket() { return join(stateDir(), "hub.sock"); },
  get installJson() { return join(stateDir(), "install.json"); },
  get routerCwd() { return join(stateDir(), "router"); },
  get bin() { return join(stateDir(), "bin"); },
  get shim() { return join(stateDir(), "bin", "ccsms"); },
  get pidFile() { return join(stateDir(), "hub.pid"); },
};

/** Fixed loopback ports. hooks.json cannot interpolate the URL, so the internal port is fixed. */
export const INTERNAL_PORT = Number(process.env.CCSMS_INTERNAL_PORT || 47913);
export const PUBLIC_PORT = Number(process.env.CCSMS_PUBLIC_PORT || 47914);
export const INTERNAL_URL = `http://127.0.0.1:${INTERNAL_PORT}`;

export function ensureStateDir(): void {
  for (const d of [stateDir(), paths.logs, paths.routerCwd, paths.bin]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
  try { chmodSync(stateDir(), 0o700); } catch {}
}

/** Directory of the installed plugin (repo root). */
export function pluginRoot(): string {
  return process.env.CLAUDE_PLUGIN_ROOT || join(import.meta.dir, "..", "..");
}
