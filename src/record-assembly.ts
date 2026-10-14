/*
One dataset row, assembled by several requests running at the same time.

A product_and_seller record used to be built by a strict relay — ITEM → ITEM_REVIEWS → SELLER_STORE
→ SELLER_REVIEWS — with the half-built record riding along in `userData`. Each step waited for the
previous one even though the seller link is on the product page from the first paint, so a run
spent the sum of every page load instead of the longest chain.

Now each part of the record is a *branch* that starts the moment its input is known, and the record
waits in this store until every open branch has settled:

  ITEM ─┬─ ITEM_REVIEWS
        └─ SELLER (hub → store) ── SELLER_REVIEWS

A branch may open further branches before it settles (SELLER opens SELLER_REVIEWS), so the open set
can only reach empty once nothing is left running. Branches write disjoint parts of the record —
ITEM the product, ITEM_REVIEWS the product's review samples, SELLER/SELLER_REVIEWS the seller
section — so they never race on a field.

The state object is meant to come from `Actor.useState`, which persists it across migrations the
same way `userData` used to carry the record.
*/
import type { Log } from 'crawlee';

import type { ScrapedItem, ScrapeErrorCode } from './dto/index.js';
import { markFailure } from './scrape-status.js';

export type Branch = 'ITEM' | 'ITEM_REVIEWS' | 'SELLER' | 'SELLER_REVIEWS';

/** Which branch a request belongs to, by its router label. */
export const BRANCH_BY_LABEL: Record<string, Branch> = {
    ITEM: 'ITEM',
    ITEM_REVIEWS: 'ITEM_REVIEWS',
    SELLER_HUB: 'SELLER',
    SELLER_STORE: 'SELLER',
    SELLER_REVIEWS: 'SELLER_REVIEWS',
};

interface PendingRecord {
    item: ScrapedItem;
    /** Branches still running. Arrays, not Sets, so the state survives JSON persistence. */
    open: Branch[];
    /** Every branch ever opened on this record, settled or not. */
    started: Branch[];
}

export type AssemblyState = Record<string, PendingRecord>;

export class RecordAssembler {
    constructor(
        private readonly state: AssemblyState,
        private readonly push: (item: ScrapedItem, log: Log) => Promise<void>,
    ) {}

    /**
     * Mark `branch` as running on record `id`, creating the record from `seed` if it does not exist.
     *
     * A branch opens at most once per record, so a retried request that opens it again changes
     * nothing and keeps whatever the other branches have already written. That matters for a parent
     * retried after its child already settled: reopening the child would wait forever on a request
     * the queue has already deduplicated. Returns whether the branch was newly opened — the caller
     * enqueues its request only then.
     */
    open(id: string, branch: Branch, seed?: () => ScrapedItem): boolean {
        let pending = this.state[id];
        if (!pending) {
            if (!seed) throw new Error(`Record ${id} does not exist and no seed was given for branch ${branch}`);
            pending = { item: seed(), open: [], started: [] };
            this.state[id] = pending;
        }
        if (pending.started.includes(branch)) return false;
        pending.started.push(branch);
        pending.open.push(branch);
        return true;
    }

    /** Undo `open` for a branch whose request never made it into the queue, so a retry can redo it. */
    abandon(id: string, branch: Branch): void {
        const pending = this.state[id];
        if (!pending) return;
        pending.open = pending.open.filter((b) => b !== branch);
        pending.started = pending.started.filter((b) => b !== branch);
    }

    has(id: string): boolean {
        return id in this.state;
    }

    get(id: string): ScrapedItem {
        const pending = this.state[id];
        if (!pending) throw new Error(`Record ${id} is not being assembled`);
        return pending.item;
    }

    /** Close `branch`; pushes the record once it was the last one open. */
    async settle(id: string, branch: Branch, log: Log): Promise<void> {
        const pending = this.state[id];
        if (!pending) return;
        pending.open = pending.open.filter((b) => b !== branch);
        if (pending.open.length > 0) {
            log.debug(`record ${id}: ${branch} settled, waiting on ${pending.open.join(', ')}`);
            return;
        }
        // Removed before the await, so a branch settling concurrently cannot push it a second time.
        delete this.state[id];
        await this.push(pending.item, log);
    }

    /** Record why `branch` gave up, then settle it — the rest of the record still ships. */
    async fail(id: string, branch: Branch, code: ScrapeErrorCode, message: string, log: Log): Promise<void> {
        const pending = this.state[id];
        if (!pending) return;
        markFailure(pending.item, code, message);
        await this.settle(id, branch, log);
    }
}
