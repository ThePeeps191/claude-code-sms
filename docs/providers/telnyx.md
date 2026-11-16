# Telnyx

Telnyx has low prices: roughly $0.004 per SMS segment plus carrier fees, and about $1 per month for a local number. Check [telnyx.com/pricing/messaging](https://telnyx.com/pricing/messaging) for current prices.

## 1. Account

1. Sign up at [telnyx.com](https://telnyx.com).
2. New accounts start at **Pretrial**. Go to **Account → Account Levels → Upgrade** and connect LinkedIn or GitHub, or verify your ID. That moves you to **Trial**, with $5 of test credit.
3. **Trial limits:**
   - You can order one local number in your account's country.
   - You can only text, and receive texts from, your **verified number**.
   - At most 100 messages a day.

   That's enough for claude-code-sms, which only ever texts you. The trial number is reclaimed after 30 days unless you upgrade to **Paid** (2FA, a service address, a verified mobile and a card payment). See [Telnyx account levels](https://developers.telnyx.com/docs/account-setup/levels-and-capabilities).
4. **Verify your own mobile:** go to **Voice Suite → Numbers → Verified Numbers → Verify Number**. Use SMS and leave **Extension** blank.

## 2. A number to text from

Either buy one in the portal (**Numbers → Buy Numbers**: pick your country, the **SMS** feature and an area code), or let `ccsms setup` search and buy one; it shows the price and asks first.

Use a **local number in the same country as your phone**. That's usually cheapest and needs no extra registration.

> **US numbers texting US phones** need A2P 10DLC registration (or a verified toll-free number), and that takes days. See Telnyx's 10DLC docs. Many other countries need no registration for domestic local numbers.

## 3. Credentials

Under **Account → Keys & Credentials** (or **API Keys**):
- **API Keys → Create API Key:** copy the key (it starts with `KEY`).
- **Public Key:** copy the base64 public key. It's used to verify that webhooks really come from Telnyx.

Then, in a terminal (input is hidden):

```bash
ccsms login telnyx
```

Never paste these keys into a chat.

## 4. Wiring

You don't need to set anything in the portal. When the hub starts (and whenever the quick-tunnel URL changes), it:
- creates or updates a messaging profile named `claude-code-sms` with the hub's webhook URL;
- assigns your number to that profile.

Its allowed destinations are your phone's country, or all countries for numbers outside the US and Canada.

## Notes

- **STOP and HELP:** Telnyx manages opt-out keywords on long codes. If you text `STOP`, Telnyx blocks texts to you until you text `START`.
- **Cost reporting:** costs appear in `ccsms status` / `cost` once Telnyx reports them (`message.finalized` events).
