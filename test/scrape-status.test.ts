import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';

import {
    blankScrapedItem,
    detectProductGone,
    type DomQuery,
    isGoneStatus,
    isSellerAlive,
    isWalled,
    markFailure,
} from '../src/scrape-status.js';

/** `parseWithCheerio()` hands the handlers exactly this shape. */
const dom = (html: string) => cheerio.load(html) as unknown as DomQuery;

const HEADER = '<div id="gh">eBay chrome</div>';
const BUY_BOX = '<div class="x-bin-action"><button>Buy It Now</button></div>';
const TITLE = '<h1 class="x-item-title__mainTitle">Dell Latitude 3190</h1>';

describe('isGoneStatus', () => {
    it('treats only eBay\'s removal codes as definitive', () => {
        expect(isGoneStatus(404)).toBe(true);
        expect(isGoneStatus(410)).toBe(true);
        // 403/429 are the bot wall — those must retry, not be recorded as a dead listing.
        expect(isGoneStatus(403)).toBe(false);
        expect(isGoneStatus(200)).toBe(false);
        expect(isGoneStatus(undefined)).toBe(false);
    });
});

describe('detectProductGone', () => {
    it('passes a live listing through', () => {
        expect(detectProductGone(dom(`${HEADER}${TITLE}${BUY_BOX}`))).toBeNull();
    });

    it('catches the soft-404 banner eBay serves with HTTP 200', () => {
        const reason = detectProductGone(dom(`${HEADER}<div data-testid="dp-error-banner-container-1">We looked everywhere!</div>`));
        expect(reason).toMatch(/soft-404/);
    });

    it('reports an ended listing only when the notice AND the missing buy box agree', () => {
        const notice = '<div data-testid="d-statusmessage">This listing was ended by the seller.</div>';
        expect(detectProductGone(dom(`${HEADER}${TITLE}${notice}`))).toMatch(/ended\/sold notice/);
        // The banner also carries benign notices; with a buy box present the listing is still live.
        expect(detectProductGone(dom(`${HEADER}${TITLE}${notice}${BUY_BOX}`))).toBeNull();
    });

    it('fails open when the buy-box selector rots — a live page is never called dead', () => {
        // No notice element at all (the far more likely rot direction) → live.
        expect(detectProductGone(dom(`${HEADER}${TITLE}`))).toBeNull();
    });
});

describe('isWalled / isSellerAlive', () => {
    it('reads a page without eBay chrome as the bot wall', () => {
        expect(isWalled(dom('<html><body>Access denied</body></html>'))).toBe(true);
        expect(isWalled(dom(HEADER))).toBe(false);
    });

    it('accepts any of the store markers as a live store', () => {
        expect(isSellerAlive(dom(`${HEADER}<div class="str-seller-card-wrap"></div>`))).toBe(true);
        expect(isSellerAlive(dom(`${HEADER}<article class="str-item-card"></article>`))).toBe(true);
        expect(isSellerAlive(dom(`${HEADER}<div class="fdbk-detail-list"></div>`))).toBe(true);
        expect(isSellerAlive(dom(`${HEADER}<div>nothing here</div>`))).toBe(false);
    });
});

describe('markFailure', () => {
    it('flips the outcome triple together', () => {
        const item = blankScrapedItem('https://www.ebay.com/itm/123', 'product_only');
        expect(item).toMatchObject({ success: true, errorCode: null, errorMessage: null });

        markFailure(item, 'PRODUCT_NOT_FOUND', 'HTTP 404');
        expect(item).toMatchObject({ success: false, errorCode: 'PRODUCT_NOT_FOUND', errorMessage: 'HTTP 404' });
    });

    it('keeps the first failure — the audit that follows must not overwrite the real cause', () => {
        const item = blankScrapedItem('https://www.ebay.com/itm/123', 'product_only');
        markFailure(item, 'PRODUCT_NOT_FOUND', 'HTTP 404');
        markFailure(item, 'EXTRACTION_BROKEN', 'product.title absent');
        expect(item.errorCode).toBe('PRODUCT_NOT_FOUND');
    });
});

describe('blankScrapedItem', () => {
    it('gives each mode the same key set a scraped record would have', () => {
        const productOnly = blankScrapedItem('https://www.ebay.com/itm/123', 'product_only', '123');
        expect(productOnly.product?.id).toBe('123');
        expect(productOnly.seller).toBeNull();
        expect(productOnly.sellerRef).toBeNull();

        const sellerOnly = blankScrapedItem('https://www.ebay.es/str/bargaininc', 'seller_only');
        expect(sellerOnly.product).toBeNull();
        expect(sellerOnly.seller).not.toBeNull();

        const both = blankScrapedItem('https://www.ebay.com/itm/123', 'product_and_seller');
        expect(both.product).not.toBeNull();
        expect(both.seller).not.toBeNull();
        expect(both.sellerRef).not.toBeNull();
    });

    it('leaves liveness unknown rather than guessing, and prices in the marketplace currency', () => {
        const item = blankScrapedItem('https://www.ebay.es/itm/123', 'product_and_seller');
        expect(item.product?.isActive).toBeNull();
        expect(item.seller?.isActive).toBeNull();
        expect(item.product?.pricing.currency).toBe('EUR');
    });
});
