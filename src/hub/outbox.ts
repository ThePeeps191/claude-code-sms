import type { Store } from "../shared/db.ts";
import type { Config } from "../shared/config.ts";
import type { SmsProvider } from "../providers/provider.ts";
import { ProviderError } from "../providers/provider.ts";
import { toGsm7, segmentCount, paginate } from "../shared/gsm7.ts";
import { scrubSecrets } from "../shared/scrub.ts";
import { maskNumber } from "../shared/e164.ts";
import { logger } from "../shared/log.ts";

const log = logger("outbox");

/**
 * T1 reply to the user's own text, T2 blocker, T3 outcome (DONE), T4 failure, T5 milestone.
 * See docs/DESIGN.md section 8.
 */
export type Tier = "T1" | "T2" | "T3" | "T4" | "T5";

export interface OutItem {
  tier: Tier;
  text: string;
  sessionId?: string | null;
  /** Explicit recipients (T1 replies). Default: the configured notify list. */
  to?: string[];
  /** Items with the same key replace each other while pending (e.g. merged updates). */
  key?: string;
}

export interface EnqueueResult { sent: boolean; queued?: boolean; reason?: string }

const MAX_SEGMENTS: Record<Tier, number> = { T1: 3, T2: 1, T3: 2, T4: 1, T5: 1 };

