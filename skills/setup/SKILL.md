---
name: setup
description: Set up, check or troubleshoot claude-code-sms (texting Claude Code sessions by SMS). Use when the user asks to install, configure, set up, fix or debug claude-code-sms, SMS texts not arriving, the hub, the tunnel, Telnyx/Twilio wiring, or "why didn't I get a text".
---

# claude-code-sms setup guide

You are helping the user set up or troubleshoot claude-code-sms. The `ccsms` command does the work; your job is to run the non-secret steps, explain what's happening in plain words, and hand off anything involving secrets.

## Rules

- **Never ask for, accept, or type credentials** (API keys, auth tokens, public keys). If the user pastes one into the chat, tell them to rotate it in their provider's portal. Credentials are entered only by the user, in their own terminal: `ccsms login telnyx` or `ccsms login twilio` (hidden input).
- **Never buy a phone number** without the user explicitly confirming the number and price. Prefer letting `ccsms setup` (interactive) do it.
- Don't change Claude Code permission settings. claude-code-sms never needs that.

## Where to find ccsms

Inside Claude Code sessions `ccsms` is on the Bash PATH (plugin `bin/`). In the user's own terminal it's `~/.local/bin/ccsms` after setup.

## Fresh setup

1. `ccsms doctor`: see what's missing.
2. Explain the choices briefly: provider (Telnyx is cheapest; Twilio is well known; `fake` tries everything with no texts), their own phone number(s) (only those can control it), the number texts come from, and the tunnel (default needs no account).
3. Credentials: ask the user to run `ccsms login <provider>` in a terminal (in Claude Code they can type `! ccsms login telnyx`, but a separate terminal keeps the key out of the transcript entirely).
4. Run setup non-interactively once credentials exist, for example:
   `ccsms setup --provider telnyx --owner +15551234567 --number +15557654321 --tunnel quick --yes`
   Use `--skip-test` if the user isn't near their phone. Without `--number`, setup needs to be interactive to choose or buy one.
5. Round trip: setup texts the user "Reply OK"; ask them to reply. Or run `ccsms test`.
6. Tell them the three things: start sessions with `claude-sms`; text `away` when leaving; text `?` for commands; never text just STOP (carrier unsubscribe; START undoes it).

## Troubleshooting

Start with `ccsms doctor` (prints a fix per problem), then `ccsms status`, then `ccsms logs` (Ctrl-C to stop; or `tail -n 80 ~/.claude-code-sms/logs/hub.log`).

| Symptom | Check |
|---|---|
| No texts at all | Mode is `home`? (`ccsms status`). Session muted? Budget used up? `lastSendError` in status. Trial accounts may only text verified numbers. |
| No "done" text | DONE is sent only in `away` mode (or for watched sessions), after the session stays idle ~30s with no background tasks. |
| Texts in don't reach a session | Session must be started with `claude-sms` (shows "texts in+out" in `ccsms status`). Webhook OK in doctor? Sender number must be in `owners.numbers`. |
| Webhook errors | Credentials (`ccsms login`), number on the account, tunnel running (`cloudflared` installed for quick tunnels). `ccsms restart` re-registers. |
| User texted STOP | Provider blocked texts to them: they text START to the hub number, then `ccsms unlock`. |

Config lives in `~/.claude-code-sms/config.toml` (`ccsms config set <key> <value>`). Full design: docs/DESIGN.md in the plugin.
