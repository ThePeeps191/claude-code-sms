import { platform } from "node:os";

/** Seconds since the last keyboard/mouse input, or null if unknown on this platform. */
export function userIdleSeconds(): number | null {
  try {
    if (platform() === "darwin") {
      const p = Bun.spawnSync(["ioreg", "-c", "IOHIDSystem", "-d", "4"], { stdout: "pipe", timeout: 3000 });
      const m = p.stdout.toString().match(/"HIDIdleTime"\s*=\s*(\d+)/);
      return m ? Number(m[1]) / 1e9 : null;
    }
    if (platform() === "linux") {
      const p = Bun.spawnSync(["xprintidle"], { stdout: "pipe", stderr: "ignore", timeout: 3000 });
      if (p.exitCode === 0) return Number(p.stdout.toString().trim()) / 1000;
    }
  } catch {}
  return null;
}
