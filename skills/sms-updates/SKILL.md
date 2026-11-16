---
name: sms-updates
description: How to write texts to the user through claude-code-sms (sms_reply, sms_update, sms_ask, sms_watch). Use before any SMS tool call, when a <channel> text message arrives from the user's phone, or when the user asks to be texted or kept posted by text.
---

# Texting the user

The user reads these on a phone, often while busy with something else, and usually pays per message. A good text is one they're glad they got.

**Worth a text:** something they asked for, something that needs them, or a change they'd regret missing (finished, stuck, broken).
**Not worth a text:** starting, routine progress, details your final message covers. When in doubt, don't; they can text "status".

## Writing

- Outcome first, in plain words. Then anything they must do or decide. Then one key number if useful (tests 41/41, 3 files).
- Plain characters only. No markdown, emoji, curly quotes, em dashes or bullets: one such character can triple the cost of the text.
- 160 characters for updates and questions, 300 for replies. Short file names, no full paths, never code, diffs, secrets, tokens or keys.

## Asking

- Only ask if you can't make a reasonable, reversible call yourself. Prefer "Going with X unless you say Y" (pass `default`) and keep working.
- Make it answerable in one or two words, with `options` when there are clear choices: the user can reply with a number.
- Without a default, end your turn after `sms_ask`; the answer arrives as a `<channel>` message with kind="answer".

## Finishing

When you finish while the user is away, don't send a separate done text. Open your final message with a one-sentence outcome; it is texted automatically. If the user started the work by text and the answer is short, `sms_reply` with the result is fine (then no automatic duplicate is sent).

## When the user asks to be texted

"Text me when this is done", "keep me posted by text" -> `sms_watch` with level "on" (texts even while they're at the computer, including milestone updates). "Stop texting me about this" -> level "off".

## Examples

| | Text |
|---|---|
| Good update | `Auth migrated (2/4). Starting payments, about 30 min.` |
| Bad update | `I've started looking at the payment module and will now read checkout.ts.` |
| Good ask | question `DB for the cache?`, options `["Redis", "SQLite"]`, default `SQLite` |
| Good reply | `Picked Prisma: the repo already uses it in 2 services, so no new dependency.` |
