#!/usr/bin/env bun
import { writeFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { platform } from "node:os";
import { Store } from "../shared/db.ts";
import { paths, ensureStateDir, PUBLIC_PORT, INTERNAL_URL } from "../shared/paths.ts";
import { configureLog, logger } from "../shared/log.ts";
import { ConfigError } from "../shared/config.ts";
import { VERSION } from "../shared/version.ts";
import { Hub, pidAlive } from "./hub.ts";
import { startInternalServer, startPublicServer, startBridgeSocket } from "./server.ts";
import { QuickTunnel } from "./tunnel.ts";

ensureStateDir();
configureLog({ file: paths.hubLog, stderr: process.stderr.isTTY ?? false });
const log = logger("main");

// Single instance: refuse to start if another hub answers.
try {
  const r = await fetch(`${INTERNAL_URL}/api/health`, { signal: AbortSignal.timeout(800) });
  if (r.ok) {
    console.error("claude-code-sms hub is already running.");
    process.exit(0);
  }
} catch {}
if (existsSync(paths.pidFile)) {
  const old = Number(readFileSync(paths.pidFile, "utf8"));
  if (old && old !== process.pid && pidAlive(old)) {
    console.error(`Another hub process (pid ${old}) is starting; exiting.`);
    process.exit(0);
  }
}
writeFileSync(paths.pidFile, String(process.pid));

let hub: Hub;
try {
  hub = new Hub(new Store());
} catch (e) {
  const msg = e instanceof ConfigError ? e.message : String((e as any)?.message ?? e);
  log.error(`cannot start: ${msg}`);
  console.error(msg);
  // Sleep before exiting so launchd's KeepAlive doesn't spin.
  await Bun.sleep(30_000);
  process.exit(1);
}

log.info(`hub ${VERSION} starting (provider ${hub.provider.id}, tunnel ${hub.cfg.tunnel.kind})`);
startInternalServer(hub);
startPublicServer(hub);
startBridgeSocket(hub);
hub.recoverAfterRestart();

let tunnel: QuickTunnel | null = null;
if (hub.cfg.tunnel.kind === "quick" && hub.provider.id !== "fake") {
  tunnel = new QuickTunnel(PUBLIC_PORT, (url) => void hub.configureWebhook(url), process.env.CCSMS_CLOUDFLARED || findCloudflared());
  tunnel.start();
} else if (hub.cfg.tunnel.kind === "url" && hub.cfg.tunnel.publicUrl) {
  void hub.configureWebhook(hub.cfg.tunnel.publicUrl.replace(/\/+$/, ""));
}

// Keep the computer awake while the hub runs (macOS), so texts keep flowing.
let caffeinate: ReturnType<typeof Bun.spawn> | null = null;
if (hub.cfg.system.keepAwake && platform() === "darwin") {
  try { caffeinate = Bun.spawn(["caffeinate", "-s", "-i", "-w", String(process.pid)], { stdout: "ignore", stderr: "ignore" }); } catch {}
}

async function shutdown(sig: string) {
  log.info(`stopping (${sig})`);
  tunnel?.stop();
  try { caffeinate?.kill(); } catch {}
  hub.stop();
  await Promise.race([hub.outbox.drain(), Bun.sleep(5000)]);
  try { unlinkSync(paths.pidFile); } catch {}
  try { unlinkSync(paths.socket); } catch {}
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

function findCloudflared(): string {
  for (const c of [Bun.which("cloudflared"), "/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared", "/usr/bin/cloudflared"]) {
    if (c && existsSync(c)) return c;
  }
  return "cloudflared";
}
