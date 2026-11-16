# Setup

The one-liner in the README does all of this for you. This page explains each step, for manual installs and for when something needs fixing.

## 0. Before you start

- **macOS or Linux** with [Claude Code](https://claude.com/claude-code) installed and logged in.
- **An SMS provider account with a number:** [Telnyx](providers/telnyx.md) or [Twilio](providers/twilio.md). Use a local number in the same country as your phone.
- **This computer should stay on while you're away.** Setup keeps it from sleeping while the hub runs (macOS).

## 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/ThePeeps191/claude-code-sms/main/install.sh | bash
```

Manual equivalent:

```bash
claude plugin install sms --marketplace ThePeeps191/claude-code-sms
# then, from the plugin folder shown by: claude plugin list --json  ("installPath")
bun install && bun src/cli/main.ts install      # links ccsms + claude-sms into ~/.local/bin
```

Make sure `~/.local/bin` is on your `PATH`.

## 2. Credentials

```bash
ccsms login telnyx     # or: ccsms login twilio
```

Input is hidden. Values are checked against the provider's API, then saved to `~/.claude-code-sms/secrets.env` (mode 600).

## 3. Setup wizard

```bash
ccsms setup
```

The wizard walks through these steps, and you can re-run it any time:
1. **Provider:** Telnyx, Twilio, or `fake` to try everything locally with no texts.
2. **Your phone number(s):** only these numbers can control the hub. The first is the primary, which gets texts nobody asked for.
3. **The number texts come from:** pick one on your account, or search and buy one (it shows the price and asks first).
4. **Tunnel:**
   - *quick* (default): a free Cloudflare quick tunnel that needs no account. Its URL changes on restart, and the hub re-registers the webhook automatically. Needs `cloudflared`; the wizard offers `brew install cloudflared`.
   - *url*: your own stable `https://` URL that forwards to `http://127.0.0.1:47914`, for example:
     - ngrok static domain: `ngrok http --url=<your-domain> 47914`
     - Tailscale Funnel: `tailscale funnel 47914`
     - Cloudflare named tunnel: `cloudflared tunnel run` with an ingress to `http://127.0.0.1:47914`
5. **Options:**
   - daily text budget;
   - optional unlock PIN;
   - folders where texts may start new sessions.
6. **Service:** a launchd agent (macOS) or systemd user service (Linux) that starts the hub at login.
7. **Test:** the hub texts you "Reply OK" and waits for your reply.

Non-interactive (for scripts or when Claude drives it):

```bash
ccsms setup --provider telnyx --owner +15551234567 --number +15557654321 --tunnel quick --yes [--skip-test]
```

## 4. Daily use

```bash
claude-sms                 # instead of `claude`, in any project
```

- **Away:** text `away` when you leave (or run `ccsms away`).
- **Back:** text `home`, or just use the computer (auto-home).
- **Help:** text `?` for commands.

## Ports and files

| What | Where |
|---|---|
| Hooks + local API | `127.0.0.1:47913` (fixed; the plugin's hooks point here) |
| Provider webhooks (tunnel target) | `127.0.0.1:47914` |
| Bridge socket | `~/.claude-code-sms/hub.sock` |
| Config | `~/.claude-code-sms/config.toml` |
| Secrets | `~/.claude-code-sms/secrets.env` |
| Database / logs | `~/.claude-code-sms/hub.db`, `~/.claude-code-sms/logs/` |

To use other ports, set `CCSMS_INTERNAL_PORT` and `CCSMS_PUBLIC_PORT`. The hooks file assumes 47913, so changing that port also means editing `hooks/hooks.json`.
