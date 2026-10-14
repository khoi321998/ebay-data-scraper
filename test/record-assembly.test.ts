import type { Log } from 'crawlee';
import { describe, expect, it } from 'vitest';

import type { ScrapedItem } from '../src/dto/index.js';
import { type AssemblyState, RecordAssembler } from '../src/record-assembly.js';
import { blankScrapedItem } from '../src/scrape-status.js';

const log = { debug: () => {} } as unknown as Log;
const URL = 'https://www.ebay.com/itm/123';

function setup() {
    const state: AssemblyState = {};
    const pushed: ScrapedItem[] = [];
    const records = new RecordAssembler(state, async (item) => { pushed.push(item); });
    const seed = () => blankScrapedItem(URL, 'product_and_seller', '123');
    return { state, pushed, records, seed };
}

describe('RecordAssembler', () => {
    it('pushes once, only after the last open branch settles', async () => {
        const { state, pushed, records, seed } = setup();
        records.open('r', 'ITEM', seed);
        records.open('r', 'ITEM_REVIEWS');
        records.open('r', 'SELLER');

        await records.settle('r', 'SELLER', log);
        await records.settle('r', 'ITEM', log);
        expect(pushed).toHaveLength(0);

        await records.settle('r', 'ITEM_REVIEWS', log);
        expect(pushed).toHaveLength(1);
        expect(state).toEqual({});

        // A late duplicate settle has nothing left to push.
        await records.settle('r', 'ITEM_REVIEWS', log);
        expect(pushed).toHaveLength(1);
    });

    it('waits on a branch opened by another branch before that one settles', async () => {
        const { pushed, records, seed } = setup();
        records.open('r', 'SELLER', seed);
        records.open('r', 'SELLER_REVIEWS');
        await records.settle('r', 'SELLER', log);
        expect(pushed).toHaveLength(0);
        await records.settle('r', 'SELLER_REVIEWS', log);
        expect(pushed).toHaveLength(1);
    });

    it('never reopens a branch, so a retried parent cannot wait on a deduplicated child', async () => {
        const { pushed, records, seed } = setup();
        expect(records.open('r', 'ITEM', seed)).toBe(true);
        expect(records.open('r', 'SELLER')).toBe(true);
        await records.settle('r', 'SELLER', log);

        // ITEM retries and starts the seller branch again.
        expect(records.open('r', 'ITEM', seed)).toBe(false);
        expect(records.open('r', 'SELLER')).toBe(false);

        await records.settle('r', 'ITEM', log);
        expect(pushed).toHaveLength(1);
    });

    it('keeps what the branches wrote when a retry opens the record again', () => {
        const { records, seed } = setup();
        records.open('r', 'ITEM', seed);
        records.get('r').seller!.displayName = 'from store';
        records.open('r', 'ITEM', seed);
        expect(records.get('r').seller!.displayName).toBe('from store');
    });

    it('lets a branch whose request never got queued be opened again', () => {
        const { records, seed } = setup();
        records.open('r', 'ITEM', seed);
        records.open('r', 'SELLER');
        records.abandon('r', 'SELLER');
        expect(records.open('r', 'SELLER')).toBe(true);
    });

    it('records the first failure and still ships the record', async () => {
        const { pushed, records, seed } = setup();
        records.open('r', 'ITEM', seed);
        records.open('r', 'SELLER');
        await records.fail('r', 'SELLER', 'BLOCKED', 'seller walled', log);
        await records.fail('r', 'ITEM', 'NAVIGATION_FAILED', 'later failure', log);
        expect(pushed).toHaveLength(1);
        expect(pushed[0].success).toBe(false);
        expect(pushed[0].errorCode).toBe('BLOCKED');
    });

    it('refuses to open a branch on a record that was never seeded', () => {
        const { records } = setup();
        expect(() => records.open('missing', 'SELLER')).toThrow(/does not exist/);
    });
});
