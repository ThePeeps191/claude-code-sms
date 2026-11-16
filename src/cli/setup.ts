import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Config, loadConfig, saveConfig, DEFAULT_CONFIG, type ProviderName } from "../shared/config.ts";
import { loadSecrets, saveSecrets } from "../shared/secrets.ts";
import { normalizeE164, maskNumber } from "../shared/e164.ts";
import { paths } from "../shared/paths.ts";
import { hubJson } from "../shared/api.ts";
import { createProvider, destinationsFor } from "../providers/index.ts";
import { findClaude } from "../hub/router.ts";
import { tmuxAvailable } from "../hub/tmux.ts";
import { installShims, CHANNEL_SPEC, repoRoot } from "./install.ts";
import { installService, startHub, restartHub, hubHealthy, waitForHub, protectedLocation } from "./service.ts";
import { ask, askSecret, choose, confirm, ok, bad, warn, info, step, bold, dim, interactive, setAssumeYes } from "./ui.ts";

export interface SetupFlags {
  provider?: ProviderName;
  owners?: string[];
  number?: string;
  tunnel?: "quick" | "url" | "none";
  publicUrl?: string;
  budget?: number;
  pin?: string;
  spawnRoots?: string[];
  yes?: boolean;
  noService?: boolean;
  skipTest?: boolean;
  step?: string;
}

const PROVIDER_HELP: Record<string, string> = {
  telnyx: "Telnyx portal -> Keys & Credentials: create an API key (starts with KEY...) and copy the Public Key (for webhook signatures).",
  twilio: "Twilio console -> Account info: Account SID (AC...) and Auth Token.",
};

/** Prompt for and store provider credentials. Returns false if they don't validate. */
export async function login(provider: ProviderName): Promise<boolean> {
  if (provider === "fake") { ok("The fake provider needs no credentials."); return true; }
  info(PROVIDER_HELP[provider]);
  info("Input is hidden and stored only in ~/.claude-code-sms/secrets.env (mode 600).");
  const values: Record<string, string> = {};
  if (provider === "telnyx") {
    values.TELNYX_API_KEY = await askSecret("Telnyx API key");
    values.TELNYX_PUBLIC_KEY = await askSecret("Telnyx public key (base64)");
  } else {
    values.TWILIO_ACCOUNT_SID = (await ask("Twilio Account SID")).trim();
    values.TWILIO_AUTH_TOKEN = await askSecret("Twilio Auth Token");
  }
  if (Object.values(values).some((v) => !v)) { bad("A value was empty; nothing saved."); return false; }
  const cfg = safeLoad();
  const p = createProvider({ ...cfg, provider: { ...cfg.provider, name: provider } }, { ...loadSecrets(), ...values });
  try {
    const summary = await p.validateCredentials();
    saveSecrets(values);
    ok(`Credentials work (${summary}). Saved.`);
    return true;
  } catch (e: any) {
    bad(`Those credentials didn't work: ${e?.message ?? e}`);
    return false;
  }
}

function safeLoad(): Config {
  try { return loadConfig(); } catch { return structuredClone(DEFAULT_CONFIG); }
}

