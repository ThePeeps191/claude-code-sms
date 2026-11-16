import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { toGsm7, isGsm7, segmentCount, paginate, gsmLength } from "../src/shared/gsm7.ts";
import { normalizeE164, isE164, maskNumber } from "../src/shared/e164.ts";
import { scrubSecrets } from "../src/shared/scrub.ts";
import { parseCommand } from "../src/hub/commands.ts";
import { DEFAULT_CONFIG, validateConfig, setKey } from "../src/shared/config.ts";
import { stripMarkdown, firstParagraph, describeTool, parseClockTime } from "../src/hub/text.ts";
import { TelnyxProvider } from "../src/providers/telnyx.ts";
import { TwilioProvider, twilioSignature } from "../src/providers/twilio.ts";
import { decisionToAction } from "../src/hub/router.ts";
import { destinationsFor } from "../src/providers/index.ts";

describe("gsm7", () => {
  test("normalizes smart punctuation and drops emoji", () => {
    const out = toGsm7("It’s done — tests pass… ✅ 🎉 “nice”");
    expect(out).toBe(`It's done - tests pass... ok "nice"`);
    expect(isGsm7(out)).toBe(true);
  });
  test("strips accents it can't encode but keeps GSM accents", () => {
    expect(toGsm7("café ñ ô")).toBe("café ñ o");
  });
  test("segment counting", () => {
    expect(segmentCount("a".repeat(160))).toBe(1);
    expect(segmentCount("a".repeat(161))).toBe(2);
    expect(segmentCount("a".repeat(306))).toBe(2);
    expect(segmentCount("a".repeat(307))).toBe(3);
    expect(segmentCount("é".repeat(10) + "✓")).toBe(1); // UCS-2, short
    expect(segmentCount("✓" + "a".repeat(70))).toBe(2);
    expect(gsmLength("[]")).toBe(4);
  });
  test("paginate keeps pages within budget", () => {
    const text = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
    const pages = paginate(text, 1);
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) expect(gsmLength(p)).toBeLessThanOrEqual(148);
    expect(pages.join(" ")).toBe(text);
  });
});

describe("e164", () => {
  test("normalizes common inputs", () => {
    expect(normalizeE164("(403) 555-0123")).toBe("+14035550123");
    expect(normalizeE164("1-403-555-0123")).toBe("+14035550123");
    expect(normalizeE164("+44 7700 900123")).toBe("+447700900123");
    expect(normalizeE164("0044 7700 900123")).toBe("+447700900123");
    expect(normalizeE164("12345")).toBeNull();
    expect(isE164("+14035550123")).toBe(true);
    expect(maskNumber("+14035550123")).toBe("...0123");
  });
});

describe("scrub", () => {
  test("redacts secrets", () => {
    const s = scrubSecrets("key sk-ant-abcdefghijklmnop123 and GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaa and AKIAABCDEFGHIJKLMNOP ok");
    expect(s).not.toContain("sk-ant-abc");
    expect(s).not.toContain("ghp_aaa");
    expect(s).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(s).toContain("ok");
  });
  test("leaves normal text alone", () => {
    expect(scrubSecrets("Tests pass: 41/41. Deployed v2.")).toBe("Tests pass: 41/41. Deployed v2.");
  });
});

