/*
Extraction health audit.

Selector rot is the failure mode of this scraper: eBay ships a markup change, a selector stops
matching, and the field is written as `null` — the run still "succeeds" and nobody notices until
someone reads the dataset. Rather than sprinkling checks through the handlers, every field we
expect to find is declared once in a table below, and the assembled record is walked against that
table right before it is pushed.

Adding a field to watch = one line in the relevant checks array. Keep `severity: 'critical'` for
fields that cannot legitimately be absent from a live page (a listing always has a title and a
price); everything that some listings genuinely lack belongs at `'warning'`, or stays out of the
table entirely — a check that fires on healthy pages trains everyone to ignore the report.
*/
import type { Log } from 'crawlee';

import type {
    ExtractionError,
    ExtractionIssue,
    ExtractionReport,
    ExtractionSeverity,
    ExtractionStatus,
} from './dto/index.js';

/** Any pushed record — checks address it by dot path, not by concrete type. */
type RecordLike = Record<string, unknown>;

/** One declared expectation about the shape of a pushed record. */
export interface FieldCheck {
    /** Dot path into the record, e.g. `product.pricing.priceMin`. */
    path: string;
    severity: ExtractionSeverity;
    /** DOM hook the value comes from — copied into the issue so the fix site is obvious. */
    selector?: string;
    /** Skip the check unless this passes — used to scope checks to a capture mode / section. */
    when?: (record: RecordLike) => boolean;
}

export function emptyExtractionReport(): ExtractionReport {
    return { status: 'ok', checkedFields: 0, missingFields: [], issues: [], errors: [] };
}

function getByPath(record: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>(
        (acc, key) => (acc == null ? acc : (acc as RecordLike)[key]),
        record,
    );
}

/**
 * `null`/`undefined` → missing. Blank strings, empty arrays and empty plain objects → empty.
 * `0` and `false` are real values (a listing can have 0 sold) and never count as absent.
 */
function classify(value: unknown): 'missing' | 'empty' | null {
    if (value === null || value === undefined) return 'missing';
    if (typeof value === 'string') return value.trim() ? null : 'empty';
    if (Array.isArray(value)) return value.length ? null : 'empty';
    if (typeof value === 'number') return Number.isNaN(value) ? 'missing' : null;
    if (typeof value === 'object') return Object.keys(value as object).length ? null : 'empty';
    return null;
}

/**
 * Walk `record` against `checks` and return the report. Pass the record's in-progress report as
 * `existing` to carry over errors recorded by earlier handlers.
 */
export function auditExtraction(
    record: unknown,
    checks: FieldCheck[],
    existing?: ExtractionReport,
): ExtractionReport {
    const errors: ExtractionError[] = existing?.errors ?? [];
    const issues: ExtractionIssue[] = [];
    let checkedFields = 0;

    for (const check of checks) {
        if (check.when && !check.when((record ?? {}) as RecordLike)) continue;
        checkedFields++;
        const reason = classify(getByPath(record, check.path));
        if (!reason) continue;
        issues.push({
            field: check.path,
            severity: check.severity,
            reason,
            ...(check.selector ? { selector: check.selector } : {}),
        });
    }

    let status: ExtractionStatus = 'ok';
    if (issues.some((i) => i.severity === 'critical')) status = 'broken';
    else if (issues.length || errors.length) status = 'degraded';

    return {
        status,
        checkedFields,
        missingFields: issues.map((i) => i.field),
        issues,
        errors,
    };
}

/** Append a caught failure so it travels with the record instead of only hitting the console. */
export function recordExtractionError(
    target: { extraction: ExtractionReport },
    stage: string,
    err: unknown,
): void {
    target.extraction.errors.push({
        stage,
        message: err instanceof Error ? err.message : String(err),
    });
}

