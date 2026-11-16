import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type SmsProvider, type InboundEvent, type SendResult, type OwnedNumber, type AvailableNumber,
  type WebhookRequest, ProviderError, readJson, parseAmount,
} from "./provider.ts";

const API = process.env.CCSMS_TWILIO_API_BASE || "https://api.twilio.com/2010-04-01";

/** Twilio's request signature: base64(HMAC-SHA1(authToken, url + sorted(k+v)...)). */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

export class TwilioProvider implements SmsProvider {
  readonly id = "twilio" as const;
  readonly capabilities = { failoverUrl: true, reportsCost: true };

  constructor(private accountSid: string, private authToken: string, private fromNumber: string) {}

  private async call(method: string, path: string, form?: Record<string, string>): Promise<any> {
    if (!this.accountSid || !this.authToken) throw new ProviderError("Twilio credentials are not set. Run: ccsms login twilio");
    const res = await fetch(`${API}/Accounts/${this.accountSid}${path}`, {
      method,
      headers: {
        Authorization: "Basic " + Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64"),
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        Accept: "application/json",
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const json = await readJson(res);
    if (!res.ok) {
      throw new ProviderError(`Twilio ${method} ${path} failed (${res.status}): ${json?.message ?? res.statusText}`, res.status, String(json?.code ?? ""));
    }
    return json;
  }

  async validateCredentials(): Promise<string> {
    const j = await this.call("GET", ".json");
    const b = await this.balance().catch(() => null);
    return `account ${j?.friendly_name ?? this.accountSid} (${j?.status ?? "unknown"})${b ? `, balance ${b.amount.toFixed(2)} ${b.currency}` : ""}`;
  }

  async balance() {
    const j = await this.call("GET", "/Balance.json");
    const amount = parseAmount(j?.balance);
    return amount === null ? null : { amount: Number(j.balance), currency: j.currency ?? "USD" };
  }

  async send(to: string, body: string, opts: { statusCallbackUrl?: string } = {}): Promise<SendResult> {
    const form: Record<string, string> = { To: to, From: this.fromNumber, Body: body };
    if (opts.statusCallbackUrl) form.StatusCallback = opts.statusCallbackUrl;
    const j = await this.call("POST", "/Messages.json", form);
    return {
      providerId: String(j.sid ?? ""),
      segments: j.num_segments ? Number(j.num_segments) : null,
      cost: parseAmount(j.price),
      currency: j.price_unit ?? null,
      status: j.status ?? "queued",
    };
  }

  async verifyAndParse(req: WebhookRequest): Promise<InboundEvent[] | null> {
    const sig = req.headers.get("x-twilio-signature");
    if (!sig || !this.authToken) return null;
    const params: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(req.rawBody)) params[k] = v;
    const expected = twilioSignature(this.authToken, req.publicUrl, params);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    if (params.MessageStatus && !params.Body && params.SmsStatus !== "received") {
      return [{
        kind: "status",
        eventId: `${params.MessageSid}:${params.MessageStatus}`,
        providerId: params.MessageSid ?? "",
        status: params.MessageStatus,
        cost: parseAmount(params.Price),
        currency: params.PriceUnit ?? null,
      }];
    }
    if (params.MessageSid && params.From) {
      return [{
        kind: "message",
        id: params.MessageSid,
        from: params.From,
        to: params.To ?? "",
        text: params.Body ?? "",
        mediaCount: Number(params.NumMedia ?? 0) || 0,
      }];
    }
    return [];
  }

  webhookResponse() {
    return { body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>', contentType: "text/xml" };
  }

  async listNumbers(): Promise<OwnedNumber[]> {
    const j = await this.call("GET", "/IncomingPhoneNumbers.json?PageSize=200");
    return (j?.incoming_phone_numbers ?? []).map((n: any) => ({ number: n.phone_number, id: n.sid }));
  }

  async searchNumbers(country: string, opts: { areaCode?: string; limit?: number } = {}): Promise<AvailableNumber[]> {
    const q = new URLSearchParams({ SmsEnabled: "true", PageSize: String(opts.limit ?? 10) });
    if (opts.areaCode) q.set("AreaCode", opts.areaCode);
    const j = await this.call("GET", `/AvailablePhoneNumbers/${country.toUpperCase()}/Local.json?${q}`);
    return (j?.available_phone_numbers ?? []).map((n: any) => ({
      number: n.phone_number,
      locality: n.locality ?? undefined,
      region: n.region ?? undefined,
    }));
  }

  async buyNumber(number: string): Promise<void> {
    await this.call("POST", "/IncomingPhoneNumbers.json", { PhoneNumber: number });
  }

  async configureWebhook(number: string, webhookUrl: string, opts: { failoverUrl?: string } = {}) {
    const owned = (await this.listNumbers()).find((n) => n.number === number);
    if (!owned) throw new ProviderError(`The number ${number} is not on this Twilio account.`);
    const form: Record<string, string> = { SmsUrl: webhookUrl, SmsMethod: "POST" };
    if (opts.failoverUrl) { form.SmsFallbackUrl = opts.failoverUrl; form.SmsFallbackMethod = "POST"; }
    await this.call("POST", `/IncomingPhoneNumbers/${owned.id}.json`, form);
    return {};
  }
}
