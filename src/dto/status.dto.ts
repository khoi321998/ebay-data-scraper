/**
 * Run outcome attached to every pushed record.
 *
 * `extraction` answers "did our selectors still match?"; this answers the question before it —
 * "did we get a usable page at all, and is the listing/store still live?". A caller can tell the
 * three outcomes apart without diffing nulls:
 *
 *   - scraped a live page              → success: true,  errorCode: null
 *   - page reached, listing/store gone → success: false, errorCode: PRODUCT_NOT_FOUND | SELLER_NOT_FOUND
 *   - page never usable (bot wall, …)  → success: false, errorCode: BLOCKED | NAVIGATION_FAILED
 */

export const SCRAPE_ERROR_CODES = [
    /** eBay answered 404/410, served its soft-404 layout, or the listing shows an ended notice. */
    'PRODUCT_NOT_FOUND',
    /** The seller store/profile is gone — 404/410, or a page with none of the store markup. */
    'SELLER_NOT_FOUND',
    /** A page rendered without eBay's own chrome — the Akamai bot wall, not a dead page. */
    'BLOCKED',
    /** Seller capture was asked for, but no seller URL could be resolved from the product page. */
    'SELLER_UNRESOLVED',
    /** Crawlee gave up on the request after every retry. */
    'NAVIGATION_FAILED',
    /** The page loaded and parsed, but fields that cannot legitimately be absent came back empty. */
    'EXTRACTION_BROKEN',
] as const;

export type ScrapeErrorCode = (typeof SCRAPE_ERROR_CODES)[number];

/** The outcome triple every record carries. */
export interface ScrapeOutcome {
    /** True only when the record describes a live page we parsed successfully. */
    success: boolean;
    /** Machine-readable reason, `null` when `success`. */
    errorCode: ScrapeErrorCode | null;
    /** Human-readable detail for the same reason — which signal fired, which status code, etc. */
    errorMessage: string | null;
}