export async function setup(flags: SetupFlags): Promise<number> {
  if (flags.yes) setAssumeYes(true);
  const TOTAL = 9;
  let cfg = safeLoad();
  console.log(bold("\nclaude-code-sms setup") + dim("  (re-run any time; existing answers are the defaults)\n"));

  // 1. Prerequisites
  step(1, TOTAL, "Prerequisites");
  const claude = findClaude(cfg.system.claudePath);
  const claudeOk = existsSync(claude) || Bun.which("claude");
  claudeOk ? ok(`Claude Code: ${claude}`) : bad("Claude Code not found. Install it first: https://claude.com/claude-code");
  ok(`Bun ${Bun.version}`);
  tmuxAvailable() ? ok("tmux") : warn("tmux not found: needed for claude-sms sessions (peek, halt, start by text). Install: brew install tmux / apt install tmux");
  if (!claudeOk) return 1;
  cfg.system.claudePath = claude;

  // 2. Provider
  step(2, TOTAL, "SMS provider");
  const provider: ProviderName = flags.provider ?? await choose("Which SMS provider?", [
    { value: "telnyx", label: "Telnyx  (low prices; see docs/providers/telnyx.md)" },
    { value: "twilio", label: "Twilio  (see docs/providers/twilio.md)" },
    { value: "fake", label: "Fake    (no real texts; try everything locally with 'ccsms phone')" },
  ], cfg.provider.name);
  cfg.provider.name = provider;

  // 3. Credentials
  step(3, TOTAL, "Credentials");
  if (provider !== "fake") {
    const sec = loadSecrets();
    const have = provider === "telnyx" ? sec.TELNYX_API_KEY && sec.TELNYX_PUBLIC_KEY : sec.TWILIO_ACCOUNT_SID && sec.TWILIO_AUTH_TOKEN;
    let valid = false;
    if (have) {
      try { const s = await createProvider(cfg, sec).validateCredentials(); ok(`Saved credentials work (${s}).`); valid = true; }
      catch (e: any) { warn(`Saved credentials failed: ${e?.message ?? e}`); }
    }
    if (!valid || (interactive() && await confirm("Enter new credentials?", false))) {
      if (!interactive()) { bad(`Run 'ccsms login ${provider}' in a terminal to enter credentials, then re-run setup.`); return 1; }
      for (let i = 0; i < 3 && !(valid = await login(provider)); i++) {}
      if (!valid) return 1;
    }
  } else ok("Not needed for the fake provider.");

  // 4. Owner numbers
  step(4, TOTAL, "Your phone number(s)");
  info("Only texts from these numbers are acted on. Everything else is ignored silently.");
  let owners = (flags.owners ?? []).map((n) => normalizeE164(n)).filter(Boolean) as string[];
  if (!owners.length) {
    const def = cfg.owners.numbers.join(", ");
    for (;;) {
      const a = await ask("Your mobile number(s), comma-separated, in +<country><number> form (first = primary)", def);
      owners = a.split(",").map((s) => normalizeE164(s)).filter(Boolean) as string[];
      if (owners.length) break;
      if (!interactive()) { bad("No owner number given (use --owner +15551234567)."); return 1; }
      bad("That doesn't look like a phone number. Example: +15551234567");
    }
  }
  cfg.owners.numbers = [...new Set(owners)];
  ok(`Owner number(s): ${cfg.owners.numbers.map(maskNumber).join(", ")}`);

  // 5. SMS number
  step(5, TOTAL, "The number texts come from");
  if (provider === "fake") {
    cfg.provider.number = "";
    ok("The fake provider has no number.");
  } else {
    const p = createProvider(cfg, loadSecrets());
    let number = flags.number ? normalizeE164(flags.number) ?? "" : "";
    if (!number) {
      const owned = await p.listNumbers().catch((e) => { warn(`Couldn't list numbers: ${e?.message ?? e}`); return []; });
      const opts = owned.map((n) => ({ value: n.number, label: n.number }));
      if (opts.length) {
        const def = opts.find((o) => o.value === cfg.provider.number)?.value ?? opts[0].value;
        number = await choose("Use which number?", [...opts, { value: "__buy", label: "Buy a new number" }], def as string);
      } else {
        info("No numbers on this account yet.");
        number = "__buy";
      }
      if (number === "__buy") number = await buyFlow(p, cfg.owners.numbers[0]);
      if (!number) return 1;
    }
    cfg.provider.number = number;
    ok(`Texts will come from ${number}`);
  }

  // 6. Tunnel
  step(6, TOTAL, "How your provider reaches this computer");
  if (provider === "fake") {
    cfg.tunnel.kind = "none";
    ok("Not needed for the fake provider.");
  } else {
    const kind = flags.tunnel ?? await choose("Tunnel", [
      { value: "quick", label: "Cloudflare quick tunnel (no account; URL changes on restart and is re-registered automatically)" },
      { value: "url", label: "My own stable https URL (ngrok static domain, Tailscale Funnel, Cloudflare named tunnel...)" },
    ], cfg.tunnel.kind === "none" ? "quick" : cfg.tunnel.kind) as "quick" | "url";
    cfg.tunnel.kind = kind;
    if (kind === "quick") {
      const cf = Bun.which("cloudflared") ?? ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"].find(existsSync);
      if (cf) ok(`cloudflared: ${cf}`);
      else {
        warn("cloudflared is not installed.");
        if (Bun.which("brew") && await confirm("Install it now with Homebrew (brew install cloudflared)?", true)) {
          const r = Bun.spawnSync(["brew", "install", "cloudflared"], { stdout: "inherit", stderr: "inherit" });
          r.exitCode === 0 ? ok("cloudflared installed") : bad("brew install failed");
        } else info("Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
      }
    } else {
      const url = flags.publicUrl ?? await ask("Public https URL that forwards to http://127.0.0.1:47914", cfg.tunnel.publicUrl);
      if (!/^https:\/\//.test(url)) { bad("The URL must start with https://"); return 1; }
      cfg.tunnel.publicUrl = url.replace(/\/+$/, "");
      info("Keep your tunnel running and pointed at http://127.0.0.1:47914 (see docs/SETUP.md).");
    }
  }

  // 7. Options
  step(7, TOTAL, "Options (Enter keeps the default)");
  const budget = flags.budget ?? Number(await ask("Daily text budget (segments)", String(cfg.budget.dailySegments)));
  if (Number.isInteger(budget) && budget > 0) cfg.budget.dailySegments = budget;
  if (flags.pin !== undefined) cfg.security.unlockPin = flags.pin;
  else if (interactive()) {
    info("Caller ID can be spoofed. An optional PIN makes texts need 'unlock <PIN>' first (good if your sessions run with broad permissions).");
    const pin = await ask("PIN (4-12 digits, blank = off)", cfg.security.unlockPin);
    if (pin === "" || /^\d{4,12}$/.test(pin)) cfg.security.unlockPin = pin;
    else warn("Not a 4-12 digit PIN; leaving it unchanged.");
  }
  if (flags.spawnRoots) cfg.spawn.roots = flags.spawnRoots;
  else if (interactive()) {
    const a = await ask("Folders where texts may START new sessions (comma-separated, blank = disabled)", cfg.spawn.roots.join(", "));
    cfg.spawn.roots = a.split(",").map((s) => s.trim()).filter(Boolean).map((s) => (s.startsWith("~") ? join(homedir(), s.slice(1)) : s));
  }
  saveConfig(cfg);
  ok(`Saved ${paths.config}`);

  // 8. Install + service
  step(8, TOTAL, "Install the background hub");
  const sh = installShims();
  ok(`Commands: ${sh.linked.map((l) => l.replace(homedir(), "~")).join(", ") || "(could not link into ~/.local/bin)"}`);
  if (sh.pathHint) warn(sh.pathHint);
  let running = false;
  const prot = protectedLocation(repoRoot());
  if (prot && !flags.noService) {
    warn(`The plugin files are in ~/${prot}, which macOS doesn't let background services read. The hub would hang.`);
    warn("Install the plugin from its marketplace instead (it lives under ~/.claude/plugins), or run the hub in a terminal: ccsms hub");
    flags.noService = true;
  }
  if (!flags.noService) {
    const s = installService();
    s.ok ? ok(`Service: ${s.detail}`) : warn(`Service: ${s.detail}`);
    const h = await hubHealthy();
    const r = h.ok ? await restartHub() : await startHub();
    running = r.ok;
  } else {
    running = (await startHub()).ok;
  }
  running ? ok("Hub is running") : bad(`Hub didn't start. Check: ccsms logs`);
  if (!running) return 1;

  // 9. Round trip
  step(9, TOTAL, "Test");
  if (provider === "fake") {
    ok("Setup done. Try it: run 'ccsms phone' in one terminal and 'claude-sms' in another.");
  } else if (!flags.skipTest) {
    const wired = await waitForWebhook(provider, cfg.tunnel.kind === "quick" ? 45_000 : 20_000);
    if (!wired.ok) { bad(`The provider webhook isn't set up: ${wired.error}. Run 'ccsms doctor'.`); return 1; }
    ok(`Webhook: ${wired.url}`);
    const roundTrip = await testRoundTrip(cfg.owners.numbers[0]);
    if (!roundTrip) return 1;
  }

  console.log(`
${bold("You're set.")} Three things to know:
  1. Start sessions with ${bold("claude-sms")} (same arguments as claude) so they can receive texts.
     The first screen asks you to confirm the development channel: choose "I am using this for local development".
  2. Text ${bold("away")} when you leave and ${bold("home")} when you're back (or sit down at the computer).
  3. Text ${bold("?")} for commands. Never text just STOP: carriers treat it as unsubscribe (text START to undo).
`);
  return 0;
}

async function buyFlow(p: ReturnType<typeof createProvider>, ownerNumber: string): Promise<string> {
  if (!interactive()) { bad("Pass an existing number with --number (buying needs interactive confirmation)."); return ""; }
  const country = (await ask("Country for the new number (2 letters)", ownerNumber.startsWith("+1") ? "US" : "")).toUpperCase();
  const area = await ask("Area code (optional)", ownerNumber.startsWith("+1") ? ownerNumber.slice(2, 5) : "");
  let found;
  try { found = await p.searchNumbers(country, { areaCode: area || undefined, limit: 8 }); }
  catch (e: any) { bad(`Search failed: ${e?.message ?? e}`); return ""; }
  if (!found.length && area) found = await p.searchNumbers(country, { limit: 8 }).catch(() => []);
  if (!found.length) { bad("No numbers available there. Try another area code, or buy one in your provider's portal."); return ""; }
  const pick = await choose("Pick a number", found.map((n) => ({
    value: n.number,
    label: `${n.number}  ${[n.locality, n.region].filter(Boolean).join(", ")}${n.monthly ? `  ${n.upfront ?? "?"} upfront + ${n.monthly}/month ${n.currency ?? ""}` : ""}`,
  })), found[0].number);
  const price = found.find((n) => n.number === pick);
  const priceText = price?.monthly ? `${price.upfront ?? "?"} upfront + ${price.monthly}/month ${price.currency ?? ""}` : "the price shown in your provider's portal";
  if (!(await confirm(`Buy ${pick} for ${priceText}? This charges your provider account and is usually non-refundable.`, false))) return "";
  try { await p.buyNumber(pick); ok(`Ordered ${pick}.`); }
  catch (e: any) { bad(`Purchase failed: ${e?.message ?? e}`); return ""; }
  for (let i = 0; i < 20; i++) {
    const owned = await p.listNumbers().catch(() => []);
    if (owned.some((n) => n.number === pick)) return pick;
    await Bun.sleep(3000);
  }
  warn("The order is still processing; continuing anyway.");
  return pick;
}

async function waitForWebhook(provider: string, ms: number): Promise<{ ok: boolean; url?: string; error?: string }> {
  await hubJson("/api/reload", {}).catch(() => {});
  const end = Date.now() + ms;
  let last: any = null;
  while (Date.now() < end) {
    try {
      const s = (await hubJson("/api/status")) as any;
      last = s.webhook;
      if (s.webhook?.ok && s.webhook.url?.includes(`/sms/${provider}`)) return { ok: true, url: s.webhook.url };
    } catch {}
    await Bun.sleep(1000);
  }
  return { ok: false, error: last?.error ?? "timed out waiting for the tunnel/webhook" };
}

async function testRoundTrip(owner: string): Promise<boolean> {
  const since = Date.now();
  const text = "claude-code-sms is connected. Reply OK to finish setup.";
  const r = (await hubJson("/api/test-text", { text })) as any;
  if (r.lastSendError && r.lastSendError.at >= since) { bad(`Sending failed: ${r.lastSendError.message}`); return false; }
  info(`Texted ${maskNumber(owner)}. Reply OK from your phone (waiting up to 3 minutes)...`);
  const end = Date.now() + 180_000;
  while (Date.now() < end) {
    const msgs = (await hubJson(`/api/messages?since=${since}`)) as any[];
    if (msgs.some((m) => m.direction === "in")) { ok("Got your reply. Sending and receiving both work."); return true; }
    await Bun.sleep(2000);
  }
  bad("No reply arrived. Check 'ccsms doctor' and your provider's message logs (trial accounts may only text verified numbers).");
  return false;
}
