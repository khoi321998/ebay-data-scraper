/*
Liveness detection and run outcome.

Two questions this file answers, both of which used to be invisible in the dataset:

  1. Did we reach a real page?  A record full of nulls can mean "eBay changed its markup", but it
     can just as easily mean "Akamai served us the bot wall". Those need opposite responses — one
     is a code fix, the other is a retry — so they must not collapse into the same row.
  2. Is the listing/store still there?  eBay removes listings and stores constantly; a caller
     re-checking a URL wants a definitive "gone", not an empty record.

The signals below are the ones the standalone `ebay-status-checker` Actor uses, and they are chosen
so every uncertain case fails *open* (treated as live / retryable) rather than recording a live page
as dead:

  - 404/410            definitive, eBay's answer for anything removed from the platform.
  - soft-404 banner    definitive, HTTP 200 with eBay's "We looked everywhere!" layout.
  - missing `#gh`      the global header is on every real eBay page; without it we were walled.
  - ended notice       heuristic — requires BOTH the status-message banner AND the absence of any
                       buy box, so a single selector rotting silently means "live", never "dead".
*/
import { currentActorRunId } from './actor-run.js';
import type {
    CaptureMode,
    Product,
    ScrapedItem,
    ScrapeErrorCode,
    SellerSection,
} from './dto/index.js';
import { siteFor } from './ebay-sites.js';
import { emptyExtractionReport } from './extraction-audit.js';

/**
 * Just enough of cheerio to count matches and read text. Typed structurally on purpose: crawlee
 * bundles its own cheerio copy, and its `CheerioAPI` is not assignable to the one from the
 * top-level `cheerio` dependency, so naming either type here would break one of the two callers.
 */
export type DomQuery = (selector: string) => { length: number; first(): { text(): string } };

/** eBay answers with these for listings/stores removed from the platform — definitive, never retry. */
export const GONE_STATUS_CODES = new Set([404, 410]);

export const STATUS_SELECTORS = {
    /** Global eBay header — present on every real eBay page, missing when Akamai blocks us. */
    ebayHeader: '#gh',
    /** Item title, only rendered on a live item view page. */
    productTitle: 'h1.x-item-title__mainTitle',
    /** Price block — the other half of "this is an item page at all". */
    productPrice: 'div.x-price-primary',
    /** eBay's "We looked everywhere!" soft-404 banner (served with HTTP 200). */
    productErrorBanner: '[data-testid^="dp-error-banner-container"]',
    /** Banner an ended/sold listing carries in place of its buy box. */
    productEndedNotice: '[data-testid="d-statusmessage"], .d-statusmessage',
    /** Any purchase action — a live listing always offers at least one of these. */
    productBuyBox: '.x-bin-action, .x-atc-action, .x-bid-action, [data-testid="x-bin-action"]',
    /** Seller card on a store page, only rendered for a live store. */
    sellerCard: '.str-seller-card-wrap, .str-seller-card',
    /** Other markup that only a live store/profile renders — used as fallbacks for `sellerCard`. */
    sellerAlive: '.str-seller-card-wrap, .str-seller-card, article.str-item-card, .fdbk-detail-list, .str-header',
} as const;

/** Thrown to make Crawlee retry with a fresh session — a walled page is not a dead page. */
export function blockedError(statusCode: number | undefined, hasEbayHeader: boolean): Error {
    return new Error(`Likely blocked (status=${statusCode}, hasHeader=${hasEbayHeader}) — retry with new session`);
}

export function isGoneStatus(statusCode: number | undefined): boolean {
    return statusCode !== undefined && GONE_STATUS_CODES.has(statusCode);
}

/**
 * Why this item page is not a live listing, or `null` if it is one.
 * Only called once the page has been confirmed to be a real eBay page.
 */
export function detectProductGone($: DomQuery): string | null {
    if ($(STATUS_SELECTORS.productErrorBanner).length > 0) {
        return 'eBay served its soft-404 error banner for this listing';
    }
    // Both halves must agree: the banner alone also shows up for benign notices, and the buy box
    // alone would report every markup change as an ended listing.
    if ($(STATUS_SELECTORS.productEndedNotice).length > 0 && $(STATUS_SELECTORS.productBuyBox).length === 0) {
        const notice = $(STATUS_SELECTORS.productEndedNotice).first().text().replace(/\s+/g, ' ').trim();
        return `Listing shows an ended/sold notice and offers no buy box${notice ? `: "${notice.slice(0, 200)}"` : ''}`;
    }
    return null;
}

/** True when the page carries any markup only a live store/profile renders. */
export function isSellerAlive($: DomQuery): boolean {
    return $(STATUS_SELECTORS.sellerAlive).length > 0;
}

/** True when the page rendered without eBay's own chrome — i.e. we were served the bot wall. */
export function isWalled($: DomQuery): boolean {
    return $(STATUS_SELECTORS.ebayHeader).length === 0;
}

/**
 * Record the first failure on a record. First one wins: a listing we already know is gone should
 * keep reading `PRODUCT_NOT_FOUND` even when its (necessarily empty) extraction audit follows.
 */
export function markFailure(item: ScrapedItem, code: ScrapeErrorCode, message: string): void {
    if (!item.success) return;
    item.success = false;
    item.errorCode = code;
    item.errorMessage = message;
}

export function emptySellerSection(): SellerSection {
    return {
        isActive: null,
        profileUrl: null,
        displayName: null,
        ebayUsername: null,
        storeId: null,
        feedbackScore: null,
        positivePercent: null,
        itemsSold: null,
        followers: null,
        feedback: {
            summary: { positive: null, neutral: null, negative: null },
            detailedRatings: { accurateDescription: null, shippingSpeed: null, communication: null, shippingCost: null },
            negativeReviewSamples: [],
            positiveReviewSamples: [],
            neutralReviewSamples: [],
        },
        totalSellerFeedbackCount: null,
        about: null,
        logoUrl: null,
        storeItems: [],
    };
}

export function emptyProductSection(url: string, itemId: string | null = null): Product {
    return {
        id: itemId,
        isActive: null,
        title: '',
        brand: null,
        pricing: { currency: siteFor(url).currency, priceMin: null, priceMax: null, localized: null },
        stock: { availableQuantity: null, soldCount: null },
        shipping: { deliveryTimeText: null },
        paymentMethods: [],
        description: { html: null, plainText: null },
        specifications: [],
        media: { images: [], videos: [] },
        reviewsSummary: {
            rating: null,
            reviewCount: null,
            ratingBreakdown: {},
            negativeReviewSamples: [],
            positiveReviewSamples: [],
            neutralReviewSamples: [],
        },
    };
}

/**
 * A record with the mode's full shape and no data yet — the seed for a seller_only run and the
 * fallback for a request that died before any handler built one. Callers get the same key set for
 * a failed URL as for a scraped one, so a failure is a field to read, not a missing row.
 */
export function blankScrapedItem(url: string, mode: CaptureMode, itemId: string | null = null): ScrapedItem {
    return {
        platform: 'ebay',
        url,
        actorRunId: currentActorRunId(),
        capturedAt: new Date().toISOString(),
        captureMode: mode,
        success: true,
        errorCode: null,
        errorMessage: null,
        product: mode === 'seller_only' ? null : emptyProductSection(url, itemId),
        sellerRef: mode === 'product_and_seller' ? { platformSellerId: null, displayName: null, ebayUsername: null } : null,
        seller: mode === 'product_only' ? null : emptySellerSection(),
        technical: null,
        sellerTechnical: null,
        extraction: emptyExtractionReport(),
    };
}
