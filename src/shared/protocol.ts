/**
 * Bridge <-> hub protocol over the hub's unix socket. Newline-delimited JSON.
 *
 * bridge -> hub:
 *   { t: "hello", pid, claudePid, sessionId, cwd, name, inbound, tmuxPane, version }
 *   { t: "req", id, op: "reply" | "update" | "ask" | "watch" | "status", args }
 * hub -> bridge:
 *   { t: "welcome", sessionId, name, num }
 *   { t: "res", id, ok, result?, error? }
 *   { t: "deliver", content, meta }       -> becomes notifications/claude/channel
 */
export type BridgeHello = {
  t: "hello";
  pid: number;
  claudePid: number | null;
  sessionId: string | null;
  cwd: string;
  name: string | null;
  inbound: boolean;
  tmuxPane: string | null;
  version: string;
};

export type BridgeRequest = { t: "req"; id: number; op: "reply" | "update" | "ask" | "watch" | "status"; args: Record<string, unknown> };
export type HubResponse = { t: "res"; id: number; ok: boolean; result?: string; error?: string };
export type HubDeliver = { t: "deliver"; content: string; meta: Record<string, string> };
export type HubWelcome = { t: "welcome"; sessionId: string; name: string; num: number };

export type BridgeMsg = BridgeHello | BridgeRequest;
export type HubMsg = HubResponse | HubDeliver | HubWelcome;

/** Splits a byte stream into JSON lines. */
export class LineDecoder {
  private buf = "";
  push(chunk: string, onLine: (obj: any) => void) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      try { onLine(JSON.parse(line)); } catch { /* ignore malformed */ }
    }
  }
}

export const encode = (o: unknown) => JSON.stringify(o) + "\n";