describe("commands", () => {
  const ctx = { pendingChoice: false, pendingConfirm: false };
  test("basic commands", () => {
    expect(parseCommand("Status", ctx)).toEqual({ type: "status" });
    expect(parseCommand("?", ctx)).toEqual({ type: "help" });
    expect(parseCommand("away", ctx)).toEqual({ type: "mode", mode: "away" });
    expect(parseCommand("quiet until 3pm", ctx)).toEqual({ type: "mode", mode: "paused", until: "3pm" });
    expect(parseCommand("halt webapp", ctx)).toEqual({ type: "halt", target: { name: "webapp" } });
    expect(parseCommand("model haiku", ctx)).toEqual({ type: "model", which: "both", model: "haiku" });
    expect(parseCommand("model router opus", ctx)).toEqual({ type: "model", which: "router", model: "opus" });
    expect(parseCommand("prompt for 2", ctx)).toEqual({ type: "capture_start", target: { num: 2 } });
  });
  test("addressing", () => {
    expect(parseCommand("@webapp add tests please", ctx)).toEqual({ type: "deliver", target: { name: "webapp" }, text: "add tests please", kind: "prompt" });
    expect(parseCommand("2: fix the build", ctx)).toEqual({ type: "deliver", target: { num: 2 }, text: "fix the build", kind: "prompt" });
  });
  test("bare leading number does not route", () => {
    expect(parseCommand("3 tests fail, fix them", ctx)).toBeNull();
  });
  test("bare digit only when a choice is pending", () => {
    expect(parseCommand("2", ctx)).toBeNull();
    expect(parseCommand("2", { ...ctx, pendingChoice: true })).toEqual({ type: "choice", n: 2 });
    expect(parseCommand("y", { ...ctx, pendingConfirm: true })).toEqual({ type: "confirm", yes: true });
  });
  test("never uses carrier keywords", () => {
    for (const w of ["stop", "cancel", "end", "quit", "help", "start", "unsubscribe"]) expect(parseCommand(w, ctx)).toBeNull();
  });
  test("spawn", () => {
    expect(parseCommand("new homework wt: write the essay outline", ctx)).toEqual({ type: "spawn", dir: "homework", worktree: true, prompt: "write the essay outline" });
  });
});

describe("config", () => {
  test("defaults are valid", () => expect(validateConfig(structuredClone(DEFAULT_CONFIG))).toEqual([]));
  test("catches bad values", () => {
    const c = structuredClone(DEFAULT_CONFIG);
    c.owners.numbers = ["555"];
    c.security.unlockPin = "12";
    expect(validateConfig(c).length).toBe(2);
  });
  test("setKey coerces", () => {
    const c = setKey(DEFAULT_CONFIG, "budget.dailySegments", "50");
    expect(c.budget.dailySegments).toBe(50);
    expect(setKey(DEFAULT_CONFIG, "modes.autoAway", "on").modes.autoAway).toBe(true);
    expect(setKey(DEFAULT_CONFIG, "spawn.roots", "~/a, ~/b").spawn.roots).toEqual(["~/a", "~/b"]);
    expect(() => setKey(DEFAULT_CONFIG, "nope.x", "1")).toThrow();
  });
});

describe("text", () => {
  test("strips markdown and takes the first paragraph", () => {
    const md = "**Done.** Added `checkout.ts` and [docs](http://x).\n\n## Details\n- a\n- b";
    expect(firstParagraph(stripMarkdown(md))).toBe("Done. Added checkout.ts and docs.");
  });
  test("tool descriptions", () => {
    expect(describeTool("Edit", { file_path: "/a/b/c.ts" })).toBe("editing c.ts");
    expect(describeTool("TodoWrite", { todos: [{ status: "completed" }, { status: "pending" }] })).toBe("todo 1/2");
  });
  test("clock parsing", () => {
    const now = new Date(2026, 10, 15, 10, 0);
    expect(parseClockTime("3pm", now)!.getHours()).toBe(15);
    expect(parseClockTime("9:30", now)!.getMinutes()).toBe(30);
    expect(parseClockTime("8am", now)!.getDate()).toBe(16);
    expect(parseClockTime("25", now)).toBeNull();
  });
});

describe("router mapping", () => {
  test("deliver keeps the original text verbatim", () => {
    expect(decisionToAction({ action: "deliver", target: 2, kind: "answer", reply: "rewritten!" }, "use cleaned")).toEqual({
      type: "deliver", target: { num: 2 }, text: "use cleaned", kind: "answer", inferred: undefined,
    });
  });
  test("clarify carries the text for a follow-up choice", () => {
    const a = decisionToAction({ action: "clarify", reply: "Which? 1 a 2 b" }, "do it") as any;
    expect(a.type).toBe("reply");
    expect(a.clarifyText).toBe("do it");
  });
  test("quiet maps to paused with until", () => {
    expect(decisionToAction({ action: "set_mode", mode: "quiet", until: "3pm" }, "x")).toEqual({ type: "mode", mode: "paused", until: "3pm" });
  });
});

