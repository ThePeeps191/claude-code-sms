---
description: Show or change the claude-code-sms dispatcher model (e.g. /sms:model haiku)
allowed-tools: Bash(ccsms config set:*), Bash(ccsms config get:*)
argument-hint: "[haiku|sonnet|opus|<model id>]"
---
If no argument was given ($ARGUMENTS is empty), run `ccsms config get router.model` and `ccsms config get summarizer.model` and report them. Otherwise run `ccsms config set router.model $ARGUMENTS` and `ccsms config set summarizer.model $ARGUMENTS` and confirm in one line.
