# claude-code-sms

**Text your Claude Code sessions.** Leave Claude working, walk away, and keep going from any phone with plain SMS: get a text when a session finishes or needs you, and text back the next prompt, an answer, or a question.

```
you:  away
hub:  Away: I'll text when sessions finish, fail or need you.
...
hub:  webapp: DONE 14m. Checkout page added, tests pass. Needs STRIPE_SECRET in .env. Reply to continue.
you:  nice. now add a test for the refund flow
...
hub:  ml-hw: Q: Fig 2 from 1 cleaned data 2 raw data
you:  1
...
you:  what's running?
hub:  webapp is busy (6m) editing refund.test.ts. ml-hw is idle: figure 2 done.
```

- **Texts out only when they matter:** finished, stuck, broken, or something you asked for. A daily budget caps cost.
- **Texts in, understood:** a Claude dispatcher works out which session you mean. You can send a long prompt over several texts, answer questions with a number, or say "send it to webapp instead".
- **Many sessions:** route by name (`@webapp ...`), number (`2: ...`), or just context.
- **Only you:** it acts only on texts from the phone numbers you configure.
- **Runs on your Claude subscription:** the dispatcher is headless Claude Code (`claude -p`), using your normal login.
- **Bring your own SMS provider:** Telnyx or Twilio today; the provider layer is pluggable.
- **Never touches permissions:** sessions keep whatever permission mode you run them in.

## Install

Requirements:
- macOS or Linux
- [Claude Code](https://claude.com/claude-code)
- an SMS provider account: [Telnyx](docs/providers/telnyx.md) (cheapest) or [Twilio](docs/providers/twilio.md)

```bash
curl -fsSL https://raw.githubusercontent.com/ThePeeps191/claude-code-sms/main/install.sh | bash
```

The installer asks before installing [Bun](https://bun.sh) or tmux if they're missing. It then installs the Claude Code plugin and the `ccsms` / `claude-sms` commands, and runs the setup wizard. The wizard covers:
- provider credentials (entered at a hidden prompt);
- your phone number(s);
- the number texts come from;
- a tunnel (no account needed);
- a background service;
- a test text you reply to.

**Prefer to let Claude do it?** Paste this into Claude Code:

> Install claude-code-sms from github.com/ThePeeps191/claude-code-sms (run its install.sh with --no-wizard) and set it up for me with ccsms. Ask me to run `ccsms login <provider>` in my own terminal for the credentials.

**Or install the plugin manually:** run `claude plugin install sms --marketplace ThePeeps191/claude-code-sms`, then `~/.claude/plugins/.../bin/ccsms setup`. [docs/SETUP.md](docs/SETUP.md) has every step.

## Use

1. **Start sessions with `claude-sms`** instead of `claude`. It takes the same arguments, runs Claude inside tmux, and turns on the SMS channel. On the first screen, choose *"I am using this for local development"*.
   Sessions started with plain `claude` still text you when they finish; they just can't receive texts.
2. **Text `away`** when you leave. When you're back, text `home`, or just sit down at the computer.
3. **Text normally.** The dispatcher works out what you mean. Text `?` for the command list.

| Text | Does |
|---|---|
| `status` / `what's running?` | List sessions and what they're doing |
| `@webapp <msg>` or `2: <msg>` | Send to a specific session |
| `<anything else>` | The dispatcher routes it (and asks if it's ambiguous) |
| `prompt` ... `send` / `discard` | Write one prompt across several texts |
| `away` / `home` / `pause` / `resume` / `quiet until 3pm` | When to text you |
| `watch webapp` / `mute webapp` | Per-session: milestones too / no texts |
| `peek webapp` / `halt webapp` | See its screen / interrupt it (Esc) |
| `new homework: outline my essay` | Start a session (opt-in, see `spawn.roots`) |
| `resume webapp` / `retry webapp` | Restart an ended session / continue after a usage limit |
| `model haiku` | Switch the dispatcher model |
| `more` / `cost` / `?` | Next page / spend / help |

> **Never text just `STOP`.** Carriers and providers treat it as "unsubscribe" and block further texts to you. Text `START` to undo it. To interrupt a session, use `halt`.

Inside Claude Code you can also say "text me when this is done" (the session calls `sms_watch`), or use `/sms:away`, `/sms:home`, `/sms:status`, `/sms:model`, `/sms:watch`.

## How it works

```
 phone ⇄ SMS provider ⇄ tunnel ⇄ hub (background service) ⇄ bridge (one per Claude Code session)
                                    ↑
                     hooks report: finished, failed, waiting, activity
```

- **Hub:** a small local service. It owns the provider connection, your number allowlist, the session list, texting modes and the outbound rules. It calls `claude -p` (tools disabled) to understand your texts and to shorten long summaries.
- **Bridge:** a [Claude Code channel](https://code.claude.com/docs/en/channels) MCP server. It delivers your texts into the session and gives Claude `sms_reply`, `sms_ask`, `sms_update` and `sms_watch`.
- **Hooks:** they make sure "done", "failed" and "waiting on you" texts never depend on Claude remembering to send them.

The full design is in [docs/DESIGN.md](docs/DESIGN.md).

## Cost

You pay your SMS provider per text segment, in both directions:
- Telnyx: about $0.004 + carrier fees per segment.
- Twilio: about $0.008 + carrier fees per segment.
- The number itself costs about $1–2 per month.

A typical day of finishes, a question and a few replies is a few cents. The daily budget (`budget.dailySegments`, default 30) caps it, `cost` shows today's spend, and texts are normalized to plain characters so an emoji can't triple the price. The dispatcher's `claude -p` calls use your Claude plan's usage. They're small, and `model haiku` makes them lighter.

## Security

- **Signed webhooks:** a text is acted on only if the provider's webhook signature checks out **and** the sender is one of your numbers. Everything else is ignored silently.
- **Caller ID can be spoofed.** If your sessions run with broad permissions, set an unlock PIN (`ccsms config set security.unlockPin 4821`), then text `unlock 4821` to open a window. Text `lockdown` to ignore all texts until you run `ccsms unlock` at the computer.
- **Fixed recipients:** texts go only to your configured numbers; no tool can choose a recipient. Common secret formats are scrubbed from outgoing texts.
- **Your secrets stay local.** Credentials live in `~/.claude-code-sms/secrets.env` (mode 600) and are entered only at a hidden prompt, never in chat.
- **What leaves your machine:** message text passes through your SMS provider, and short routing context goes to Claude.

## Status

v0.1. Verified end to end on macOS with real Claude Code sessions: delivery, DONE texts, the dispatcher, questions, capture, peek/halt, starting and resuming sessions, the quick tunnel, the installer and self-update.

Still to verify against live services:
- real SMS through Telnyx and Twilio (the provider code is unit-tested against their documented formats);
- the Linux systemd service.

Reports and PRs are welcome.

## Troubleshooting

Run `ccsms doctor`: it checks everything and prints the fix for each problem. More help is in [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md), or ask Claude: `/sms:setup why didn't I get a text?`

## Uninstall

```bash
ccsms uninstall                      # stops the service, removes links, optionally deletes ~/.claude-code-sms
claude plugin uninstall sms@claude-code-sms
```

Your SMS number stays on your provider account; release it there if you don't need it.

## Development

```bash
bun install
bun test                      # unit + hub behavior tests (no network)
bun test/router.live.ts       # live dispatcher eval (uses your Claude login)
bunx tsc --noEmit
ccsms phone                   # fake phone in a terminal (with provider "fake")
```

MIT licensed. Not affiliated with Anthropic, Telnyx or Twilio.
