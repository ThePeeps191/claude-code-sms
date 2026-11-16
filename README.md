<div align="center">

# claude-code-sms

**Text your Claude Code sessions.**

Leave Claude working, walk away, and keep going from any phone over plain SMS.<br>
Get a text when a session finishes or needs you; text back the next prompt, an answer, or a question.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform: macOS | Linux](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg)
![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-d97757.svg)](https://code.claude.com/docs/en/plugins)

[Install](#install) · [Usage](#usage) · [How it works](#how-it-works) · [Cost](#cost) · [Security](#security) · [Docs](docs/)

</div>

---

```text
you:  away
hub:  Away: I'll text when sessions finish, fail or need you.

hub:  webapp: DONE 14m. Checkout page added, tests pass. Needs STRIPE_SECRET in .env. Reply to continue.
you:  nice. now add a test for the refund flow

hub:  ml-hw: Q: Fig 2 from 1 cleaned data 2 raw data
you:  1

you:  what's running?
hub:  webapp is busy (6m) editing refund.test.ts. ml-hw is idle: figure 2 done.
```

No app to install on your phone, no chat account, no data plan needed. If your phone can send a text, it can drive Claude Code.

## Why

Claude Code is happy to work for half an hour on its own. But it stops when it finishes, when it has a question, or when it hits an error, and nothing moves until you're back at the keyboard. claude-code-sms closes that gap: the moment a session needs you, your phone buzzes, and your reply goes straight back into the session.

## Features

- **Texts only when they matter.** You hear about a session when it finishes, gets stuck, fails, or reaches something you asked to be told about. Short bursts are batched into one text, and a daily budget caps what you can spend.
- **Replies in plain language.** A Claude dispatcher reads each text and works out what you mean, so replies like "yeah do it", "the ml one", "send it to webapp instead" and "don't text me till 3pm" all work.
- **Many sessions at once.** Address a session by name (`@webapp ...`), by number (`2: ...`), or just by context.
- **Answer questions from your phone.** When Claude asks you something, you get numbered options. Reply with a digit or with your own words.
- **Long prompts.** Write one prompt across several texts, then send it.
- **Start, resume and interrupt sessions by text.** You can also peek at a session's screen.
- **Uses your Claude subscription.** The dispatcher is headless Claude Code (`claude -p`) running on your normal login, with no API key. It uses Sonnet by default; text `model haiku` to switch.
- **Bring your own SMS provider.** Telnyx and Twilio are supported, in any country they serve, and the provider layer is pluggable.
- **Only you can use it.** It acts only on signed webhooks from your provider, and only on texts from the numbers you configure.
- **Never touches permissions.** Sessions keep whatever permission mode you start them in. The plugin never approves or denies anything for Claude.

## Requirements

- **macOS or Linux.** The computer has to stay on while you're away; on macOS the hub keeps it from sleeping.
- **[Claude Code](https://claude.com/claude-code)**, installed and logged in.
- **An SMS provider account with a phone number:**
  - [Telnyx](docs/providers/telnyx.md): the cheapest option, about $1/month for a number;
  - [Twilio](docs/providers/twilio.md): widely available, slightly more expensive.

  For the best delivery, use a number in the same country as your phone.
- **[Bun](https://bun.sh) and [tmux](https://github.com/tmux/tmux).** The installer offers to install both.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/ThePeeps191/claude-code-sms/main/install.sh | bash
```

The installer asks before installing anything. It sets up the Claude Code plugin and the `ccsms` and `claude-sms` commands, then starts a setup wizard that walks you through:

1. **Provider credentials:** typed at a hidden prompt and stored only on your machine.
2. **Your phone number(s):** the only numbers allowed to control your sessions.
3. **The number texts come from:** pick one on your account, or buy one. The wizard shows the price and asks first.
4. **A public tunnel:** so your provider can reach your computer. The default Cloudflare quick tunnel needs no account.
5. **A background service:** launchd on macOS, systemd on Linux.
6. **A test text:** you reply `OK` to confirm both directions work.

The commands go into `~/.local/bin`. If your shell can't find `claude-sms` afterwards, add this to your shell profile:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

<details>
<summary><b>Let Claude set it up for you</b></summary>

Paste this into Claude Code:

> Install claude-code-sms from github.com/ThePeeps191/claude-code-sms (run its install.sh with --no-wizard) and set it up for me with ccsms. Ask me to run `ccsms login <provider>` in my own terminal for the credentials.

Claude installs everything and runs setup. You only type your provider credentials, in your own terminal.

</details>

<details>
<summary><b>Install manually</b></summary>

```bash
claude plugin marketplace add ThePeeps191/claude-code-sms
claude plugin install sms@claude-code-sms
# then, from the plugin folder shown by `claude plugin list --json` ("installPath"):
bun install && bun src/cli/main.ts install    # links ccsms + claude-sms into ~/.local/bin
ccsms login telnyx                            # or: ccsms login twilio
ccsms setup
```

[docs/SETUP.md](docs/SETUP.md) explains every step and option, including stable tunnel URLs and non-interactive setup.

</details>

## Usage

### 1. Start sessions with `claude-sms`

```bash
cd ~/code/webapp
claude-sms            # use it instead of `claude`; it takes the same arguments
```

`claude-sms` runs Claude Code inside tmux with the SMS channel turned on. On the first screen, Claude Code asks you to confirm the development channel: choose **"I am using this for local development"**.

Sessions started with plain `claude` still text you when they finish, but they can't receive texts.

### 2. Tell it you're leaving

Text `away`, or run `ccsms away`. When you're back, text `home`, or just start using the computer again: it switches to home mode on its own.

### 3. Text normally

The dispatcher routes ordinary messages and asks when it's unsure. These shortcuts skip the guesswork:

| Text | What it does |
|---|---|
| `status` or `what's running?` | List sessions and what each is doing |
| `@webapp <msg>` or `2: <msg>` | Send to a specific session |
| *anything else* | The dispatcher routes it, and asks if it's ambiguous |
| `prompt` … `send` / `discard` | Write one prompt across several texts |
| `away` / `home` / `pause` / `resume` | Choose when you get texts |
| `quiet until 3pm` | Pause texts until a time |
| `watch webapp` / `mute webapp` | Also get milestone updates from a session / silence it |
| `peek webapp` | See the last lines of its screen |
| `halt webapp` | Interrupt it (like pressing Esc) |
| `new homework: outline my essay` | Start a new session (opt-in; see [Configuration](#configuration)) |
| `resume webapp` | Restart a session that ended |
| `retry webapp` | Continue after a usage limit resets |
| `model haiku` | Switch the dispatcher model |
| `more` / `cost` / `?` | Next page of a long text / today's spend / help |

> [!WARNING]
> **Never text just `STOP`.** Carriers and providers treat it as "unsubscribe" and block all further texts to you until you text `START`. To interrupt a session, text `halt`.

### Inside Claude Code

Sessions get four tools: `sms_reply`, `sms_ask`, `sms_update` and `sms_watch`. Just say what you want: "text me when this is done", or "ask me on my phone which option I prefer".

Slash commands: `/sms:status`, `/sms:away`, `/sms:home`, `/sms:pause`, `/sms:watch`, `/sms:model`, `/sms:unlock`, `/sms:setup`.

### From the terminal

| Command | What it does |
|---|---|
| `ccsms status` | Hub health, sessions, mode, today's texts |
| `ccsms away` / `home` / `pause` / `resume` | Set the texting mode |
| `ccsms watch <session> [on\|off\|quiet]` | Per-session notifications |
| `ccsms doctor` | Check everything and print a fix for each problem |
| `ccsms test [text]` | Send yourself a test text |
| `ccsms phone` | Fake phone in your terminal (with the `fake` provider: no texts, no cost) |
| `ccsms logs` | Follow the hub log |
| `ccsms config ...` | Read or change settings |
| `ccsms start` / `stop` / `restart` | Control the background hub |

## How it works

```text
 phone ⇄ SMS provider ⇄ tunnel ⇄ hub (background service) ⇄ bridge (one per Claude Code session)
                                    ↑
                     hooks report: finished, failed, waiting, activity
```

- **Hub:** a small local service, written in TypeScript on Bun. It owns the provider connection, your number allowlist, the session list, texting modes and the rules for what's worth a text. To understand your texts and to shorten long summaries, it calls `claude -p` with every tool disabled.
- **Bridge:** a [Claude Code channel](https://code.claude.com/docs/en/channels), an MCP server that runs inside each session. It delivers your texts into the conversation and gives Claude its SMS tools.
- **Hooks:** they report when a session finishes, fails or waits on you. "Done" and "needs you" texts never depend on Claude remembering to send them.

The full design, including the decisions behind it, is in [docs/DESIGN.md](docs/DESIGN.md).

## Cost

You pay your SMS provider per message segment, in both directions:

| | Per segment (approx.) | Number |
|---|---|---|
| Telnyx | $0.004 + carrier fees | about $1/month |
| Twilio | $0.008 + carrier fees | about $1–2/month |

A typical day of a few finishes, a question and some replies costs a few cents. Three things keep it small:
- a daily cap: `budget.dailySegments`, 30 by default;
- outgoing texts converted to plain characters, so one emoji can't triple a message's price;
- the `cost` text, which shows today's spend.

The dispatcher's `claude -p` calls count toward your Claude plan's usage. They're short, and `model haiku` makes them lighter still.

## Security

- **Verified senders.** A text is acted on only if the provider's webhook signature checks out **and** it comes from one of your numbers. Anything else is silently ignored.
- **Optional PIN.** Caller ID can be spoofed. If your sessions run with broad permissions, set a PIN with `ccsms config set security.unlockPin 4821`. Then text `unlock 4821` to open a 12-hour window. Text `lockdown` to ignore every text until you run `ccsms unlock` at the computer.
- **Fixed recipients.** Texts go only to your configured numbers; no tool can choose who receives a text. Common secret formats, like API keys and tokens, are scrubbed from outgoing texts.
- **Local secrets.** Credentials live in `~/.claude-code-sms/secrets.env` (mode 600) and are only ever typed at a hidden prompt.
- **Locked-down local API.** The hub's control API requires a per-install token, so a web page in your browser can't send prompts to your sessions.
- **What leaves your machine.** Message text passes through your SMS provider. Short routing context goes to Claude, under the same terms as the rest of your Claude Code usage.

## Configuration

Settings live in `~/.claude-code-sms/config.toml`. Change them with `ccsms config set <key> <value>` or by re-running `ccsms setup`. The ones you're most likely to want:

| Key | Default | Meaning |
|---|---|---|
| `owners.numbers` | (set by setup) | Phones allowed to control sessions (`ccsms config add-owner`) |
| `router.model` | `sonnet` | Model that interprets your texts |
| `budget.dailySegments` | `30` | Daily cap on outgoing segments |
| `spawn.roots` | (none) | Folders where a text may start a new session (comma-separated) |
| `security.unlockPin` | (none) | PIN required before texts are acted on |
| `modes.autoHome` | `true` | Switch to home when you use the computer |
| `modes.autoAway` | `false` | Switch to away after `autoAwayMinutes` of inactivity |
| `modes.doneSettleSeconds` | `30` | How long a session must stay idle before "done" is texted |

## Project status

**Alpha (v0.1).** Verified end to end on macOS with real Claude Code sessions and a simulated phone:
- delivery, done texts and dispatcher routing;
- questions, multi-text prompts, and peek/halt;
- starting and resuming sessions;
- the quick tunnel, the installer and self-update.

Not yet verified against live services:
- real SMS through Telnyx and Twilio. The provider code is unit-tested against their documented webhook formats.
- the Linux systemd service.

Bug reports from real-world setups are especially welcome.

**Known limitations:**
- **Channels are a research preview.** Claude Code channels aren't generally available yet, so `claude-sms` loads this one as a development channel.
- **Sessions you can text must run in tmux.** That's what lets the hub peek at and interrupt them. `claude-sms` handles this for you.
- **The quick tunnel's URL changes on every restart.** The hub re-registers the webhook automatically, but a [stable URL](docs/SETUP.md) is more robust.

## Troubleshooting

Start with `ccsms doctor`: it checks the hub, provider, tunnel, webhook and service, and prints the fix for anything wrong. [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) covers common problems. You can also ask Claude: `/sms:setup why didn't I get a text?`

## Uninstall

```bash
ccsms uninstall                                # stops the service, removes the links, optionally deletes ~/.claude-code-sms
claude plugin uninstall sms@claude-code-sms
```

Your phone number stays on your provider account. Release it there if you no longer need it.

## Contributing

Issues and pull requests are welcome. To work on it locally:

```bash
git clone https://github.com/ThePeeps191/claude-code-sms && cd claude-code-sms
bun install
bun test                      # unit and hub behavior tests (no network, no cost)
bunx tsc --noEmit             # typecheck
bun test/router.live.ts       # live dispatcher eval (uses your Claude login)
```

To try everything without sending real texts, set the provider to `fake` (`ccsms setup --provider fake`) and use `ccsms phone` as your phone.

- **Adding an SMS provider:** implement the interface in [`src/providers/`](src/providers/). [`telnyx.ts`](src/providers/telnyx.ts) and [`twilio.ts`](src/providers/twilio.ts) are the references.
- **Releasing:** bump the version in both `package.json` and `.claude-plugin/plugin.json`.

## License

[MIT](LICENSE). Not affiliated with Anthropic, Telnyx or Twilio.
