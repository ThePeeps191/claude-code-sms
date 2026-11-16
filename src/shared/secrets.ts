import { existsSync, readFileSync, writeFileSync, chmodSync, renameSync } from "node:fs";
import { paths, ensureStateDir } from "./paths.ts";

/** Known secret keys. Values live only in ~/.claude-code-sms/secrets.env (mode 600). */
export const SECRET_KEYS = {
  telnyx: ["TELNYX_API_KEY", "TELNYX_PUBLIC_KEY"],
  twilio: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
  fake: [],
} as const;

export function loadSecrets(file = paths.secrets): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function saveSecrets(values: Record<string, string>, file = paths.secrets): void {
  ensureStateDir();
  const merged = { ...loadSecrets(file), ...values };
  const body =
    "# claude-code-sms secrets. Keep this file private (mode 600). Never commit or share it.\n" +
    Object.entries(merged)
      .filter(([, v]) => v !== "")
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") +
    "\n";
  const tmp = file + ".tmp";
  writeFileSync(tmp, body, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
