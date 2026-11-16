import type { Subprocess } from "bun";
import { logger } from "../shared/log.ts";

const log = logger("tunnel");

/**
 * Runs a Cloudflare quick tunnel (no account needed) to the hub's public port and reports the
 * https URL. Quick tunnel URLs change on every start, so the hub re-points the provider webhook
 * whenever a new URL appears. Restarts cloudflared with backoff if it exits.
 */
export class QuickTunnel {
  private proc: Subprocess | null = null;
  private stopped = false;
  private backoff = 2000;
  url: string | null = null;

  constructor(private port: number, private onUrl: (url: string) => void, private bin = "cloudflared") {}

  start() {
    this.stopped = false;
    this.spawn();
  }

  private spawn() {
    if (this.stopped) return;
    try {
      this.proc = Bun.spawn([this.bin, "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${this.port}`], {
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (e) {
      log.error("could not start cloudflared (is it installed? brew install cloudflared)", e);
      this.retry();
      return;
    }
    const scan = async (stream: ReadableStream<Uint8Array> | null) => {
      if (!stream) return;
      const dec = new TextDecoder();
      for await (const chunk of stream) {
        const text = dec.decode(chunk);
        const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m && m[0] !== this.url) {
          this.url = m[0];
          this.backoff = 2000;
          log.info(`public URL: ${this.url}`);
          try { this.onUrl(this.url); } catch (e) { log.error("onUrl failed", e); }
        }
      }
    };
    scan(this.proc.stderr as ReadableStream<Uint8Array>);
    scan(this.proc.stdout as ReadableStream<Uint8Array>);
    this.proc.exited.then((code) => {
      if (this.stopped) return;
      log.warn(`cloudflared exited (${code}); restarting`);
      this.url = null;
      this.retry();
    });
  }

  private retry() {
    if (this.stopped) return;
    setTimeout(() => this.spawn(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 60_000);
  }

  stop() {
    this.stopped = true;
    try { this.proc?.kill(); } catch {}
    this.proc = null;
  }
}
