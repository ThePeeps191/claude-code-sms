import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { parse, stringify } from "smol-toml";
import { paths, ensureStateDir } from "./paths.ts";
import { isE164 } from "./e164.ts";

export type ProviderName = "telnyx" | "twilio" | "fake";
export type TunnelKind = "quick" | "url" | "none";

export interface Config {
  owners: { numbers: string[]; notify: "primary" | "all" };
  provider: { name: ProviderName; number: string; messagingProfileId: string };
  tunnel: { kind: TunnelKind; publicUrl: string };
  router: { model: string };
  summarizer: { model: string };
  budget: { dailySegments: number };
  modes: {
    autoHome: boolean;
    autoAway: boolean;
    autoAwayMinutes: number;
    /** Seconds a session must stay idle after Stop before DONE is sent. */
    doneSettleSeconds: number;
    /** Minimum minutes between milestone updates from one session. */
    updateMinMinutes: number;
  };
  security: { unlockPin: string; unlockHours: number };
  spawn: { roots: string[]; max: number };
  log: { retentionDays: number };
  system: { keepAwake: boolean; claudePath: string };
}

export const DEFAULT_CONFIG: Config = {
  owners: { numbers: [], notify: "primary" },
  provider: { name: "fake", number: "", messagingProfileId: "" },
  tunnel: { kind: "quick", publicUrl: "" },
  router: { model: "sonnet" },
  summarizer: { model: "sonnet" },
  budget: { dailySegments: 30 },
  modes: { autoHome: true, autoAway: false, autoAwayMinutes: 20, doneSettleSeconds: 30, updateMinMinutes: 20 },
  security: { unlockPin: "", unlockHours: 12 },
  spawn: { roots: [], max: 4 },
  log: { retentionDays: 30 },
  system: { keepAwake: true, claudePath: "" },
};

function deepMerge<T>(base: T, over: any): T {
  if (over === undefined || over === null) return structuredClone(base);
  if (typeof base !== "object" || base === null || Array.isArray(base)) return over as T;
  const out: any = structuredClone(base);
  for (const k of Object.keys(over)) {
    if (k in out && typeof out[k] === "object" && out[k] !== null && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], over[k]);
    } else {
      out[k] = over[k];
    }
  }
  return out;
}

export function validateConfig(c: Config): string[] {
  const errs: string[] = [];
  if (!Array.isArray(c.owners.numbers)) errs.push("owners.numbers must be a list");
  else for (const n of c.owners.numbers) if (!isE164(n)) errs.push(`owners.numbers: "${n}" is not E.164 (like +15551234567)`);
  if (!["primary", "all"].includes(c.owners.notify)) errs.push('owners.notify must be "primary" or "all"');
  if (!["telnyx", "twilio", "fake"].includes(c.provider.name)) errs.push("provider.name must be telnyx, twilio or fake");
  if (c.provider.name !== "fake" && c.provider.number && !isE164(c.provider.number)) errs.push("provider.number must be E.164");
  if (!["quick", "url", "none"].includes(c.tunnel.kind)) errs.push("tunnel.kind must be quick, url or none");
  if (c.tunnel.kind === "url" && !/^https:\/\//.test(c.tunnel.publicUrl)) errs.push("tunnel.publicUrl must be an https:// URL when tunnel.kind = \"url\"");
  if (typeof c.router.model !== "string" || !c.router.model) errs.push("router.model must be a model alias or id");
  if (typeof c.summarizer.model !== "string" || !c.summarizer.model) errs.push("summarizer.model must be a model alias or id");
  if (!Number.isInteger(c.budget.dailySegments) || c.budget.dailySegments < 1) errs.push("budget.dailySegments must be a positive integer");
  if (!Number.isFinite(c.modes.autoAwayMinutes) || c.modes.autoAwayMinutes < 1) errs.push("modes.autoAwayMinutes must be >= 1");
  if (!Number.isFinite(c.modes.doneSettleSeconds) || c.modes.doneSettleSeconds < 0) errs.push("modes.doneSettleSeconds must be >= 0");
  if (c.security.unlockPin && !/^\d{4,12}$/.test(c.security.unlockPin)) errs.push("security.unlockPin must be 4-12 digits (or empty to disable)");
  if (!Array.isArray(c.spawn.roots)) errs.push("spawn.roots must be a list of folders");
  if (!Number.isInteger(c.spawn.max) || c.spawn.max < 0) errs.push("spawn.max must be >= 0");
  if (!Number.isInteger(c.log.retentionDays) || c.log.retentionDays < 1) errs.push("log.retentionDays must be >= 1");
  return errs;
}

export class ConfigError extends Error {
  constructor(public errors: string[]) {
    super("Invalid config:\n  - " + errors.join("\n  - "));
  }
}

export function loadConfig(file = paths.config): Config {
  if (!existsSync(file)) return structuredClone(DEFAULT_CONFIG);
  let raw: any;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch (e: any) {
    throw new ConfigError([`${file}: TOML syntax error: ${e?.message ?? e}`]);
  }
  const cfg = deepMerge(DEFAULT_CONFIG, raw);
  const errs = validateConfig(cfg);
  if (errs.length) throw new ConfigError(errs);
  return cfg;
}

const HEADER = `# claude-code-sms configuration. Edit freely; the hub reloads it automatically.
# Docs: https://github.com/ThePeeps191/claude-code-sms/blob/main/docs/DESIGN.md#13-configuration
`;

export function saveConfig(cfg: Config, file = paths.config): void {
  const errs = validateConfig(cfg);
  if (errs.length) throw new ConfigError(errs);
  ensureStateDir();
  const tmp = file + ".tmp";
  writeFileSync(tmp, HEADER + "\n" + stringify(cfg as any) + "\n");
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** Get/set a dotted key like "budget.dailySegments". Values are coerced from strings. */
export function getKey(cfg: Config, key: string): unknown {
  return key.split(".").reduce((o: any, k) => (o == null ? undefined : o[k]), cfg);
}

export function setKey(cfg: Config, key: string, value: string): Config {
  const parts = key.split(".");
  const out: any = structuredClone(cfg);
  let o = out;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof o[parts[i]] !== "object") throw new Error(`Unknown config key: ${key}`);
    o = o[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (!(last in o)) throw new Error(`Unknown config key: ${key}`);
  const cur = o[last];
  if (typeof cur === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
    o[last] = n;
  } else if (typeof cur === "boolean") {
    if (!/^(true|false|on|off|yes|no)$/i.test(value)) throw new Error(`${key} must be true or false`);
    o[last] = /^(true|on|yes)$/i.test(value);
  } else if (Array.isArray(cur)) {
    o[last] = value.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    o[last] = value;
  }
  return out as Config;
}