describe("providers", () => {
  test("destinations", () => {
    expect(destinationsFor(["+14035550123"]).sort()).toEqual(["CA", "US"]);
    expect(destinationsFor(["+447700900123"])).toEqual(["*"]);
  });

  test("telnyx verifies ed25519 signatures (raw 32-byte key) and parses message.received", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64");
    const p = new TelnyxProvider("KEYtest", raw, "+15550001111");
    const body = JSON.stringify({ data: { event_type: "message.received", id: "evt1", payload: { id: "m1", text: "hi", from: { phone_number: "+15550002222" }, to: [{ phone_number: "+15550001111" }] } } });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign(null, Buffer.from(`${ts}|${body}`), privateKey).toString("base64");
    const headers = new Headers({ "telnyx-signature-ed25519": sig, "telnyx-timestamp": ts });
    const evs = await p.verifyAndParse({ headers, rawBody: body, publicUrl: "" });
    expect(evs).toEqual([{ kind: "message", id: "evt1", from: "+15550002222", to: "+15550001111", text: "hi", mediaCount: 0 }]);
    // Tampered body fails
    expect(await p.verifyAndParse({ headers, rawBody: body.replace("hi", "rm -rf"), publicUrl: "" })).toBeNull();
    // Stale timestamp fails
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    const sigOld = sign(null, Buffer.from(`${old}|${body}`), privateKey).toString("base64");
    expect(await p.verifyAndParse({ headers: new Headers({ "telnyx-signature-ed25519": sigOld, "telnyx-timestamp": old }), rawBody: body, publicUrl: "" })).toBeNull();
  });

  test("telnyx accepts SPKI-encoded keys and parses finalized cost", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const p = new TelnyxProvider("KEYtest", spki, "+15550001111");
    const body = JSON.stringify({ data: { event_type: "message.finalized", id: "evt2", payload: { id: "out1", cost: { amount: "0.0040", currency: "USD" }, to: [{ status: "delivered" }] } } });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign(null, Buffer.from(`${ts}|${body}`), privateKey).toString("base64");
    const evs = await p.verifyAndParse({ headers: new Headers({ "telnyx-signature-ed25519": sig, "telnyx-timestamp": ts }), rawBody: body, publicUrl: "" });
    expect(evs).toEqual([{ kind: "status", eventId: "evt2", providerId: "out1", status: "delivered", cost: 0.004, currency: "USD" }]);
  });

  test("twilio verifies X-Twilio-Signature", async () => {
    const p = new TwilioProvider("AC123", "secret-token", "+15550001111");
    const url = "https://example.trycloudflare.com/sms/twilio";
    const params = { MessageSid: "SM1", From: "+15550002222", To: "+15550001111", Body: "hello there", NumMedia: "0" };
    const rawBody = new URLSearchParams(params).toString();
    const sig = twilioSignature("secret-token", url, params);
    const evs = await p.verifyAndParse({ headers: new Headers({ "x-twilio-signature": sig }), rawBody, publicUrl: url });
    expect(evs).toEqual([{ kind: "message", id: "SM1", from: "+15550002222", to: "+15550001111", text: "hello there", mediaCount: 0 }]);
    expect(await p.verifyAndParse({ headers: new Headers({ "x-twilio-signature": sig }), rawBody: rawBody + "&x=1", publicUrl: url })).toBeNull();
    expect(await p.verifyAndParse({ headers: new Headers({ "x-twilio-signature": sig }), rawBody, publicUrl: url + "x" })).toBeNull();
  });

  test("twilio signature matches the documented example", () => {
    // From Twilio's security docs (classic example).
    const sig = twilioSignature("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", {
      CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212",
    });
    expect(sig).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
  });
});
