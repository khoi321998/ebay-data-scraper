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

/**
 * One expected-but-absent field: what is missing, and the DOM hook it should have come from.
 *
 * Deliberately just those two. Severity is what decides `ExtractionReport.status`, and whether
 * the value arrived as `null` or as `''` says nothing a reader can act on — both mean the same
 * thing (the hook stopped matching), and the fix is the same either way.
 */
export interface ExtractionIssue {
    /** Dot path into the pushed record, e.g. `product.specifications`. */
    field: string;
    /** The DOM hook the field is read from, so a broken selector is obvious from the dataset. */
    selector?: string;
}

export interface ExtractionReport {
    /** `broken` if any critical field is absent, `degraded` if only warnings, else `ok`. */
    status: ExtractionStatus;
    /** How many declared checks actually applied to this record (mode-dependent). */
    checkedFields: number;
    /** Flat list of absent field paths — the quick "what did the DOM change break?" view. */
    missingFields: string[];
    issues: ExtractionIssue[];
}
