import { createPublicKey, verify } from "node:crypto";
import {
  type SmsProvider, type InboundEvent, type SendResult, type OwnedNumber, type AvailableNumber,
  type WebhookRequest, ProviderError, readJson, parseAmount,
} from "./provider.ts";

const API = process.env.CCSMS_TELNYX_API_BASE || "https://api.telnyx.com/v2";
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MAX_SKEW_SECONDS = 300;

export class TelnyxProvider implements SmsProvider {
  readonly id = "telnyx" as const;
  readonly capabilities = { failoverUrl: true, reportsCost: true };

  constructor(private apiKey: string, private publicKeyB64: string, private fromNumber: string) {}

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    if (!this.apiKey) throw new ProviderError("Telnyx API key is not set. Run: ccsms login telnyx");
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const json = await readJson(res);
    if (!res.ok) {
      const e = json?.errors?.[0];
      const detail = e ? `${e.title ?? ""}${e.detail ? `: ${e.detail}` : ""}` : (json?.raw ?? res.statusText);
      throw new ProviderError(`Telnyx ${method} ${path} failed (${res.status}): ${detail}`.trim(), res.status, e?.code);
    }
    return json;
  }

  async validateCredentials(): Promise<string> {
    const b = await this.balance();
    return b ? `balance ${b.amount.toFixed(2)} ${b.currency}` : "credentials ok";
  }

  async balance() {
    const j = await this.call("GET", "/balance");
    const d = j?.data ?? {};
    const amount = parseAmount(d.available_credit ?? d.balance);
    return amount === null ? null : { amount: Number(d.available_credit ?? d.balance), currency: d.currency ?? "USD" };
  }

  async send(to: string, body: string): Promise<SendResult> {
    const j = await this.call("POST", "/messages", { from: this.fromNumber, to, text: body });
    const d = j?.data ?? {};
    return {
      providerId: String(d.id ?? ""),
      segments: typeof d.parts === "number" ? d.parts : null,
      cost: parseAmount(d.cost?.amount),
      currency: d.cost?.currency ?? null,
      status: d.to?.[0]?.status ?? "queued",
    };
  }

  private publicKey() {
    const raw = Buffer.from(this.publicKeyB64.trim(), "base64");
    const der = raw.length === 32 ? Buffer.concat([SPKI_ED25519_PREFIX, raw]) : raw;
    return createPublicKey({ key: der, format: "der", type: "spki" });
  }

  async verifyAndParse(req: WebhookRequest): Promise<InboundEvent[] | null> {
    const sig = req.headers.get("telnyx-signature-ed25519");
    const ts = req.headers.get("telnyx-timestamp");
    if (!sig || !ts || !this.publicKeyB64) return null;
    const age = Math.abs(Date.now() / 1000 - Number(ts));
    if (!Number.isFinite(age) || age > MAX_SKEW_SECONDS) return null;
    let ok = false;
    try {
      ok = verify(null, Buffer.from(`${ts}|${req.rawBody}`), this.publicKey(), Buffer.from(sig, "base64"));
    } catch {
      ok = false;
    }
    if (!ok) return null;
    let body: any;
    try { body = JSON.parse(req.rawBody); } catch { return []; }
    const data = body?.data;
    if (!data) return [];
    const p = data.payload ?? {};
    const eventId = String(data.id ?? p.id ?? "");
    switch (data.event_type) {
      case "message.received":
        return [{
          kind: "message",
          id: eventId || String(p.id),
          from: p.from?.phone_number ?? "",
          to: p.to?.[0]?.phone_number ?? "",
          text: typeof p.text === "string" ? p.text : "",
          mediaCount: Array.isArray(p.media) ? p.media.length : 0,
        }];
      case "message.sent":
      case "message.finalized":
        return [{
          kind: "status",
          eventId,
          providerId: String(p.id ?? ""),
          status: p.to?.[0]?.status ?? data.event_type,
          cost: parseAmount(p.cost?.amount),
          currency: p.cost?.currency ?? null,
        }];
      default:
        return [];
    }
  }

  webhookResponse() { return { body: "", contentType: "text/plain" }; }

  async listNumbers(): Promise<OwnedNumber[]> {
    const j = await this.call("GET", "/phone_numbers?page[size]=250");
    return (j?.data ?? []).map((n: any) => ({
      number: n.phone_number,
      id: String(n.id),
      messagingProfileId: n.messaging_profile_id ?? null,
    }));
  }

  async searchNumbers(country: string, opts: { areaCode?: string; limit?: number } = {}): Promise<AvailableNumber[]> {
    const q = new URLSearchParams();
    q.set("filter[country_code]", country.toUpperCase());
    q.append("filter[features][]", "sms");
    q.set("filter[phone_number_type]", "local");
    q.set("filter[limit]", String(opts.limit ?? 10));
    if (opts.areaCode) q.set("filter[national_destination_code]", opts.areaCode);
    const j = await this.call("GET", `/available_phone_numbers?${q.toString()}`);
    return (j?.data ?? []).map((n: any) => {
      const region = (n.region_information ?? []) as any[];
      return {
        number: n.phone_number,
        locality: region.find((r) => r.region_type === "rate_center" || r.region_type === "location")?.region_name,
        region: region.find((r) => r.region_type === "state")?.region_name,
        upfront: n.cost_information?.upfront_cost,
        monthly: n.cost_information?.monthly_cost,
        currency: n.cost_information?.currency,
      };
    });
  }

  async buyNumber(number: string): Promise<void> {
    await this.call("POST", "/number_orders", { phone_numbers: [{ phone_number: number }] });
  }

  async configureWebhook(number: string, webhookUrl: string, opts: { failoverUrl?: string; destinations?: string[]; profileId?: string } = {}) {
    const numbers = await this.listNumbers();
    const owned = numbers.find((n) => n.number === number);
    if (!owned) throw new ProviderError(`The number ${number} is not on this Telnyx account.`);
    // Only ever modify our own dedicated profile; never repoint a profile the user may share.
    let profileId = opts.profileId || "";
    const profileBody: Record<string, unknown> = {
      webhook_url: webhookUrl,
      webhook_api_version: "2",
      enabled: true,
      ...(opts.failoverUrl ? { webhook_failover_url: opts.failoverUrl } : {}),
    };
    if (profileId) {
      try {
        await this.call("PATCH", `/messaging_profiles/${profileId}`, profileBody);
      } catch (e: any) {
        if (e instanceof ProviderError && e.status === 404) profileId = "";
        else throw e;
      }
    }
    if (!profileId) {
      const j = await this.call("POST", "/messaging_profiles", {
        name: "claude-code-sms",
        whitelisted_destinations: opts.destinations?.length ? opts.destinations : ["*"],
        ...profileBody,
      });
      profileId = String(j?.data?.id ?? "");
      if (!profileId) throw new ProviderError("Telnyx did not return a messaging profile id.");
    }
    if (owned.messagingProfileId !== profileId) {
      await this.call("PATCH", `/phone_numbers/${owned.id}/messaging`, { messaging_profile_id: profileId });
    }
    return { messagingProfileId: profileId };
  }
}
