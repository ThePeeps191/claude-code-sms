import type { SmsProvider, InboundEvent, SendResult, WebhookRequest } from "./provider.ts";
import { segmentCount } from "../shared/gsm7.ts";

/**
 * A provider that sends nothing. Outbound texts are handed to `onSend` (the hub shows them in
 * `ccsms phone`); inbound texts arrive through the hub's internal /api/fake/inbound endpoint.
 */
export class FakeProvider implements SmsProvider {
  readonly id = "fake" as const;
  readonly capabilities = { failoverUrl: false, reportsCost: false };
  private n = 0;

  constructor(private onSend: (to: string, body: string, id: string) => void = () => {}) {}

  setOnSend(fn: (to: string, body: string, id: string) => void) { this.onSend = fn; }

  async validateCredentials() { return "fake provider (no real texts are sent)"; }
  async balance() { return null; }

  async send(to: string, body: string): Promise<SendResult> {
    const id = `fake-${Date.now()}-${++this.n}`;
    this.onSend(to, body, id);
    return { providerId: id, segments: segmentCount(body), cost: 0, currency: "USD", status: "delivered" };
  }

  async verifyAndParse(_req: WebhookRequest): Promise<InboundEvent[] | null> { return null; }
  webhookResponse() { return { body: "", contentType: "text/plain" }; }
  async listNumbers() { return [{ number: "+15550000000", id: "fake" }]; }
  async searchNumbers() { return []; }
  async buyNumber() {}
  async configureWebhook() { return {}; }
}
