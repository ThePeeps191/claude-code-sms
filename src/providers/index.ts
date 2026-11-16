import type { Config } from "../shared/config.ts";
import { loadSecrets } from "../shared/secrets.ts";
import type { SmsProvider } from "./provider.ts";
import { TelnyxProvider } from "./telnyx.ts";
import { TwilioProvider } from "./twilio.ts";
import { FakeProvider } from "./fake.ts";

export function createProvider(cfg: Config, secrets = loadSecrets()): SmsProvider {
  switch (cfg.provider.name) {
    case "telnyx":
      return new TelnyxProvider(secrets.TELNYX_API_KEY ?? "", secrets.TELNYX_PUBLIC_KEY ?? "", cfg.provider.number);
    case "twilio":
      return new TwilioProvider(secrets.TWILIO_ACCOUNT_SID ?? "", secrets.TWILIO_AUTH_TOKEN ?? "", cfg.provider.number);
    default:
      return new FakeProvider();
  }
}

/** Country codes for a messaging profile's allowed destinations, derived from owner numbers. */
export function destinationsFor(numbers: string[]): string[] {
  const set = new Set<string>();
  for (const n of numbers) {
    if (n.startsWith("+1")) { set.add("US"); set.add("CA"); }
    else return ["*"]; // non-NANP: let the profile allow all; we only ever text owner numbers anyway
  }
  return set.size ? [...set] : ["*"];
}

export type { SmsProvider } from "./provider.ts";
