import { existsSync } from "node:fs";
import { loadConfig, ConfigError, type Config } from "../shared/config.ts";
import { loadSecrets } from "../shared/secrets.ts";
import { paths } from "../shared/paths.ts";
import { hubJson } from "../shared/api.ts";
import { VERSION } from "../shared/version.ts";
import { createProvider } from "../providers/index.ts";
import { findClaude } from "../hub/router.ts";
import { tmuxAvailable } from "../hub/tmux.ts";
import { hubHealthy, serviceInstalled, serviceKind, protectedLocation } from "./service.ts";
import { readInstall } from "./install.ts";
import { ok, bad, warn, bold, dim } from "./ui.ts";

export async function doctor(): Promise<number> {
  let problems = 0;
  const fail = (s: string, fix: string) => { problems++; bad(`${s}\n    ${dim("fix:")} ${fix}`); };
  console.log(bold("claude-code-sms doctor") + dim(`  v${VERSION}\n`));

  // Tools
  ok(`Bun ${Bun.version}`);
  const claude = findClaude();
  if (existsSync(claude)) {
    const v = Bun.spawnSync([claude, "--version"], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
    ok(`Claude Code ${v}`);
  } else fail("Claude Code not found", "install Claude Code: https://claude.com/claude-code");
  tmuxAvailable() ? ok("tmux") : fail("tmux not installed (needed for claude-sms sessions)", "brew install tmux  (or apt install tmux)");

  // Plugin
  try {
    const p = Bun.spawnSync([claude, "plugin", "list", "--json"], { stdout: "pipe", stderr: "pipe" });
    const list = JSON.parse(p.stdout.toString() || "[]") as any[];
    const me = list.find((x) => String(x.id).startsWith("sms@"));
    if (!me) fail("The sms plugin isn't installed in Claude Code", "claude plugin install sms --marketplace ThePeeps191/claude-code-sms");
    else if (me.enabled === false) fail("The sms plugin is disabled", "claude plugin enable sms@claude-code-sms");
    else ok(`Plugin ${me.id} ${me.version ?? ""}`);
  } catch { warn("Couldn't check plugins (claude plugin list --json failed)"); }

  const root = readInstall().pluginRoot as string | undefined;
  const prot = root ? protectedLocation(root) : null;
  if (prot && serviceInstalled()) fail(`The hub service runs from ~/${prot}, which macOS blocks for background services`, "install the plugin from its marketplace (claude plugin install sms --marketplace ThePeeps191/claude-code-sms), then ccsms setup");

  // Config
  let cfg: Config | null = null;
  if (!existsSync(paths.config)) fail("No config yet", "ccsms setup");
  else {
    try { cfg = loadConfig(); ok(`Config ${paths.config}`); }
    catch (e) { fail(e instanceof ConfigError ? e.message : String(e), `edit ${paths.config} or re-run ccsms setup`); }
  }
  if (cfg) {
    cfg.owners.numbers.length ? ok(`${cfg.owners.numbers.length} owner number(s)`) : fail("No owner phone numbers", "ccsms config add-owner +15551234567");
    if (cfg.provider.name !== "fake") {
      if (!cfg.provider.number) fail("No sending number configured", "ccsms setup");
      const sec = loadSecrets();
      try {
        const s = await createProvider(cfg, sec).validateCredentials();
        ok(`${cfg.provider.name} credentials work (${s})`);
      } catch (e: any) { fail(`${cfg.provider.name} credentials: ${e?.message ?? e}`, `ccsms login ${cfg.provider.name}`); }
      if (cfg.tunnel.kind === "quick" && !Bun.which("cloudflared") && !["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"].some(existsSync)) {
        fail("cloudflared not installed (needed for the quick tunnel)", "brew install cloudflared");
      }
    } else ok("Provider: fake (no real texts)");
  }

  // Hub
  const h = await hubHealthy(1500);
  if (!h.ok) fail("Hub is not running", "ccsms start   (logs: ccsms logs)");
  else {
    h.version === VERSION ? ok(`Hub running (pid ${h.pid})`) : fail(`Hub is v${h.version} but the plugin is v${VERSION}`, "ccsms restart");
    serviceInstalled() ? ok(`Starts automatically (${serviceKind()})`) : warn("Hub isn't installed as a service; it won't start after a reboot. Fix: ccsms setup");
    const s = (await hubJson("/api/status")) as any;
    if (cfg && cfg.provider.name !== "fake") {
      if (!s.webhook) fail("Webhook not configured yet", "wait a few seconds after start, or check: ccsms logs");
      else if (!s.webhook.ok) fail(`Webhook setup failed: ${s.webhook.error}`, "check credentials/number, then: ccsms restart");
      else {
        ok(`Webhook ${s.webhook.url}`);
        try {
          const base = s.webhook.url.replace(/\/sms\/\w+$/, "");
          const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(8000) });
          r.ok ? ok("Public URL reaches this computer") : fail(`Public URL answered ${r.status}`, "check your tunnel");
        } catch (e: any) { fail(`Public URL unreachable: ${e?.message ?? e}`, "quick tunnels need ~30s after the hub starts (and your DNS may cache a miss for a minute); otherwise check ccsms logs"); }
      }
    }
    if (s.lastSendError) warn(`Last send error: ${s.lastSendError.message}`);
    if (s.optOutWarning) fail(`You texted "${s.optOutWarning.keyword}"; your provider may now block texts to you`, "text START to the hub number, then: ccsms unlock");
    if (s.lockdown) fail("Lockdown is on (inbound texts ignored)", "ccsms unlock");
    ok(`Mode: ${s.mode.mode}; budget ${s.budget.used}/${s.budget.limit} today; ${s.sessions.length} session(s)`);
  }

  console.log(problems ? `\n${problems} problem(s) found.` : "\nAll good.");
  return problems ? 1 : 0;
}
