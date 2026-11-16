import { createInterface } from "node:readline/promises";

const tty = process.stdout.isTTY;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = c("1");
export const dim = c("2");
export const green = c("32");
export const red = c("31");
export const yellow = c("33");
export const cyan = c("36");

export const ok = (s: string) => console.log(`${green("✓")} ${s}`);
export const bad = (s: string) => console.log(`${red("✗")} ${s}`);
export const warn = (s: string) => console.log(`${yellow("!")} ${s}`);
export const info = (s: string) => console.log(`${cyan("›")} ${s}`);
export const step = (n: number, total: number, s: string) => console.log(`\n${bold(`[${n}/${total}] ${s}`)}`);

let assumeYes = false;
export function setAssumeYes(v: boolean) { assumeYes = v; }
export function interactive(): boolean { return Boolean(process.stdin.isTTY) && !assumeYes; }

export async function ask(question: string, def = ""): Promise<string> {
  if (!interactive()) return def;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(`${question}${def ? dim(` [${def}]`) : ""}: `)).trim();
    return a || def;
  } finally { rl.close(); }
}

export async function confirm(question: string, def = true): Promise<boolean> {
  if (!interactive()) return def;
  const a = (await ask(`${question} ${dim(def ? "(Y/n)" : "(y/N)")}`, "")).toLowerCase();
  if (!a) return def;
  return a.startsWith("y");
}

export async function choose<T extends string>(question: string, options: { value: T; label: string }[], def: T): Promise<T> {
  if (!interactive()) return def;
  console.log(question);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}${o.value === def ? dim(" (default)") : ""}`));
  for (;;) {
    const a = await ask("Choose", String(options.findIndex((o) => o.value === def) + 1));
    const n = Number(a);
    if (n >= 1 && n <= options.length) return options[n - 1].value;
    const byVal = options.find((o) => o.value === a);
    if (byVal) return byVal.value;
  }
}

/** Read a secret without echoing it. */
export async function askSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // Allow piping: echo "$KEY" | ccsms login telnyx
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) { rl.close(); return line.trim(); }
    return "";
  }
  process.stdout.write(`${question}: `);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return await new Promise<string>((resolve) => {
    let buf = "";
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") { done(); return; }
        if (c === "\u0003") { stdin.setRawMode(false); process.stdout.write("\n"); process.exit(130); }
        if (c === "\u007f" || c === "\b") { if (buf.length) { buf = buf.slice(0, -1); } continue; }
        buf += c;
      }
    };
    const done = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write(buf ? dim(` (${buf.length} chars)`) + "\n" : "\n");
      resolve(buf.trim());
    };
    stdin.on("data", onData);
  });
}