/** Surface the report in the run log — `broken` records are worth an error-level line. */
export function logExtractionReport(report: ExtractionReport, log: Log, url: string): void {
    if (report.status === 'ok') {
        log.debug(`extraction ok (${report.checkedFields} fields checked)`, { url });
        return;
    }
    const detail = {
        url,
        status: report.status,
        missingFields: report.missingFields,
        errors: report.errors.map((e) => `${e.stage}: ${e.message}`),
    };
    if (report.status === 'broken') {
        log.error(
            `extraction BROKEN — ${report.missingFields.length}/${report.checkedFields} expected fields absent, likely a DOM change`,
            detail,
        );
    } else {
        log.warning(
            `extraction degraded — ${report.missingFields.length}/${report.checkedFields} expected fields absent`,
            detail,
        );
    }
}

// ──────────────────── Checks: ScrapedItem (main.ts / Playwright) ────────────────────

const hasProduct = (r: RecordLike) => r.product != null;
const hasSeller = (r: RecordLike) => r.seller != null;
const hasSellerRef = (r: RecordLike) => r.sellerRef != null;

export const SCRAPED_ITEM_CHECKS: FieldCheck[] = [
    // Product core — a live listing page always has these.
    { path: 'product.id', severity: 'critical', selector: 'URL /itm/{id}', when: hasProduct },
    { path: 'product.title', severity: 'critical', selector: 'h1.x-item-title__mainTitle', when: hasProduct },
    { path: 'product.pricing.priceMin', severity: 'critical', selector: 'div.x-price-primary span.ux-textspans', when: hasProduct },

    // Product detail — present on the overwhelming majority of listings.
    { path: 'product.specifications', severity: 'warning', selector: 'dl[data-testid="ux-labels-values"] | .x-about-this-item .ux-layout-section-evo__col', when: hasProduct },
    { path: 'product.brand', severity: 'warning', selector: 'dl.ux-labels-values--brand dd | specifics "Brand"', when: hasProduct },
    { path: 'product.media.images', severity: 'warning', selector: 'i18n script blob → VIImageType', when: hasProduct },
    { path: 'product.description.plainText', severity: 'warning', selector: 'itm.ebaydesc.com iframe fetch', when: hasProduct },
    { path: 'product.paymentMethods', severity: 'warning', selector: 'i18n script blob → payments[].textSpans[].accessibilityText', when: hasProduct },

    // Seller pointer carried on product records in seller-bearing modes.
    { path: 'sellerRef.displayName', severity: 'warning', selector: '.x-sellercard-atf__info__about-seller a .ux-textspans--BOLD', when: hasSellerRef },
    { path: 'sellerRef.platformSellerId', severity: 'warning', selector: '.x-sellercard-atf__info__about-seller a[href] /str|/usr', when: hasSellerRef },

    // Seller section — only populated in seller_only / product_and_seller.
    { path: 'seller.profileUrl', severity: 'critical', selector: '.x-sellercard-atf__info__about-seller a[href]', when: hasSeller },
    { path: 'seller.displayName', severity: 'critical', selector: '.str-seller-card__store-name h1 | .x-sellercard-atf .ux-textspans--BOLD', when: hasSeller },
    { path: 'seller.feedbackScore', severity: 'warning', selector: '.fdbk-detail-list__title .SECONDARY', when: hasSeller },
    { path: 'seller.positivePercent', severity: 'warning', selector: '.fdbk-overall-rating__bar-text', when: hasSeller },
    { path: 'seller.itemsSold', severity: 'warning', when: hasSeller },
    { path: 'seller.storeItems', severity: 'warning', when: hasSeller },
    { path: 'seller.about', severity: 'warning', selector: 'seller About tab', when: hasSeller },
    { path: 'seller.feedback.summary.positive', severity: 'warning', selector: 'seller Feedback tab', when: hasSeller },
    { path: 'seller.feedback.detailedRatings.accurateDescription', severity: 'warning', selector: 'seller Feedback tab', when: hasSeller },
];
