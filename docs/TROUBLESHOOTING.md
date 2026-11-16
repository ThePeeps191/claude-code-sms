# Troubleshooting

Start here:

```bash
ccsms doctor      # checks everything, prints a fix for each problem
ccsms status      # mode, sessions, webhook, today's texts
ccsms logs        # follow the hub log (~/.claude-code-sms/logs/hub.log)
```

Or ask Claude: `/sms:setup <your problem>`.

## I don't get texts

- **Mode:** by default you get texts only in `away` mode (text `away`, or `ccsms away`). In `home` mode only *watched* sessions text you.
- **Auto-home:** if you're using the computer, auto-home flips the mode back to `home`. Turn it off with `ccsms config set modes.autoHome false`.
- **DONE timing:** "done" is sent once the session has been idle for about 30 seconds with no background work.
- **Muted session:** `ccsms status` shows `[muted]`.
- **Budget:** if the daily budget is used up, `cost` shows it.
- **Provider errors:** `ccsms status` shows `last send error`. Trial accounts often text only verified numbers.
- **Opt-out:** you texted `STOP`. Text `START` to the hub number, then run `ccsms unlock`.

## My texts don't reach a session

- **Launcher:** the session must be started with `claude-sms`. `ccsms status` shows `texts in+out` for it. Sessions started with plain `claude` can only send.
- **Allowlist:** your number must be in `owners.numbers` (`ccsms config add-owner +1...`).
- **Webhook:** doctor should show the webhook as OK and say "Public URL reaches this computer". Quick tunnels take about 20 seconds after the hub starts.
- **Busy sessions** get your text after their current step. The hub tells you when that happens.

## The hub won't start or hangs (macOS)

If the plugin files live in `~/Desktop`, `~/Documents` or `~/Downloads`, macOS blocks the background service from reading them. Install the plugin from its marketplace (`claude plugin install sms --marketplace ThePeeps191/claude-code-sms`) so it lives under `~/.claude/plugins`, then run `ccsms setup` again.

## "claude-sms" shows a warning screen every time

That's Claude Code's development-channels warning. Custom channels need `--dangerously-load-development-channels` while channels are in research preview. Choose *"I am using this for local development"*. Sessions you start by text accept it automatically.

## Channels aren't available

Channels need a Claude Code version with channels support and a claude.ai or Console login. On Team and Enterprise plans, an admin must enable channels.

## Starting sessions by text says it's off

Allow parent folders first: `ccsms config set spawn.roots ~/code,~/school`. Each folder must have been opened in Claude Code once (trusted), because the trust dialog can't be answered by text.

## Change settings

- `ccsms config` shows the settings; `ccsms config set <key> <value>` changes one (for example `budget.dailySegments 50`, `router.model haiku`, `owners.notify all`).
- You can also edit `~/.claude-code-sms/config.toml`. The hub reloads it automatically.
- The full list is in [DESIGN.md §13](DESIGN.md#13-configuration-claude-code-smsconfigtoml).
