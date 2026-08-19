/*
Locale-tolerant price parsing.

eBay formats prices per marketplace: `US $90.98` on ebay.com, `USD90,98` on ebay.es,
`1.234,56 EUR` on ebay.de. The old parser assumed the US convention and stripped every comma, so
`USD90,98` came out as 9098 — a hundredfold error — and `1.234,56` as 1.234.

Rather than key the separator convention off the marketplace (which breaks the moment eBay renders a
foreign-currency listing on a local site), the amount parser reads the convention out of the string
itself: the last `.` or `,` is a decimal point when 1-2 digits follow it, and a thousands separator
otherwise. That is correct for every price format eBay emits, in both conventions, without knowing
the site. Three-digit tails (`1,234`) stay thousands — prices are written with two decimals, so a
three-digit group is never the fractional part.
*/
import type { ParsedCurrency } from './dto/index.js';

/** Currency signs eBay renders, mapped to ISO 4217. Order matters only for multi-char signs. */
const SYMBOL_TO_ISO: [string, string][] = [
    ['US $', 'USD'],
    ['AU $', 'AUD'],
    ['C $', 'CAD'],
    ['zł', 'PLN'],
    ['Kč', 'CZK'],
    ['CHF', 'CHF'],
    ['$', 'USD'],
    ['€', 'EUR'],
    ['£', 'GBP'],
    ['¥', 'JPY'],
    ['₹', 'INR'],
    ['₱', 'PHP'],
];

/** Digits plus the separators/spaces that can appear inside one formatted number. */
const NUMBER_RUN = /\d[\d.,\u00A0\u202F' ]*\d|\d/;

/**
 * Turn one formatted number into a float, inferring the decimal separator from the string.
 * Returns null when `raw` holds no digits.
 */
export function parseAmount(raw: string): number | null {
    const cleaned = raw.replace(/[\s\u00A0\u202F']/g, '');
    if (!/\d/.test(cleaned)) return null;

    const lastSep = Math.max(cleaned.lastIndexOf('.'), cleaned.lastIndexOf(','));
    if (lastSep === -1) {
        const plain = Number.parseFloat(cleaned);
        return Number.isFinite(plain) ? plain : null;
    }

    const tail = cleaned.slice(lastSep + 1);
    const head = cleaned.slice(0, lastSep).replace(/[.,]/g, '');
    // A 1-2 digit tail is the fractional part; anything else is a thousands group.
    const isDecimal = /^\d{1,2}$/.test(tail);
    const num = Number.parseFloat(isDecimal ? `${head}.${tail}` : `${head}${tail}`);
    return Number.isFinite(num) ? num : null;
}

/**
 * ISO code for the currency `input` is written in, or null when it carries no currency marker.
 * Symbols win over ISO codes so `US $90.98` reads as USD rather than tripping over stray uppercase.
 */
export function detectCurrency(input: string): string | null {
    for (const [symbol, iso] of SYMBOL_TO_ISO) {
        if (input.includes(symbol)) return iso;
    }
    // ISO code sitting against the number: `USD90,98` or `78,57 EUR`.
    return input.match(/\b([A-Z]{3})\s*\d/)?.[1]
        ?? input.match(/\d\s*([A-Z]{3})\b/)?.[1]
        ?? null;
}

/**
 * Parse a free-form price string. `fallbackCurrency` (the marketplace's own currency) is used when
 * the string has an amount but no currency marker — never assume USD, that is what the site is for.
 */
export function parseCurrency(
    input: string | null | undefined,
    fallbackCurrency?: string,
): ParsedCurrency | null {
    if (!input) return null;
    const run = input.match(NUMBER_RUN)?.[0];
    if (!run) return null;
    const cost = parseAmount(run);
    if (cost === null) return null;
    const currency = detectCurrency(input) ?? fallbackCurrency;
    if (!currency) return null;
    return { currency, cost };
}
