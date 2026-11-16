#!/usr/bin/env bash
# claude-code-sms installer
#   curl -fsSL https://raw.githubusercontent.com/ThePeeps191/claude-code-sms/main/install.sh | bash
#
# Installs prerequisites (asking first), the Claude Code plugin, the ccsms + claude-sms
# commands, then runs the setup wizard. Re-running is safe.
#   --no-wizard   install only; run `ccsms setup` yourself later (or let Claude drive it)
#   --yes         don't ask before installing prerequisites
set -euo pipefail

REPO="${CCSMS_REPO:-ThePeeps191/claude-code-sms}"
WIZARD=1
YES=0
for a in "$@"; do
  case "$a" in
    --no-wizard) WIZARD=0 ;;
    --yes|-y) YES=1 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
have_tty() { [ -r /dev/tty ] && (exec </dev/tty) 2>/dev/null; }
ask() {
  [ "$YES" = 1 ] && return 0
  have_tty || return 1
  local a
  read -r -p "$1 [Y/n] " a </dev/tty || true
  [[ -z "$a" || "$a" =~ ^[Yy] ]]
}

bold "claude-code-sms installer"

OS="$(uname -s)"
[[ "$OS" == "Darwin" || "$OS" == "Linux" ]] || die "macOS or Linux is required."
command -v claude >/dev/null 2>&1 || die "Claude Code isn't installed. Install it first: https://claude.com/claude-code"
info "Claude Code: $(claude --version 2>/dev/null | head -1)"

# Bun (runtime for the hub, bridge and CLI)
if ! command -v bun >/dev/null 2>&1; then
  if [ -x "$HOME/.bun/bin/bun" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
  elif ask "Bun (a JavaScript runtime) is required. Install it now from https://bun.sh?"; then
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
  else
    die "Bun is required: https://bun.sh"
  fi
fi
info "Bun: $(bun --version)"

# tmux (lets the hub peek at, interrupt and start sessions)
if ! command -v tmux >/dev/null 2>&1; then
  if [ "$OS" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    ask "Install tmux with Homebrew (recommended)?" && brew install tmux || info "Skipped tmux (peek/halt/start-by-text won't work until it's installed)."
  elif command -v apt-get >/dev/null 2>&1; then
    ask "Install tmux with apt (needs sudo)?" && sudo apt-get install -y tmux || info "Skipped tmux."
  else
    info "Please install tmux with your package manager (recommended)."
  fi
fi

bold "Installing the Claude Code plugin"
if ! claude plugin install sms --marketplace "$REPO" 2>/dev/null; then
  claude plugin marketplace add "$REPO" || true
  claude plugin install sms@claude-code-sms || die "Plugin install failed. Try: claude plugin marketplace add $REPO && claude plugin install sms@claude-code-sms"
fi

ROOT="$(claude plugin list --json 2>/dev/null | bun -e '
  const list = JSON.parse(await Bun.stdin.text() || "[]");
  const p = list.find((x) => String(x.id).startsWith("sms@"));
  console.log(p?.installPath || p?.readFromFolder || "");
' || true)"
[ -n "$ROOT" ] && [ -d "$ROOT" ] || die "Couldn't find the installed plugin (claude plugin list --json)."
info "Plugin: $ROOT"

(cd "$ROOT" && bun install --no-summary --frozen-lockfile >/dev/null) || die "bun install failed in $ROOT"
bun "$ROOT/src/cli/main.ts" install

if [ "$WIZARD" = 1 ]; then
  if have_tty; then
    bold "Starting setup"
    exec bun "$ROOT/src/cli/main.ts" setup </dev/tty
  else
    info "No terminal available for the setup wizard. Run: ccsms setup"
  fi
else
  bold "Installed."
  info "Next: ccsms setup   (or ccsms doctor to see what's left)"
fi
