#!/usr/bin/env bun
import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { paths, INTERNAL_URL } from "../shared/paths.ts";
import { loadConfig, saveConfig, getKey, setKey, ConfigError, type ProviderName } from "../shared/config.ts";
import { normalizeE164, maskNumber } from "../shared/e164.ts";
import { VERSION } from "../shared/version.ts";
import { findClaude } from "../hub/router.ts";
import { tmuxAvailable } from "../hub/tmux.ts";
import { setup, login, type SetupFlags } from "./setup.ts";
import { doctor } from "./doctor.ts";
import { startHub, stopHub, restartHub, hubHealthy, uninstallService } from "./service.ts";
import { installShims, removeShims, readInstall, CHANNEL_SPEC } from "./install.ts";
import { ok, bad, warn, info, bold, dim, cyan, green, confirm, setAssumeYes } from "./ui.ts";

const USAGE = `${bold("ccsms")} ${dim(`v${VERSION}`)}  claude-code-sms: text your Claude Code sessions

${bold("Getting started")}
  ccsms setup                 guided setup (provider, numbers, tunnel, service, test text)
  claude-sms [claude args]    start Claude Code so it can send AND receive texts (alias: ccsms claude)
  ccsms doctor                check everything and print fixes

${bold("Everyday")}
  ccsms status                hub, sessions, mode, today's texts
  ccsms away | home | pause | resume
  ccsms watch <session> [on|off|quiet]
  ccsms phone                 fake phone in this terminal (no texts, no cost)
  ccsms test [text]           send yourself a test text
  ccsms logs                  follow the hub log

${bold("Manage")}
  ccsms login <telnyx|twilio> enter provider credentials (hidden input)
  ccsms config [get <key> | set <key> <value> | add-owner <num> | remove-owner <num> | path]
  ccsms start | stop | restart
  ccsms unlock                clear lockdown / opt-out warnings
  ccsms install               (re)link ccsms + claude-sms into ~/.local/bin
  ccsms uninstall             remove the service, links and (optionally) all data
`;

