/**
 * Remove obvious secrets from outbound SMS text. SMS travels in plain text, so this is a
 * last line of defense, not a guarantee.
 */
const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_\-]{10,}/g,           // Anthropic
  /\bsk-[A-Za-z0-9_\-]{20,}/g,               // OpenAI-style
  /\bKEY[A-Za-z0-9_\-]{20,}/g,               // Telnyx v2 keys start with KEY
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,           // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9\-]{10,}/g,        // Slack
  /\bAKIA[0-9A-Z]{16}\b/g,                   // AWS access key id
  /\bAIza[0-9A-Za-z_\-]{30,}/g,              // Google API key
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g, // Stripe
  /\bSK[0-9a-fA-F]{32}\b/g,                  // Twilio API key SID
  /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}/g, // JWT
];

/** KEY=value / KEY: value lines where KEY looks secret. */
const ASSIGNMENT = /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|AUTH)[A-Z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi;

export function scrubSecrets(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, "[redacted]");
  out = out.replace(ASSIGNMENT, (_m, k) => `${k}=[redacted]`);
  return out;
}
