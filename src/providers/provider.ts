export interface InboundMessage {
  kind: "message";
  /** Provider event/message id, used for de-duplication. */
  id: string;
  from: string;
  to: string;
  text: string;
  mediaCount: number;
}

export interface StatusEvent {
  kind: "status";
  /** Provider id of the outbound message this status refers to. */
  providerId: string;
  status: string;
  cost: number | null;
  currency: string | null;
  eventId?: string;
}

export type InboundEvent = InboundMessage | StatusEvent;

export interface SendResult {
  providerId: string;
  segments: number | null;
  cost: number | null;
  currency: string | null;
  status: string;
}

export interface OwnedNumber {
  number: string;
  id: string;
  messagingProfileId?: string | null;
}

export interface AvailableNumber {
  number: string;
  locality?: string;
  region?: string;
  upfront?: string;
  monthly?: string;
  currency?: string;
}

export interface WebhookRequest {
  headers: Headers;
  rawBody: string;
  /** The public URL the provider called (needed by Twilio's signature scheme). */
  publicUrl: string;
}

export interface SmsProvider {
  readonly id: "telnyx" | "twilio" | "fake";
  readonly capabilities: { failoverUrl: boolean; reportsCost: boolean };
  /** Throws a readable error if credentials are wrong. Returns a short account summary. */
  validateCredentials(): Promise<string>;
  send(to: string, body: string, opts?: { statusCallbackUrl?: string }): Promise<SendResult>;
  /** Returns null when the signature is invalid. May return several events (or none). */
  verifyAndParse(req: WebhookRequest): Promise<InboundEvent[] | null>;
  /** What to answer the webhook with. */
  webhookResponse(): { body: string; contentType: string };
  listNumbers(): Promise<OwnedNumber[]>;
  searchNumbers(country: string, opts?: { areaCode?: string; limit?: number }): Promise<AvailableNumber[]>;
  buyNumber(number: string): Promise<void>;
  /**
   * Point `number` at `webhookUrl` (inbound + status). Returns provider-specific
   * settings to persist (e.g. a messaging profile id).
   */
  configureWebhook(number: string, webhookUrl: string, opts: { failoverUrl?: string; destinations?: string[]; profileId?: string }): Promise<Record<string, string>>;
  balance(): Promise<{ amount: number; currency: string } | null>;
}

export class ProviderError extends Error {
  constructor(message: string, public status?: number, public code?: string) {
    super(message);
  }
}

export async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

export function parseAmount(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? Math.abs(n) : null;
}