async function api(path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${INTERNAL_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  return r.json();
}

async function requireHub(): Promise<boolean> {
  if ((await hubHealthy()).ok) return true;
  bad("The hub isn't running. Start it: ccsms start");
  return false;
}

function parseFlags(argv: string[]): { flags: Record<string, string[]>; rest: string[] } {
  const flags: Record<string, string[]> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      const next = argv[i + 1];
      const val = v ?? (next && !next.startsWith("--") ? (i++, next) : "true");
      (flags[k] ??= []).push(val);
    } else rest.push(a);
  }
  return { flags, rest };
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case undefined: case "help": case "-h": case "--help":
      console.log(USAGE); return 0;
    case "version": case "-v": case "--version":
      console.log(VERSION); return 0;

    case "hub": {
      await import("../hub/main.ts");
      await new Promise(() => {}); // run forever
      return 0;
    }

    case "setup": {
      const { flags } = parseFlags(args);
      const f: SetupFlags = {
        provider: flags.provider?.[0] as ProviderName | undefined,
        owners: flags.owner?.flatMap((s) => s.split(",")),
        number: flags.number?.[0],
        tunnel: flags.tunnel?.[0] as any,
        publicUrl: flags["public-url"]?.[0],
        budget: flags.budget ? Number(flags.budget[0]) : undefined,
        pin: flags.pin?.[0],
        spawnRoots: flags["spawn-root"],
        yes: Boolean(flags.yes),
        noService: Boolean(flags["no-service"]),
        skipTest: Boolean(flags["skip-test"]),
      };
      return setup(f);
    }

    case "login": {
      const p = args[0] as ProviderName;
      if (p !== "telnyx" && p !== "twilio") { bad("Usage: ccsms login <telnyx|twilio>"); return 1; }
      const done = await login(p);
      if (done && (await hubHealthy()).ok) await api("/api/reload", {});
      return done ? 0 : 1;
    }

    case "doctor": return doctor();

    case "install": {
      const r = installShims();
      ok(`Linked: ${r.linked.join(", ") || "nothing"}`);
      if (r.pathHint) warn(r.pathHint);
      return 0;
    }

    case "start": {
      const r = await startHub();
      r.ok ? ok(`Hub running (${r.how})`) : bad(`Hub didn't start. Check: ccsms logs`);
      return r.ok ? 0 : 1;
    }
    case "stop": await stopHub(); ok("Hub stopped (it restarts at next login if installed as a service)."); return 0;
    case "restart": {
      const r = await restartHub();
      r.ok ? ok(`Hub restarted (${r.how})`) : bad("Hub didn't come back. Check: ccsms logs");
      return r.ok ? 0 : 1;
    }

    case "status": {
      if (!(await requireHub())) return 1;
      const s = await api("/api/status");
      console.log(`${bold("Mode")}: ${s.mode.mode}${s.mode.until ? ` until ${new Date(s.mode.until).toLocaleTimeString()}` : ""}${s.lockdown ? "  (LOCKDOWN)" : ""}`);
      console.log(`${bold("Provider")}: ${s.provider}${s.number ? ` from ${s.number}` : ""}   ${bold("Webhook")}: ${s.webhook ? (s.webhook.ok ? s.webhook.url : `error: ${s.webhook.error}`) : "-"}`);
      console.log(`${bold("Texts")}: ${s.cost}`);
      console.log(`${bold("Models")}: dispatcher ${s.models.router}, summarizer ${s.models.summarizer}`);
      if (s.lastSendError) warn(`last send error: ${s.lastSendError.message}`);
      console.log(bold(`Sessions (${s.sessions.length})`));
      for (const x of s.sessions) {
        console.log(`  ${x.num} ${cyan(x.name.padEnd(10))} ${x.status.padEnd(5)} ${x.canReceive ? green("texts in+out") : dim("texts out only")} ${x.watch !== "default" ? `[${x.watch}] ` : ""}${dim(x.cwd)}`);
        if (x.activity || x.summary) console.log(`      ${dim(x.status === "busy" ? x.activity ?? "" : x.summary ?? "")}`);
      }
      return 0;
    }

    case "away": case "home": case "pause": case "resume": case "mode": {
      const m = cmd === "mode" ? args[0] : cmd;
      if (!["away", "home", "pause", "resume"].includes(m ?? "")) { bad("Usage: ccsms away|home|pause|resume"); return 1; }
      if (!(await requireHub())) return 1;
      const r = await api("/api/mode", { mode: m === "pause" ? "paused" : m });
      ok(`Mode: ${r.mode}`);
      return 0;
    }

    case "watch": {
      const [session, lvl = "on"] = args;
      if (!session) { bad("Usage: ccsms watch <session> [on|off|quiet]"); return 1; }
      if (!(await requireHub())) return 1;
      const level = lvl === "on" ? "watched" : lvl === "off" ? "muted" : "default";
      const r = await api("/api/watch", { session, level });
      r.ok ? ok(`${r.name}: ${level}`) : bad(r.error);
      return r.ok ? 0 : 1;
    }

    case "unlock": {
      if (!(await requireHub())) return 1;
      await api("/api/unlock", {});
      ok("Unlocked: lockdown and opt-out warnings cleared.");
      return 0;
    }

    case "test": {
      if (!(await requireHub())) return 1;
      const r = await api("/api/test-text", { text: args.join(" ") || undefined });
      if (!r.ok) { bad(r.error); return 1; }
      r.lastSendError ? bad(`Send failed: ${r.lastSendError.message}`) : ok("Sent.");
      return r.lastSendError ? 1 : 0;
    }

    case "logs": {
      const file = paths.hubLog;
      if (!existsSync(file)) { bad(`No log yet at ${file}`); return 1; }
      const p = Bun.spawn(["tail", "-n", "60", "-f", file], { stdout: "inherit", stderr: "inherit" });
      await p.exited;
      return 0;
    }

    case "config": return configCmd(args);
    case "claude": return launchClaude(args);
    case "phone": return phone();
    case "uninstall": return uninstall(args);
    default:
      bad(`Unknown command: ${cmd}`);
      console.log(USAGE);
      return 1;
  }
}

async function configCmd(args: string[]): Promise<number> {
  const [sub, key, ...vals] = args;
  try {
    const cfg = loadConfig();
    switch (sub) {
      case undefined:
      case "show":
        console.log(existsSync(paths.config) ? readFileSync(paths.config, "utf8") : "(no config yet; run ccsms setup)");
        return 0;
      case "path": console.log(paths.config); return 0;
      case "get": console.log(JSON.stringify(getKey(cfg, key), null, 2)); return 0;
      case "set": {
        if (!key || !vals.length) { bad("Usage: ccsms config set <key> <value>"); return 1; }
        saveConfig(setKey(cfg, key, vals.join(" ")));
        ok(`${key} = ${JSON.stringify(getKey(loadConfig(), key))}`);
        return 0;
      }
      case "add-owner": case "remove-owner": {
        const n = normalizeE164(key ?? "");
        if (!n) { bad("Give a phone number like +15551234567"); return 1; }
        cfg.owners.numbers = sub === "add-owner" ? [...new Set([...cfg.owners.numbers, n])] : cfg.owners.numbers.filter((x) => x !== n);
        saveConfig(cfg);
        ok(`Owners: ${cfg.owners.numbers.map(maskNumber).join(", ") || "(none)"}`);
        return 0;
      }
      default: bad(`Unknown config command ${sub}`); return 1;
    }
  } catch (e) {
    bad(e instanceof ConfigError ? e.message : String((e as any)?.message ?? e));
    return 1;
  }
}

