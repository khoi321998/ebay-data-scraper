/*
eBay marketplace registry.

eBay runs one codebase behind many country domains (ebay.com, ebay.es, ebay.de, …). The DOM is
identical across all of them, but three things are not: the UI language, the number format, and the
currency the page defaults to. Nothing in the page tells us which marketplace we are on in a
machine-readable way — the hostname is the only reliable signal — so every locale-dependent decision
in the scraper resolves through this table.

The rule everywhere else in the codebase: never hard-code `www.ebay.com`. Derive the origin from the
URL being handled (and after navigation, from `page.url()`, since small marketplaces redirect to a
bigger one). That keeps warm-up cookies, relative-URL resolution, proxy country and currency all on
the same site the user asked for.
*/

export interface EbaySite {
    /** Canonical hostname, e.g. `www.ebay.es`. */
    host: string;
    /** `https://www.ebay.es` — the base for every relative URL and the warm-up target. */
    origin: string;
    /** Domain suffix after `ebay.`, e.g. `es`, `co.uk`, `com.au`. */
    tld: string;
    /** UI language the site renders in — drives label dictionaries and date parsing. */
    lang: string;
    /** ISO 3166-1 alpha-2 of the marketplace; also the proxy exit country. */
    countryCode: string;
    /** ISO 4217 the marketplace prices in — the fallback when a price string carries no currency. */
    currency: string;
}

function site(host: string, tld: string, lang: string, countryCode: string, currency: string): EbaySite {
    return { host, origin: `https://${host}`, tld, lang, countryCode, currency };
}

/**
 * Ordered so `www.ebay.com` is first — it is the fallback for any host we do not recognise.
 * Regional-language hosts (benl/befr/cafr) are listed explicitly because their language differs
 * from the one the bare TLD implies.
 */
const SITES: EbaySite[] = [
    site('www.ebay.com', 'com', 'en', 'US', 'USD'),
    site('www.ebay.co.uk', 'co.uk', 'en', 'GB', 'GBP'),
    site('www.ebay.de', 'de', 'de', 'DE', 'EUR'),
    site('www.ebay.fr', 'fr', 'fr', 'FR', 'EUR'),
    site('www.ebay.it', 'it', 'it', 'IT', 'EUR'),
    site('www.ebay.es', 'es', 'es', 'ES', 'EUR'),
    site('www.ebay.at', 'at', 'de', 'AT', 'EUR'),
    site('www.ebay.ch', 'ch', 'de', 'CH', 'CHF'),
    site('www.ebay.nl', 'nl', 'nl', 'NL', 'EUR'),
    site('www.ebay.be', 'be', 'nl', 'BE', 'EUR'),
    site('benl.ebay.be', 'be', 'nl', 'BE', 'EUR'),
    site('befr.ebay.be', 'be', 'fr', 'BE', 'EUR'),
    site('www.ebay.ie', 'ie', 'en', 'IE', 'EUR'),
    site('www.ebay.pl', 'pl', 'pl', 'PL', 'PLN'),
    site('www.ebay.com.au', 'com.au', 'en', 'AU', 'AUD'),
    site('www.ebay.ca', 'ca', 'en', 'CA', 'CAD'),
    site('www.cafr.ebay.ca', 'ca', 'fr', 'CA', 'CAD'),
    site('www.ebay.com.hk', 'com.hk', 'zh', 'HK', 'HKD'),
    site('www.ebay.com.sg', 'com.sg', 'en', 'SG', 'SGD'),
    site('www.ebay.com.my', 'com.my', 'en', 'MY', 'MYR'),
    site('www.ebay.ph', 'ph', 'en', 'PH', 'PHP'),
    site('www.ebay.in', 'in', 'en', 'IN', 'INR'),
    site('www.ebay.com.mx', 'com.mx', 'es', 'MX', 'MXN'),
    site('www.ebay.co.jp', 'co.jp', 'ja', 'JP', 'JPY'),
];

export const DEFAULT_SITE = SITES[0];

const BY_HOST = new Map(SITES.map((s) => [s.host, s]));
/** First entry wins, so the `www.` host is what a bare TLD resolves to. */
const BY_TLD = new Map<string, EbaySite>();
for (const s of SITES) if (!BY_TLD.has(s.tld)) BY_TLD.set(s.tld, s);

/** True for any host on an eBay marketplace domain — used to reject foreign URLs at input time. */
export function isEbayUrl(url: string): boolean {
    try {
        return /(?:^|\.)ebay\.[a-z]{2,}(?:\.[a-z]{2,})?$/i.test(new URL(url).hostname);
    } catch {
        return false;
    }
}

/**
 * Marketplace for `url`, or `null` when the host is not an eBay domain we know.
 * Subdomains we have no explicit entry for (`m.ebay.es`, `www.ebay.es.`) fall back to the TLD match,
 * but keep their own origin so navigation stays on the exact host the user gave us.
 */
export function resolveSite(url: string): EbaySite | null {
    let host: string;
    try {
        host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
    } catch {
        return null;
    }

    const exact = BY_HOST.get(host);
    if (exact) return exact;

    const suffix = host.match(/(?:^|\.)ebay\.([a-z.]+)$/i)?.[1];
    if (!suffix) return null;
    const byTld = BY_TLD.get(suffix);
    if (!byTld) return null;

    // Same marketplace, different host (m.ebay.es, ebay.es without www) — keep the caller's host so
    // we never bounce the crawl onto a hostname eBay did not hand us.
    return host === byTld.host ? byTld : { ...byTld, host, origin: `https://${host}` };
}

/** `resolveSite` with the ebay.com fallback applied — for call sites that must have a site. */
export function siteFor(url: string): EbaySite {
    return resolveSite(url) ?? DEFAULT_SITE;
}

/**
 * The canonical store URL to scrape: origin + path, no query, no fragment.
 *
 * Store URLs arrive carrying whatever the caller or the product page had on them — `_tab=feedback`
 * copied straight out of a browser, `_trksid` tracking, `_pgn` paging. Unlike an item URL (where
 * `?var=` picks the listing variation and must survive untouched), nothing in a store query string
 * identifies the store, and `_tab` actively lands us on the wrong one: the item cards live on the
 * shop tab, so a URL pinned to `_tab=feedback` yielded `storeItems: []` with nothing to explain it.
 *
 * Hub URLs are the exception and keep their query — `/sch/i.html?_ssn=x` carries the seller *in*
 * the query, so stripping it would throw away the only identifying part of the URL.
 */
export function storeBaseUrl(url: string): string {
    try {
        const parsed = new URL(url);
        if (!/\/(?:str|usr)\//i.test(parsed.pathname)) return url.replace(/\/+$/, '');
        return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
    } catch (_) {
        return url.replace(/\/+$/, '');
    }
}

/** `es` → `es-ES,es;q=0.9,en;q=0.8` — keeps the Accept-Language header coherent with the domain. */
export function acceptLanguageFor(s: EbaySite): string {
    const primary = `${s.lang}-${s.countryCode}`;
    return s.lang === 'en'
        ? `${primary},${s.lang};q=0.9`
        : `${primary},${s.lang};q=0.9,en;q=0.8`;
}