export function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export class Outbox {
  private batch: OutItem[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private sending: Promise<void> = Promise.resolve();
  batchMs = 45_000;

  constructor(
    private store: Store,
    private cfg: () => Config,
    private provider: () => SmsProvider,
    private statusCallbackUrl: () => string | undefined,
  ) {}

  private notifyList(): string[] {
    const nums = this.cfg().owners.numbers;
    if (!nums.length) return [];
    return this.cfg().owners.notify === "all" ? [...nums] : [nums[0]];
  }

  isPaused(): boolean {
    return this.store.get<{ mode: string }>("mode", { mode: "home" }).mode === "paused";
  }

  budget(): { used: number; limit: number; level: "ok" | "warn" | "exhausted" } {
    const used = this.store.usageSince(startOfToday()).outSegments;
    const limit = this.cfg().budget.dailySegments;
    return { used, limit, level: used >= limit ? "exhausted" : used >= Math.floor(limit * 0.8) ? "warn" : "ok" };
  }

  /** Decide what happens to an outbound item and do it. */
  enqueue(item: OutItem): EnqueueResult {
    if (!item.text.trim()) return { sent: false, reason: "empty" };
    if (!this.cfg().owners.numbers.length) return { sent: false, reason: "no owner numbers configured" };

    // Paused: hold blockers/outcomes/failures for the resume digest; drop milestones.
    if (this.isPaused() && item.tier !== "T1") {
      if (item.tier === "T5") return { sent: false, reason: "paused (updates dropped)" };
      const held = this.store.get<OutItem[]>("held", []);
      held.push({ ...item });
      this.store.set("held", held.slice(-20));
      return { sent: false, queued: true, reason: "paused (held for digest)" };
    }

    const b = this.budget();
    if (b.level === "exhausted" && !(item.tier === "T1" || item.tier === "T2")) {
      log.info(`budget exhausted; dropped ${item.tier}`);
      return { sent: false, reason: "daily text budget used up" };
    }
    if (b.level !== "ok" && item.tier === "T5") return { sent: false, reason: "budget: essentials only" };
    if (b.level !== "ok" && item.tier === "T3") {
      item = { ...item, text: item.text.split("\n")[0].slice(0, 155) };
    }

    if (item.tier === "T3" || item.tier === "T5") {
      if (item.key) this.batch = this.batch.filter((x) => x.key !== item.key);
      this.batch.push(item);
      if (!this.batchTimer) this.batchTimer = setTimeout(() => this.flushBatch(), this.batchMs);
      return { sent: true, queued: true };
    }

    // Immediate tiers carry any pending batch with them.
    const carried = this.takeBatch();
    this.dispatch([...carried, item]);
    return { sent: true };
  }

  /** Remove pending items (e.g. a milestone superseded by DONE). */
  cancelPending(pred: (i: OutItem) => boolean) {
    this.batch = this.batch.filter((i) => !pred(i));
  }

  hasPending(pred: (i: OutItem) => boolean): boolean {
    return this.batch.some(pred);
  }

  private takeBatch(): OutItem[] {
    if (this.batchTimer) { clearTimeout(this.batchTimer); this.batchTimer = null; }
    const b = this.batch;
    this.batch = [];
    return b;
  }

  flushBatch() {
    const items = this.takeBatch();
    if (items.length) this.dispatch(items);
  }

  /** Merge items per recipient and send. */
  private dispatch(items: OutItem[]) {
    const byRecipient = new Map<string, OutItem[]>();
    for (const it of items) {
      const to = it.to?.length ? it.to : this.notifyList();
      for (const r of to) {
        if (!byRecipient.has(r)) byRecipient.set(r, []);
        byRecipient.get(r)!.push(it);
      }
    }
    for (const [to, its] of byRecipient) {
      const maxSeg = Math.max(...its.map((i) => MAX_SEGMENTS[i.tier]));
      const tier = its.map((i) => i.tier).sort()[0];
      const text = its.map((i) => i.text.trim()).join("\n");
      const sessionId = its.length === 1 ? its[0].sessionId ?? null : null;
      this.sendPaged(to, text, maxSeg, tier, sessionId);
    }
  }

  /** Send the first page and keep the rest for "more". */
  sendPaged(to: string, rawText: string, maxSegments: number, tier: Tier, sessionId: string | null) {
    const clean = toGsm7(scrubSecrets(rawText));
    if (!clean) return;
    const pages = paginate(clean, maxSegments);
    let first = pages[0];
    if (pages.length > 1) {
      first += ` (MORE 1/${pages.length})`;
      this.store.set(`more:${to}`, { pages: pages.slice(1), total: pages.length, at: 1 });
    } else {
      this.store.set(`more:${to}`, null);
    }
    this.sendRaw(to, first, tier, sessionId);
  }

  /** Send the next "more" page for a recipient. Returns false if nothing is left. */
  sendMore(to: string): boolean {
    const st = this.store.get<{ pages: string[]; total: number; at: number } | null>(`more:${to}`, null);
    if (!st || !st.pages.length) return false;
    const [page, ...rest] = st.pages;
    const at = st.at + 1;
    const suffix = rest.length ? ` (MORE ${at}/${st.total})` : ` (${at}/${st.total})`;
    this.store.set(`more:${to}`, rest.length ? { pages: rest, total: st.total, at } : null);
    this.sendRaw(to, page + suffix, "T1", null);
    return true;
  }

  /** Low-level send with retries. Serialized so texts arrive in order. */
  sendRaw(to: string, text: string, tier: Tier | string, sessionId: string | null): Promise<void> {
    this.sending = this.sending.then(async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await this.provider().send(to, text, { statusCallbackUrl: this.statusCallbackUrl() });
          this.store.addMessage({
            direction: "out", peer: to, body: text,
            segments: res.segments ?? segmentCount(text),
            cost: res.cost, currency: res.currency, provider_id: res.providerId || null,
            status: res.status, tier, session_id: sessionId,
          });
          this.store.set("lastSendError", null);
          log.info(`sent ${tier} to ${maskNumber(to)} (${segmentCount(text)} seg)`);
          return;
        } catch (e: any) {
          const status = e instanceof ProviderError ? e.status : undefined;
          const permanent = status !== undefined && status >= 400 && status < 500 && status !== 429;
          log.warn(`send attempt ${attempt} failed: ${e?.message ?? e}`);
          this.store.set("lastSendError", { at: Date.now(), message: String(e?.message ?? e) });
          if (permanent || attempt === 3) return;
          await Bun.sleep(attempt * 3000);
        }
      }
    });
    return this.sending;
  }

  /** Called when the mode leaves "paused": send held items as one digest. */
  releaseHeld(): boolean {
    const held = this.store.get<OutItem[]>("held", []);
    this.store.set("held", null);
    if (!held.length) return false;
    const text = "While paused: " + held.map((h) => h.text.replace(/\n/g, " ")).join(" | ");
    for (const to of this.notifyList()) this.sendPaged(to, text, 3, "T1", null);
    return true;
  }

  async drain() {
    this.flushBatch();
    await this.sending;
  }
}