/** Start Claude Code with the SMS channel, inside tmux so the hub can peek/halt/answer dialogs. */
async function launchClaude(args: string[]): Promise<number> {
  const claude = findClaude(safeCfg()?.system.claudePath);
  const spec = readInstall().channelSpec ?? CHANNEL_SPEC;
  const claudeArgs = ["--dangerously-load-development-channels", spec, ...args];
  if (!(await hubHealthy()).ok) {
    const r = await startHub();
    if (!r.ok) warn("The hub isn't running, so texts won't flow until it is (ccsms start).");
  }
  const env = { ...process.env, CCSMS_CHANNEL: "1" };
  if (process.env.TMUX || process.env.CCSMS_NO_TMUX || !tmuxAvailable() || !process.stdin.isTTY) {
    if (!process.env.TMUX && !tmuxAvailable()) warn("tmux not found: peek/halt and answering on-screen questions by text won't work for this session.");
    const p = Bun.spawn([claude, ...claudeArgs], { stdio: ["inherit", "inherit", "inherit"], env });
    return await p.exited;
  }
  const base = basename(process.cwd()).toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 16) || "session";
  let name = `ccsms-${base}`;
  for (let i = 2; Bun.spawnSync(["tmux", "has-session", "-t", `=${name}`]).exitCode === 0; i++) name = `ccsms-${base}-${i}`;
  info(dim(`Running in tmux session "${name}" (detach: Ctrl-b d, reattach: tmux attach -t ${name})`));
  const p = Bun.spawn(["tmux", "new-session", "-s", name, "-c", process.cwd(), "-e", "CCSMS_CHANNEL=1", claude, ...claudeArgs], {
    stdio: ["inherit", "inherit", "inherit"], env,
  });
  return await p.exited;
}

function safeCfg() { try { return loadConfig(); } catch { return null; } }

/** A phone in the terminal: type texts as the owner, see the hub's replies. */
async function phone(): Promise<number> {
  if (!(await requireHub())) return 1;
  const s = await api("/api/status");
  const cfg = safeCfg();
  const from = cfg?.owners.numbers[0];
  if (!from) { bad("Set an owner number first: ccsms config add-owner +15551234567"); return 1; }
  console.log(bold("Fake phone") + dim(` as ${maskNumber(from)}. Type a text and press Enter. Ctrl-C to quit.`));
  if (s.provider !== "fake") warn(`Your provider is ${s.provider}: replies go to your real phone as real texts (shown here too).`);
  let lastId = 0;
  const show = (body: string) => process.stdout.write(`\r${green("hub>")} ${body.replace(/\n/g, "\n     ")}\n${cyan("you>")} `);
  // Real providers: poll the message log; fake provider: also stream.
  if (s.provider === "fake") {
    (async () => {
      const r = await fetch(`${INTERNAL_URL}/api/fake/stream`);
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (line) { const m = JSON.parse(line.slice(6)); show(m.body); }
        }
      }
    })().catch(() => {});
  } else {
    const since = Date.now();
    setInterval(async () => {
      const msgs = (await api(`/api/messages?since=${since}&after=${lastId}`).catch(() => [])) as any[];
      for (const m of msgs) { lastId = Math.max(lastId, m.id); if (m.direction === "out") show(m.body); }
    }, 1500);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: cyan("you> ") });
  rl.prompt();
  rl.on("line", async (line) => {
    const text = line.trim();
    if (text) await api("/api/fake/inbound", { from, text }).catch((e) => bad(String(e)));
    rl.prompt();
  });
  await new Promise<void>((resolve) => rl.on("close", () => resolve()));
  return 0;
}

async function uninstall(args: string[]): Promise<number> {
  const { flags } = parseFlags(args);
  if (flags.yes) setAssumeYes(true);
  await stopHub();
  uninstallService();
  removeShims();
  ok("Stopped the hub, removed the service and the ccsms/claude-sms links.");
  if (await confirm(`Also delete all data in ${paths.root} (config, credentials, message log)?`, false)) {
    rmSync(paths.root, { recursive: true, force: true });
    ok("Deleted.");
  } else info(`Kept ${paths.root}.`);
  info(`Finally, remove the plugin from Claude Code: ${bold("claude plugin uninstall sms@claude-code-sms")}`);
  info("Your SMS number stays on your provider account; release it in their portal if you no longer need it.");
  return 0;
}

const code = await main(process.argv.slice(2));
if (process.argv[2] !== "hub") process.exit(code);
