import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, symlinkSync, lstatSync, unlinkSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { paths, ensureStateDir } from "../shared/paths.ts";
import { VERSION } from "../shared/version.ts";

export const CHANNEL_SPEC = "plugin:sms@claude-code-sms";
export const repoRoot = () => resolve(import.meta.dir, "..", "..");
export const localBin = () => join(homedir(), ".local", "bin");

export function readInstall(): any {
  try { return JSON.parse(readFileSync(paths.installJson, "utf8")); } catch { return {}; }
}

/** Record where the plugin lives, write the stable shim, and link ccsms + claude-sms into ~/.local/bin. */
export function installShims(): { linked: string[]; pathHint: string | null } {
  ensureStateDir();
  const root = repoRoot();
  const bun = process.execPath;
  const cur = readInstall();
  writeFileSync(paths.installJson, JSON.stringify({
    ...cur, pluginRoot: root, version: VERSION, channelSpec: cur.channelSpec ?? CHANNEL_SPEC, bun, updatedAt: new Date().toISOString(),
  }, null, 2));

  // The shim reads install.json at run time, so it keeps working after plugin updates move the files.
  const shim = `#!/usr/bin/env bash
# claude-code-sms CLI shim (generated). Finds the installed plugin via install.json.
INSTALL="\${CCSMS_HOME:-$HOME/.claude-code-sms}/install.json"
ROOT=""
BUN=""
if [ -f "$INSTALL" ]; then
  ROOT=$(sed -n 's/^ *"pluginRoot": *"\\(.*\\)",\\{0,1\\}$/\\1/p' "$INSTALL" | head -1)
  BUN=$(sed -n 's/^ *"bun": *"\\(.*\\)",\\{0,1\\}$/\\1/p' "$INSTALL" | head -1)
fi
[ -d "$ROOT" ] || ROOT=${JSON.stringify(root)}
[ -x "$BUN" ] || BUN=$(command -v bun || echo ${JSON.stringify(bun)})
if [ ! -d "$ROOT/node_modules" ]; then (cd "$ROOT" && "$BUN" install --no-summary --frozen-lockfile >/dev/null 2>&1); fi
if [ "$1" = "hub" ]; then exec "$BUN" "$ROOT/src/hub/main.ts"; fi
exec "$BUN" "$ROOT/src/cli/main.ts" "$@"
`;
  writeFileSync(paths.shim, shim);
  chmodSync(paths.shim, 0o755);

  const launcher = join(paths.bin, "claude-sms");
  writeFileSync(launcher, `#!/usr/bin/env bash\n# Start Claude Code with claude-code-sms (texts in + out).\nexec "${paths.shim}" claude "$@"\n`);
  chmodSync(launcher, 0o755);

  const linked: string[] = [];
  mkdirSync(localBin(), { recursive: true });
  for (const [name, target] of [["ccsms", paths.shim], ["claude-sms", launcher]] as const) {
    const link = join(localBin(), name);
    try {
      if (existsSync(link) || isSymlink(link)) {
        if (isSymlink(link) && readlinkSync(link) === target) { linked.push(link); continue; }
        if (!isSymlink(link)) continue; // never clobber a real file
        unlinkSync(link);
      }
      symlinkSync(target, link);
      linked.push(link);
    } catch {}
  }
  const onPath = (process.env.PATH ?? "").split(":").includes(localBin());
  return { linked, pathHint: onPath ? null : `Add ~/.local/bin to your PATH:  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc  (or ~/.bashrc)` };
}

export function removeShims() {
  for (const name of ["ccsms", "claude-sms"]) {
    const link = join(localBin(), name);
    try { if (isSymlink(link) && readlinkSync(link).startsWith(paths.root)) unlinkSync(link); } catch {}
  }
}

function isSymlink(p: string): boolean { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }
