# Twilio

## 1. Account

- **Sign up:** at [twilio.com](https://www.twilio.com) and **upgrade to a paid account**. Trial accounts can only send pre-defined template messages, so they don't work for this. The first payment is typically about US$20 of prepaid credit.
- **Prices:** about $0.0083 per segment plus carrier fees, and about $1.15 per month for a local number in the US. Check [twilio.com/sms/pricing](https://www.twilio.com/en-us/sms/pricing/us).

## 2. A number to text from

Buy a number with SMS capability in the Console, or let `ccsms setup` search and buy one (it shows the result and asks first).

Registration depends on the number's country and the recipient's:
- **US:** A2P 10DLC registration (local numbers) or toll-free verification is required before texts deliver to US phones. It takes days, so start early. The Sole Proprietor option is for individuals without a business tax ID.
- **Canada:** Canadian local numbers texting Canadian phones are listed as supported without registration, though carriers filter automated traffic. Check [Twilio's Canada guidelines](https://www.twilio.com/en-us/guidelines/ca/sms).
- **Other countries:** see Twilio's [country guidelines](https://www.twilio.com/en-us/guidelines).

## 3. Credentials

From the Console's **Account info**: copy the **Account SID** (starts with `AC`) and the **Auth Token**. Then:

```bash
ccsms login twilio
```

## 4. Wiring

This is automatic. The hub sets your number's **A message comes in** webhook to the hub's public URL, and updates it whenever the quick-tunnel URL changes. Twilio signs every webhook (`X-Twilio-Signature`), and the hub rejects unsigned or altered requests.

## Notes

- **Opt-out keywords:** Twilio handles `STOP`, `UNSUBSCRIBE`, `CANCEL`, `END` and `QUIT` (opt out) and `START` (opt back in). claude-code-sms never uses these words as commands.
- **Prices:** Twilio reports each message's price in its status callbacks, and they show up in `cost`.
