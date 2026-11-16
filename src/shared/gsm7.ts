/**
 * GSM-7 handling. One non-GSM character switches a whole SMS to UCS-2
 * (70 chars/segment instead of 160), so every outbound text is normalized first.
 */

const BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const EXTENDED = "^{}\\[~]|€\f";

const basicSet = new Set(BASIC);
const extSet = new Set(EXTENDED);

const REPLACEMENTS: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
  "«": '"', "»": '"',
  "–": "-", "—": "-", "―": "-", "−": "-", "‐": "-", "‑": "-",
  "…": "...",
  " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ",
  "​": "", "‌": "", "‍": "", "﻿": "",
  "•": "-", "·": "-", "●": "-", "◦": "-", "‣": "-",
  "→": "->", "←": "<-", "⇒": "=>", "↔": "<->",
  "✓": "ok", "✔": "ok", "✅": "ok", "✗": "x", "✘": "x", "❌": "x",
  "≤": "<=", "≥": ">=", "≠": "!=", "×": "x", "÷": "/",
  "©": "(c)", "®": "(R)", "™": "TM", "°": " deg",
  "\t": " ",
  "`": "'",
};

/** Convert text to GSM-7-safe text. Unmappable characters are dropped (after accent stripping). */
export function toGsm7(input: string): string {
  let out = "";
  for (const ch of input) {
    if (basicSet.has(ch) || extSet.has(ch)) { out += ch; continue; }
    const rep = REPLACEMENTS[ch];
    if (rep !== undefined) { out += rep; continue; }
    // Strip accents: é -> e (only if the result is GSM)
    const stripped = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (stripped.length === 1 && (basicSet.has(stripped) || extSet.has(stripped))) { out += stripped; continue; }
    // Anything else (emoji, CJK, symbols) is dropped.
  }
  return out.replace(/[ ]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function isGsm7(s: string): boolean {
  for (const ch of s) if (!basicSet.has(ch) && !extSet.has(ch)) return false;
  return true;
}

/** Length in GSM-7 septets (extended chars cost 2). */
export function gsmLength(s: string): number {
  let n = 0;
  for (const ch of s) n += extSet.has(ch) ? 2 : 1;
  return n;
}

/** Number of SMS segments the text will be billed as. */
export function segmentCount(s: string): number {
  if (!s) return 0;
  if (isGsm7(s)) {
    const len = gsmLength(s);
    return len <= 160 ? 1 : Math.ceil(len / 153);
  }
  const units = [...s].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
  return units <= 70 ? 1 : Math.ceil(units / 67);
}

/**
 * Split text into pages that each fit within `maxSegments` segments, breaking at
 * whitespace where possible. Used for "MORE" paging.
 */
export function paginate(s: string, maxSegments: number): string[] {
  const limit = maxSegments === 1 ? 160 : maxSegments * 153;
  const pageBudget = limit - 15; // room for " (MORE 10/12)"
  if (gsmLength(s) <= limit) return [s];
  const pages: string[] = [];
  let rest = s;
  while (gsmLength(rest) > pageBudget) {
    let cut = pageBudget;
    // map septet budget to char index
    let septets = 0, idx = 0;
    for (const ch of rest) {
      const w = extSet.has(ch) ? 2 : 1;
      if (septets + w > cut) break;
      septets += w; idx += ch.length;
    }
    let breakAt = rest.lastIndexOf(" ", idx);
    if (breakAt < idx * 0.6) breakAt = idx;
    pages.push(rest.slice(0, breakAt).trim());
    rest = rest.slice(breakAt).trim();
  }
  if (rest) pages.push(rest);
  return pages;
}
