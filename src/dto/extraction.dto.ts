/**
 * Extraction health metadata attached to every pushed record.
 *
 * eBay changes its markup regularly (see the `ux-labels-values` → `ux-layout-section-evo`
 * item-specifics migration). When that happens a selector silently stops matching and the
 * field is written as `null`, which is indistinguishable from "the listing genuinely has no
 * such value". This report makes the difference visible: every field we *expect* to find is
 * declared up front and checked against the assembled record before it is pushed.
 */

/** `critical` = the page cannot have parsed correctly without it; `warning` = usually present. */
export type ExtractionSeverity = 'critical' | 'warning';

export type ExtractionStatus = 'ok' | 'degraded' | 'broken';

/** One expected-but-absent field. */
export interface ExtractionIssue {
    /** Dot path into the pushed record, e.g. `product.specifications`. */
    field: string;
    severity: ExtractionSeverity;
    /** Why it was flagged — `missing` (null/undefined) or `empty` (blank string / empty array). */
    reason: 'missing' | 'empty';
    /** The DOM hook the field is read from, so a broken selector is obvious from the dataset. */
    selector?: string;
}

/** A failure thrown mid-extraction (fetch error, timeout, evaluate crash). */
export interface ExtractionError {
    /** Handler or step that failed, e.g. `DESCRIPTION`, `SELLER_STORE`. */
    stage: string;
    message: string;
}

export interface ExtractionReport {
    /** `broken` if any critical field is absent, `degraded` if only warnings/errors, else `ok`. */
    status: ExtractionStatus;
    /** How many declared checks actually applied to this record (mode-dependent). */
    checkedFields: number;
    /** Flat list of absent field paths — the quick "what did the DOM change break?" view. */
    missingFields: string[];
    issues: ExtractionIssue[];
    errors: ExtractionError[];
}
