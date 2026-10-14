/*
Unified eBay scraper supporting three modes.
Input: {
  "mode": "product_only" | "seller_only" | "product_and_seller",
  "startUrls": [ "<url>", ... ]
}

Flows (∥ = runs concurrently; every branch starts as soon as its input is known — see
record-assembly.ts — and the record is pushed once the last branch settles):
  product_only         ITEM (∥ DESCRIPTION fetch ∥ review samples: negative ∥ positive ∥ neutral)
  seller_only          (SELLER_HUB if hub URL →) SELLER_STORE (shop ∥ feedback tab ∥ about tab,
                        then seller review samples: negative ∥ positive ∥ neutral)
  product_and_seller   both of the above, the seller branch started by ITEM straight off the
                        first paint of the product page

Nothing is rendered on the happy path. Every page — item, seller hub, store shop/feedback/about
tabs, review samples — is fetched as HTML through a browser session parked on the marketplace's
/robots.txt (the "anchor", see anchorPageFor) and read with cheerio (html-fetch.ts,
page-parsers.ts). When eBay will not serve a page that way it is rendered instead: ITEM, SELLER_HUB
and SELLER_STORE on their own Crawlee page (loadPage), a store tab on a page of its own, review
samples as an ITEM_REVIEWS / SELLER_REVIEWS request.

Response shape is stable across modes. Fields not applicable to a given mode are null:
  - product_only  →  seller = null, sellerRef = null, sellerTechnical = null
  - seller_only   →  product = null, technical = null
*/
import 'dotenv/config';

import { Actor, log as runLog } from 'apify';
import * as cheerio from "cheerio";
import { Dataset, type Log, PlaywrightCrawler, ProxyConfiguration } from "crawlee";
import fsSync from "fs";
import fs from "fs/promises";
import got from "got";
import countries from "i18n-iso-countries";
import type { BrowserContext, Page, Request as PlaywrightRequest } from "playwright";

import { currentActorRunId } from "./actor-run.js";
import type {
    ActorInput,
    CaptureMode,
    DetailedRatings,
    FeedbackSummary,
    ParsedCurrency,
    ProductImage,
    RequestUserData,
    ReviewSample,
    ScrapedItem,
    ShippingOption,
    Specification,
} from "./dto/index.js";
import {
    acceptLanguageFor,
    DEFAULT_SITE,
    type EbaySite,
    isEbayUrl,
    siteFor,
    storeBaseUrl,
} from "./ebay-sites.js";
import {
    auditExtraction,
    logExtractionReport,
    SCRAPED_ITEM_CHECKS,
} from "./extraction-audit.js";
import { fetchHtml } from "./html-fetch.js";
import {
    buildAllItemsFeedbackUrls,
    buildSellerFeedbackUrls,
    hasReviewContent,
    isCaptchaUrl,
    readHubSellerUrl,
    readItemRatings,
    readItemReviewSamples,
    readItemSellerLink,
    readSellerReviewSamples,
    readStoreAbout,
    readStoreFeedback,
    readStoreItems,
} from "./page-parsers.js";
import { parseAmount, parseCount, parseCurrency } from "./parse-currency.js";
import { type AssemblyState, type Branch, BRANCH_BY_LABEL, RecordAssembler } from "./record-assembly.js";
import {
    blankScrapedItem,
    blockedError,
    detectProductGone,
    isGoneStatus,
    isSellerAlive,
    isWalled,
    markFailure,
    STATUS_SELECTORS,
} from "./scrape-status.js";

const en = JSON.parse(fsSync.readFileSync('./node_modules/i18n-iso-countries/langs/en.json', 'utf8'));

/**
 * Single exit point for the dataset: audits the record against SCRAPED_ITEM_CHECKS so a silent
 * selector break shows up as `extraction.missingFields` instead of an unexplained `null`.
 *
 * Records that already carry a failure skip the audit — a listing we know is gone has nothing to
 * audit, and a report claiming twenty broken selectors would bury the one fact that matters. Their
 * `extraction.checkedFields` stays at 0, which is how "not audited" reads in the dataset.
 */
async function pushScrapedItem(scrappedItem: ScrapedItem, log: Log): Promise<void> {
    if (scrappedItem.success) {
        scrappedItem.extraction = auditExtraction(scrappedItem, SCRAPED_ITEM_CHECKS);
        logExtractionReport(scrappedItem.extraction, log, scrappedItem.url);
        // A page that parsed but produced none of its critical fields is a failed capture, not a
        // healthy record with a footnote — the caller should not treat those numbers as real.
        if (scrappedItem.extraction.status === 'broken') {
            markFailure(
                scrappedItem,
                'EXTRACTION_BROKEN',
                `Critical fields absent, likely an eBay markup change: ${scrappedItem.extraction.missingFields.join(', ')}`,
            );
        }
    } else {
        log.warning(`push ${scrappedItem.errorCode} — ${scrappedItem.errorMessage}`, { url: scrappedItem.url });
    }
    await Dataset.pushData(scrappedItem);
}
countries.registerLocale(en);

function getEstimatedDaysLeft(dateText: string): number {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const currentYear = today.getFullYear();
    let targetDate = new Date(`${dateText} ${currentYear}`);
    if (targetDate < today) {
        targetDate = new Date(`${dateText} ${currentYear + 1}`);
    }
    const diffMs = targetDate.getTime() - today.getTime();
    return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

/** The four detailed seller ratings, in the order eBay renders them on every marketplace. */
const DSR_ORDER = ['accurateDescription', 'shippingCost', 'shippingSpeed', 'communication'] as const;

/** Store-card stats other than the percentage, in the order eBay renders them. */
const STORE_STAT_ORDER = ['itemsSold', 'followers'] as const;

/** English DSR label → key. Only matches on ebay.com; elsewhere the caller falls back to position. */
function DSR_KEY_BY_LABEL(label: string | null): (typeof DSR_ORDER)[number] | null {
    const text = label?.toLowerCase() ?? '';
    if (text.includes('accurate')) return 'accurateDescription';
    if (text.includes('shipping cost')) return 'shippingCost';
    if (text.includes('shipping speed')) return 'shippingSpeed';
    if (text.includes('communication')) return 'communication';
    return null;
}

/**
 * Which feedback bucket a `.rating-element` belongs to.
 *
 * The label beside it is translated ("Positivos" on ebay.es), so the href is the real key: eBay
 * puts `commentType=POSITIVE` and `overall_rating:POSITIVE` in it verbatim on every marketplace.
 * The label is only a fallback, matched on the stem shared by the Romance and Germanic spellings
 * (positive/positivos/positif/positiv/positivi) with accents stripped.
 */
function feedbackTypeOf(href: string | null, label: string | null): 'positive' | 'neutral' | 'negative' | null {
    const fromHref = href?.match(/(POSITIVE|NEUTRAL|NEGATIVE)/i)?.[1];
    if (fromHref) return fromHref.toLowerCase() as 'positive' | 'neutral' | 'negative';

    const stem = (label ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (stem.startsWith('positi')) return 'positive';
    if (stem.startsWith('negati')) return 'negative';
    if (stem.startsWith('neutr')) return 'neutral';
    return null;
}

/**
 * Open one of the store tabs (`shop` / `feedback` / `about`) and wait for its content.
 *
 * These tabs used to be found by their English label — `textContent === 'feedback'` — which quietly
 * did nothing on every non-English marketplace: ebay.es renders "Valoraciones", so the click never
 * fired, `.rating-element` never appeared, and the seller's whole feedback section came back empty
 * with a single warning line to show for it.
 *
 * eBay keys each tab with a `_tab` query param (`/str/{slug}?_tab=feedback`), identical on every
 * marketplace, so we load that URL rather than hunting for a control to click.
 *
 * Clicking is not an option worth keeping: the tab controls are `div[role="tab"]` carrying only the
 * translated label and no href, so the only clickable thing pointing at a tab is an incidental
 * anchor elsewhere on the page (the store card's "97.7% positive feedback" link points at the
 * feedback tab; nothing points at the about tab). And that anchor is a real `<a href>`, so clicking
 * it costs the same full page load a `goto` does. One code path, same request count, and no
 * dependence on an anchor eBay never promised to keep.
 *
 * Each tab gets its own `page` in the store's browser context (same cookies, proxy and session), so
 * the shop, feedback and about tabs load concurrently instead of one `goto` after another.
 *
 * `landedUrl` is the store URL the crawler actually landed on, so the tabs keep whatever
 * marketplace and redirect we ended up on; any `_tab` already in it is overwritten.
 *
 * Returns whether the tab's content actually materialised.
 */
async function openStoreTab(
    page: Page,
    landedUrl: string,
    tab: 'feedback' | 'about',
    readySelector: string,
    log: Log,
): Promise<boolean> {
    try {
        const target = new URL(landedUrl);
        target.searchParams.set('_tab', tab);
        log.info(`SELLER_STORE: loading ${tab} tab → ${target.toString()}`);
        await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector(readySelector, { timeout: 30000 }).catch(() => {});
    } catch (err) {
        log.warning(`SELLER_STORE: ${tab} tab navigation failed`, { error: (err as Error).message });
    }
    return !page.isClosed() && (await page.$(readySelector).catch(() => null)) !== null;
}

/**
 * Whether fetched item HTML is a page we can use without rendering: the listing itself, or eBay's
 * definitive "this listing is gone" layout (which the handler records as such).
 */
function isItemPage($: cheerio.CheerioAPI): boolean {
    return $(STATUS_SELECTORS.productTitle).length > 0
        || $(STATUS_SELECTORS.productPrice).length > 0
        || detectProductGone($) !== null;
}

/**
 * What a fetched item page is missing that a second fetch usually brings back, or `null` when it
 * is complete (see the refetch in the ITEM handler).
 */
function itemPageGap($: cheerio.CheerioAPI, needSeller: boolean): string | null {
    // Some responses come without the seller card; only a page with no seller link anywhere
    // (see readItemSellerLink) is worth fetching again.
    if (needSeller && !readItemSellerLink($, itemPageData($))) {
        return 'seller link came back missing';
    }
    if ($('.x-feedback-detail-list').length > 0 && $('.fdbk-detail-list').length === 0) {
        return 'feedback module came back empty (the lighter page variant)';
    }
    // Every listing has at least one gallery image, so a blob without one is a partial document.
    if (!itemPageData($).includes('VIImageType')) return 'page data blob came back without the gallery';
    return null;
}

/** The `$i18n` script blob that carries an item page's gallery, payments and seller data. */
function itemPageData($: cheerio.CheerioAPI): string {
    return $('script').toArray().map((el) => $(el).html() || '').find((t) => t.includes('Object.assign($i18n=window.$i18n')) ?? '';
}

/**
 * The product's review-filter URLs ("This item" panel only), read off an already-parsed DOM.
 *
 * The feedback module has two tabs ("This item" / "All items"), each with its own filter dropdown
 * pre-rendered in the DOM, so scope to the "This item" panel to avoid picking up "All items" URLs.
 * eBay replaced the native `<select name="feedbackFilterDropdown">` with a custom
 * "fake-menu-button" widget rendering `<a>` items with hrefs; both are read.
 */
function productFeedbackUrls(
    $: cheerio.CheerioAPI,
    baseUrl: string,
): { negative: string | null; positive: string | null; neutral: string | null } {
    const urls: { negative: string | null; positive: string | null; neutral: string | null } = {
        negative: null, positive: null, neutral: null,
    };
    let panelId: string | undefined;
    $('.fdbk-detail-list [role="tab"]').each((_i, tab) => {
        if (!/^This item/i.test($(tab).text().trim())) return true;
        panelId = $(tab).attr('aria-controls');
        return false;
    });
    const linkSelector = 'a.fake-menu-button__item[href], select[name="feedbackFilterDropdown"] option';
    const panel = panelId ? $(`[id="${panelId}"]`) : null;
    const links = panel?.length ? panel.find(linkSelector) : $(linkSelector);
    links.each((_i, el) => {
        const raw = $(el).attr('href') || $(el).attr('value') || '';
        if (!raw) return;
        let val: string;
        try { val = new URL(raw, baseUrl).toString(); } catch (_) { return; }
        if (val.includes('commentType=NEGATIVE')) urls.negative = val;
        else if (val.includes('commentType=POSITIVE')) urls.positive = val;
        else if (val.includes('commentType=NEUTRAL')) urls.neutral = val;
    });
    return urls;
}

function makePhaseLogger(log: Log, label: string): (name: string) => void {
    const t0 = Date.now();
    let last = t0;
    return (name: string) => {
        const now = Date.now();
        const step = ((now - last) / 1000).toFixed(2);
        const total = ((now - t0) / 1000).toFixed(2);
        log.info(`[${label}] ${name} | step=${step}s | total=${total}s`);
        last = now;
    };
}

const VALID_MODES = ['product_only', 'seller_only', 'product_and_seller'];

/** Requests in flight at once unless the input says otherwise. */
const DEFAULT_MAX_CONCURRENCY = 10;
/**
 * Requests sharing one browser, and so one proxy session / exit IP. Kept low on purpose: at 10
 * requests through one IP eBay started serving pages without the seller card (2 of 11 items, both
 * fetches) — at 3 per IP it had not happened in 40 fetches.
 */
const PAGES_PER_BROWSER = 3;

type FeedbackType = 'negative' | 'positive' | 'neutral';
const FEEDBACK_TYPES: FeedbackType[] = ['negative', 'positive', 'neutral'];
type FeedbackUrls = Record<FeedbackType, string | null>;

// Running via tsx/esbuild wraps named functions with a `__name()` helper that
// only exists in the Node module scope. When such functions are serialized into
// the browser via page.evaluate(), `__name` is undefined there → ReferenceError.
// We define a no-op shim in every page of a context once (covers the secondary
// review pages opened via context.newPage() too). Harmless under `node dist`.
const namedShimContexts = new WeakSet<object>();

/**
 * Headers and init scripts every eBay page gets before it loads anything — what the pre-navigation
 * hook used to do inline, shared now with the pages that skip Crawlee's navigation.
 */
async function preparePage(page: Page, site: EbaySite): Promise<void> {
    // NOTE: do NOT use page.route() to block images/fonts/etc on eBay.
    // It changes the resource-loading fingerprint and Akamai serves
    // /splashui/captcha challenges on /fdbk/* (review/feedback) endpoints.
    // Tested 2026-05-07: blocking caused all review URLs to hit captcha.
    await page.setExtraHTTPHeaders({
        // Must agree with the domain — an en-US header on ebay.es is an odd pairing that
        // costs us fingerprint coherence for a page eBay serves in Spanish regardless.
        'Accept-Language': acceptLanguageFor(site),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Upgrade-Insecure-Requests': '1',
    });
    const context = page.context();
    if (!namedShimContexts.has(context)) {
        namedShimContexts.add(context);
        await context.addInitScript(() => {
            const g = globalThis as unknown as { __name?: (fn: unknown) => unknown };
            if (!g.__name) g.__name = (fn) => fn;
        });
    }
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        (window as unknown as { chrome: unknown }).chrome = { runtime: {} };
    });
}

/**
 * One long-lived page per browser context and marketplace, parked on that marketplace's
 * `/robots.txt`.
 *
 * Item pages are fetched as HTML from inside it (html-fetch.ts). `fetch()` is bound by CORS, so
 * all the anchor has to be is a document on the marketplace's origin — it does not need to be a
 * rendered eBay page. Probed 2026-10-14 with a fresh browser per scenario: `/robots.txt` (no JS,
 * ~0.4s), the homepage (which answers 403 to a fresh session) and the homepage plus a 2s wait all
 * got `/itm/` back 200 and complete. Akamai's edge sets its `bm_*` cookies on every response, and
 * no scenario ever earned the sensor's `_abck`, so what eBay trusts is that the request comes
 * from a real Chrome, not a warm-up. The homepage warm-up it replaces cost 8.6s through the
 * residential proxy.
 *
 * Resolves to `null` when the anchor will not load cleanly; the caller then renders.
 */
const anchorPages = new WeakMap<BrowserContext, Map<string, Promise<Page | null>>>();

async function anchorPageFor(context: BrowserContext, site: EbaySite, log: Log): Promise<Page | null> {
    let byOrigin = anchorPages.get(context);
    if (!byOrigin) {
        byOrigin = new Map();
        anchorPages.set(context, byOrigin);
    }
    const cached = byOrigin.get(site.origin);
    if (cached) {
        return cached.then(async (anchor) => {
            if (anchor && !anchor.isClosed()) return anchor;
            // Closed (or never opened): forget it so this and later calls open a fresh one.
            if (byOrigin.get(site.origin) === cached) byOrigin.delete(site.origin);
            return anchorPageFor(context, site, log);
        });
    }
    const opening = (async () => {
        const t0 = Date.now();
        const anchor = await context.newPage();
        try {
            await preparePage(anchor, site);
            const res = await anchor.goto(`${site.origin}/robots.txt`, { waitUntil: 'domcontentloaded', timeout: 30000 });
            if (isCaptchaUrl(anchor.url()) || (res && res.status() >= 500)) {
                throw new Error(`anchor answered ${res?.status()} at ${anchor.url()}`);
            }
            log.info(`ANCHOR: ${site.host} ready in ${Date.now() - t0}ms (robots.txt, status ${res?.status()})`);
            return anchor;
        } catch (err) {
            log.warning(`ANCHOR: could not open ${site.host}, items there will be rendered`, { error: (err as Error).message });
            await anchor.close().catch(() => {});
            return null;
        }
    })();
    byOrigin.set(site.origin, opening);
    // A failed anchor is retried on the next item rather than cached for the browser's lifetime.
    void opening.then((anchor) => { if (!anchor && byOrigin.get(site.origin) === opening) byOrigin.delete(site.origin); });
    return opening;
}

interface LoadedPage {
    $: cheerio.CheerioAPI;
    /** Where we actually landed, after redirects. */
    url: string;
    status: number | undefined;
    /** A page on the landed origin whose session can fetch further HTML (html-fetch.ts). */
    htmlPage: Page;
    rendered: boolean;
}

/**
 * Load the URL of a request that skips Crawlee's navigation (ITEM, SELLER_HUB, SELLER_STORE).
 *
 * Fetched as HTML through the session's anchor page when eBay serves it that way and `isReady`
 * finds what the handler needs; otherwise rendered on `page`, waiting up to `waitMs` for
 * `waitSelector` the way these handlers always did. A rendered 403/429 or a landing on eBay's
 * challenge page is the bot wall and throws for a retry on a fresh session — the check Crawlee's
 * own navigation made before these requests stopped using it. A 404/410 comes back for the caller
 * to record as gone.
 */
async function loadPage(
    page: Page,
    url: string,
    opts: { label: string; isReady: ($: cheerio.CheerioAPI) => boolean; waitSelector: string; waitMs: number },
    log: Log,
): Promise<LoadedPage> {
    const site = siteFor(url);
    const anchor = await anchorPageFor(page.context(), site, log);
    const fetched = anchor ? await fetchHtml(anchor, url, opts.isReady, log, opts.label) : null;
    if (fetched) return { $: fetched.$, url: fetched.url, status: 200, htmlPage: anchor!, rendered: false };

    log.info(`${opts.label}: rendering in the browser`, { url });
    const t0 = Date.now();
    await preparePage(page, site);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const status = response?.status();
    log.info(`${opts.label}: rendered navigation answered HTTP ${status} in ${Date.now() - t0}ms`, { url: page.url() });
    if (status === 403 || status === 429) throw blockedError(status, true);
    // The challenge pages answer 200 and carry eBay's header, so without this a walled store would
    // read as a store that does not exist (SELLER_NOT_FOUND) instead of a retry.
    if (isCaptchaUrl(page.url())) throw blockedError(status, true);
    if (!isGoneStatus(status)) {
        await page.waitForSelector(opts.waitSelector, { timeout: opts.waitMs })
            .catch(() => log.warning(`${opts.label}: "${opts.waitSelector}" not rendered within ${opts.waitMs / 1000}s`, { url }));
        log.info(`${opts.label}: rendered page ready in ${Date.now() - t0}ms`);
    }
    return { $: cheerio.load(await page.content()), url: page.url(), status, htmlPage: page, rendered: true };
}

void (async () => {
    await Actor.init();

    // Printed once, up front: every pushed record carries this id, so the log and the dataset can be
    // lined up from either end.
    runLog.info(`Actor run ID: ${currentActorRunId() ?? '(none — running locally)'}`);

    let mode: CaptureMode = 'product_and_seller';
    let inputUrls: string[] = [];
    let maxConcurrency = DEFAULT_MAX_CONCURRENCY;
    try {
        const input = await Actor.getInput<ActorInput>();
        mode = input?.mode || 'product_and_seller';
        inputUrls = input?.startUrls || input?.productUrls || input?.sellerUrls || [];
        if (input?.maxConcurrency !== undefined) {
            const requested = Math.round(Number(input.maxConcurrency));
            maxConcurrency = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 50) : DEFAULT_MAX_CONCURRENCY;
            if (maxConcurrency !== input.maxConcurrency) {
                runLog.warning(`maxConcurrency ${input.maxConcurrency} is out of range, using ${maxConcurrency}`);
            }
        }
    } catch (err) {
        console.error("Failed to read input:", err);
        return;
    }

    if (!VALID_MODES.includes(mode)) {
        console.error(`Invalid mode: ${mode}. Must be one of ${VALID_MODES.join(', ')}`);
        return;
    }

    if (inputUrls.length === 0) {
        console.log("No startUrls provided!");
        return;
    }

    // eBay serves every marketplace (ebay.com, ebay.es, ebay.de, …) from the same markup, so a
    // foreign host would silently produce an all-null record rather than an error. Reject it here.
    const rejected = inputUrls.filter(u => !isEbayUrl(u));
    if (rejected.length) {
        console.error(`Not eBay URLs, ignoring: ${rejected.join(', ')}`);
        inputUrls = inputUrls.filter(u => isEbayUrl(u));
        if (inputUrls.length === 0) return;
    }

    // Records being assembled by concurrently running branches — persisted, so a migration resumes
    // them the way the old userData relay did.
    const records = new RecordAssembler(
        await Actor.useState<AssemblyState>('RECORDS_IN_PROGRESS', {}),
        pushScrapedItem,
    );

    // A seller_only record starts from the input URL alone; the seller handlers create it on first
    // contact, keyed by that URL.
    const sellerSeed = (trimmed: string) => {
        const seed = blankScrapedItem(trimmed, mode);
        const seedSeller = seed.seller!;
        seedSeller.profileUrl = trimmed;
        const slugMatch = trimmed.match(/\/(?:str|usr)\/([^/?]+)/i);
        if (slugMatch) seedSeller.ebayUsername = slugMatch[1];
        return seed;
    };

    // Build startUrls based on mode
    let startUrls;
    if (mode === 'seller_only') {
        startUrls = inputUrls.map(url => {
            // Strips `_tab`/tracking off a /str/ or /usr/ URL; leaves a hub URL's query intact.
            const trimmed = storeBaseUrl(url);
            const isHub = /\/sch\/i\.html/i.test(trimmed) || /\/sch\/[^/]+\/m\.html/i.test(trimmed);
            return {
                url: trimmed,
                label: isHub ? 'SELLER_HUB' : 'SELLER_STORE',
                // Loaded through loadPage(), like ITEM.
                skipNavigation: true,
                userData: isHub ? { recordId: trimmed } : { recordId: trimmed, sellerBaseUrl: trimmed }
            };
        });
    } else {
        // product_only and product_and_seller both start at ITEM, on the caller's URL untouched.
        //
        // This used to append `rt=nc&_ipg=1&location=US`. All three were dropped after probing
        // ebay.es and ebay.com on 2026-08-19:
        //   _ipg=1    a /sch/ search param (items per page); meaningless on an item page.
        //   location  inert — US vs DE vs absent gave byte-identical price, shipping and delivery
        //             blocks. What drives the delivery estimate and the converted price is the
        //             proxy exit IP, which the marketplace registry sets.
        //   rt=nc     undocumented; present since the initial commit with no stated reason, never
        //             emitted by eBay's own markup, and made no difference on active listings.
        //             Folklore says "redirect type = no cache" — a guard against an ended listing
        //             bouncing to a similar-items page — but that stayed unverified, since the
        //             search page needed to harvest an ended item id sits behind the bot wall.
        //             If ended listings ever start redirecting, this is the first thing to retry.
        //
        // Adding nothing keeps every caller param authoritative (`?var=` picks a listing variation)
        // and lets the pushed record carry the URL the caller actually asked for.
        startUrls = inputUrls.map(url => {
            console.log(`ITEM start URL: ${url}`);
            return {
                url,
                label: 'ITEM',
                // The handler fetches the item as HTML through an anchor page on the origin and only
                // navigates (renders) this page itself when that is refused.
                skipNavigation: true,
                userData: {}
            };
        });
    }

    // ── Proxy: exit country follows the marketplace ──
    // A US residential IP on ebay.es loads, but eBay then quotes US delivery estimates and converts
    // prices to USD, so the record describes a listing no Spanish buyer would see. One proxy
    // configuration per country in the run, dispatched per request by hostname.
    const runCountries = [...new Set(startUrls.map(r => siteFor(r.url).countryCode))];
    const proxyByCountry = new Map<string, ProxyConfiguration>();
    for (const countryCode of runCountries) {
        try {
            const conf = await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'], countryCode });
            if (conf) proxyByCountry.set(countryCode, conf);
        } catch (err) {
            // Not every residential country is available on every plan — fall back rather than die.
            console.warn(`Proxy country ${countryCode} unavailable: ${(err as Error).message}`);
        }
    }
    const fallbackProxy = proxyByCountry.get(DEFAULT_SITE.countryCode) ?? [...proxyByCountry.values()][0];

    // Without an Apify token there is no proxy at all — keep running direct, as before.
    const proxyConfiguration = fallbackProxy
        ? new ProxyConfiguration({
            newUrlFunction: async (sessionId, options) => {
                const url = options?.request?.url;
                const conf = (url ? proxyByCountry.get(siteFor(url).countryCode) : null) ?? fallbackProxy;
                return (await conf.newUrl(sessionId)) ?? null;
            },
        })
        : undefined;
    console.log(`Using Apify RESIDENTIAL proxy, countries: ${[...proxyByCountry.keys()].join(', ') || 'none'}`);

    // ITEM requests are the caller's own URLs, so their record is keyed by the request itself; every
    // request a record spawns afterwards carries that key in userData.
    const recordIdOf = (request: { uniqueKey: string; userData: Record<string, unknown> }) =>
        (request.userData as RequestUserData).recordId ?? request.uniqueKey;

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        requestHandlerTimeoutSecs: 300,
        // A request is mostly HTML fetches now (only the anchor is a rendered page), so far more
        // of them fit at once than when every one rendered its listing.
        minConcurrency: 1,
        maxConcurrency,
        // Start at full concurrency. The pool otherwise starts at minConcurrency and grows by 5%
        // every 10s, so the seller branch ITEM enqueues off the first paint sat in the queue until
        // the item request finished — 8.7s of a 37s run through the residential proxy. The pool
        // still scales down on its own if the machine runs short of CPU or memory.
        autoscaledPoolOptions: { desiredConcurrency: maxConcurrency },
        browserPoolOptions: {
            // Every page of a browser shares its proxy session — one exit IP — and each request
            // fans out into 3-4 fetches. Capping pages per browser spreads a high concurrency over
            // several browsers, so several IPs, each with its own anchor page.
            maxOpenPagesPerBrowser: PAGES_PER_BROWSER,
        },
        maxRequestRetries: 5,
        useSessionPool: true,
        sessionPoolOptions: { maxPoolSize: 20 },
        // eBay constantly swaps ad/payment iframes; walking them in parseWithCheerio
        // races the DOM and produces "Frame was detached" warnings. We never read
        // iframe content here, so skip the walk entirely.
        ignoreIframes: true,
        launchContext: {
            launchOptions: {
                headless: false,
                args: ['--disable-blink-features=AutomationControlled'],
            },
        },
        preNavigationHooks: [
            async ({ page, request }) => {
                const site = siteFor(request.url);
                // Only the rendered fallbacks (ITEM_REVIEWS / SELLER_REVIEWS) still navigate through
                // Crawlee. ITEM, SELLER_HUB and SELLER_STORE skip it and load via loadPage(); the
                // homepage warm-up that used to run here for them turned out to be unnecessary.
                await preparePage(page, site);
            }
        ],
        postNavigationHooks: [
            async ({ page, request, response, log }) => {
                const status = response?.status();
                if (!status || status < 400) return;
                // 404/410 is eBay's normal answer for a removed listing/store, not an anti-bot
                // problem — the handlers turn it into a NOT_FOUND record, so no forensics needed.
                if (isGoneStatus(status)) {
                    log.info(`POST-NAV ${status} on ${request.url} — page removed from eBay`, { label: request.label });
                    return;
                }
                const headers = response!.headers();
                log.error(`POST-NAV ${status} on ${request.url}`, {
                    label: request.label,
                    retryCount: request.retryCount,
                    cfRay: headers['cf-ray'] || null,
                    server: headers.server || null,
                    contentType: headers['content-type'] || null,
                    xEbayC: headers['x-ebay-c-tracking'] || null,
                });
                const body = await response!.text().catch(() => '');
                log.error(`Response body snippet (first 800 chars)`, { snippet: body.slice(0, 800) });
                const screenshotPath = `debug_403_${Date.now()}.png`;
                await page.screenshot({ path: screenshotPath, fullPage: false }).catch((e: unknown) => {
                    log.warning(`Screenshot failed: ${(e as Error).message}`);
                });
                log.error(`Screenshot saved → ${screenshotPath}`);
            },
        ],
        // A request that exhausts its retries used to vanish from the dataset entirely, so a caller
        // could not tell "eBay blocked us" from "we never got asked to scrape it". Settle the branch
        // with the reason, so the record still ships with whatever the other branches assembled —
        // or, when no handler ever got to start one, push an empty record of the right shape.
        failedRequestHandler: async ({ request, log }, error) => {
            const message = error?.message || 'Unknown error';
            log.error(`Request failed: ${request.url}`, {
                label: request.label,
                retryCount: request.retryCount,
                error: message,
            });
            // `blockedError` and the navigation timeouts that follow a bot wall are the same story:
            // eBay would not serve us the page. Anything else is a plain navigation failure.
            const blocked = /blocked|captcha|403|429|Timeout/i.test(message);
            const code = blocked ? 'BLOCKED' : 'NAVIGATION_FAILED';
            const detail = `${request.label ?? 'REQUEST'} gave up after ${request.retryCount} retries on ${request.url}: ${message}`;

            const recordId = recordIdOf(request);
            const branch = BRANCH_BY_LABEL[request.label ?? ''];
            if (branch && records.has(recordId)) {
                await records.fail(recordId, branch, code, detail, log);
                return;
            }
            const scrappedItem = mode === 'seller_only' ? sellerSeed(recordId) : blankScrapedItem(request.url, mode);
            markFailure(scrappedItem, code, detail);
            await pushScrapedItem(scrappedItem, log);
        },
    });

    // ──────────────────── ITEM ────────────────────
    crawler.router.addHandler("ITEM", async ({ page, request, log }) => {
        const phase = makePhaseLogger(log, 'ITEM');
        phase('handler start');

        // Extract item ID from URL up-front (no page load needed) so we can
        // kick off the description HTTP fetch in parallel with the Playwright
        // page work. The ~1-3.5s of network latency hides inside the page-load
        // time entirely instead of being added on at the end.
        const platformMatch = request.url.match(/\/itm\/(?:[^/]+\/)?(\d+)/);
        const platformItemId = platformMatch ? platformMatch[1] : null;
        const requestSite = siteFor(request.url);

        // Opened first, so the review and seller branches started below have a record to write
        // into while this handler is still parsing. A retry reuses it as the branches left it.
        const recordId = recordIdOf(request);
        records.open(recordId, 'ITEM', () => blankScrapedItem(request.url, mode, platformItemId));
        const record = records.get(recordId);

        // Plain `got` (not gotScraping) — itm.ebaydesc.com has no Akamai, no
        // browser fingerprint needed. No proxy needed either. The host is shared by every
        // marketplace; `lang` is what selects the seller's localized description.
        const descriptionPromise = platformItemId
            ? got({
                url: `https://itm.ebaydesc.com/itmdesc/${platformItemId}?lang=${requestSite.lang}`,
                timeout: { request: 15000 },
                headers: { referer: request.url },
                throwHttpErrors: false,
                retry: { limit: 1 },
            }).catch((err: unknown) => {
                log.warning(`DESCRIPTION fetch failed: ${(err as Error).message}`, { itemId: platformItemId });
                return null;
            })
            : Promise.resolve(null);

        // [technical] temporarily commented out apiEndpoints collection
        // const apiEndpoints: string[] = [];
        // const requestTracker = (req: PlaywrightRequest) => {
        //     const resourceType = req.resourceType();
        //     if (resourceType === 'xhr' || resourceType === 'fetch') {
        //         apiEndpoints.push(req.url());
        //     }
        // };
        // page.on('request', requestTracker);

        // Everything the listing record needs is in the server-rendered HTML (raw vs rendered matched
        // field for field on 2026-10-14, rating histogram and delivery estimate included), so fetch
        // it through the session's anchor page instead of rendering this one.
        const loaded = await loadPage(page, request.url, {
            label: 'ITEM',
            isReady: isItemPage,
            // Resolve as soon as the critical listing DOM is painted (title + price). Falls through
            // after 20s max if eBay's slow; cheerio parsing tolerates partial DOM.
            waitSelector: 'h1.x-item-title__mainTitle, div.x-price-primary',
            waitMs: 20000,
        }, log);
        let { $ } = loaded;
        const { url: landedUrl, status: httpStatus, rendered } = loaded;
        // The page whose session fetches the review HTML — sits on the listing's origin.
        const { htmlPage } = loaded;
        phase(rendered ? 'main DOM rendered' : 'item fetched as HTML');

        // Listing removed from the platform: definitive, so record it and skip the rest.
        if (isGoneStatus(httpStatus)) {
            record.product!.isActive = false;
            await records.fail(recordId, 'ITEM', 'PRODUCT_NOT_FOUND', `eBay returned HTTP ${httpStatus} for this listing`, log);
            return;
        }

        // eBay's soft-404 / ended-listing layouts arrive with HTTP 200, so they can only be told
        // apart here, from the DOM.
        const goneReason = detectProductGone($);
        if (goneReason) {
            record.url = landedUrl;
            record.product!.isActive = false;
            await records.fail(recordId, 'ITEM', 'PRODUCT_NOT_FOUND', goneReason, log);
            return;
        }

        // Neither title nor price and no eBay chrome: this is the bot wall, not a listing. Throwing
        // hands it back to Crawlee for a retry on a fresh session — recording it as a null-filled
        // "successful" row is what used to make blocks look like markup changes.
        if ($(STATUS_SELECTORS.productTitle).length === 0 && $(STATUS_SELECTORS.productPrice).length === 0) {
            throw blockedError(httpStatus, !isWalled($));
        }

        // eBay does not always send the same /itm/ document. Seen on 2026-10-14: about 1 in 3
        // responses is a lighter variant whose feedback module ships empty (no request fills it in
        // later, rendered or not), and 2 in 30 came without the gallery/payments data in the
        // `$i18n` blob. Everything else on those pages matched, so one more fetch usually gets the
        // full document; a listing that genuinely has no item feedback just costs that one fetch.
        const needSeller = mode !== 'product_only';
        const incomplete = !rendered && itemPageGap($, needSeller);
        if (incomplete) {
            log.info(`ITEM: ${incomplete}, fetching once more`, { url: request.url });
            const again = await fetchHtml(htmlPage, request.url, ($doc) => isItemPage($doc) && !itemPageGap($doc, needSeller), log, 'ITEM (refetch)');
            if (again) $ = again.$;
            phase(again ? 'item re-fetched complete' : `item still incomplete (${incomplete}), using the first copy`);
        }

        // Re-resolve after navigation: the smaller marketplaces redirect to a bigger one, and from
        // here on every relative URL and currency default must follow where we actually landed.
        const site = siteFor(landedUrl);
        if (site.host !== requestSite.host) {
            log.info(`ITEM: redirected ${requestSite.host} → ${site.host}, following that marketplace`);
        }

        const {url} = request;
        // platformItemId already extracted at handler start (above) for parallel description fetch

        let mpn = $('dl.ux-labels-values--mpn dd.ux-labels-values__values span.ux-textspans').text().trim() || null;
        let upc = $('dl.ux-labels-values--upc dd.ux-labels-values__values span.ux-textspans').text().trim() || null;
        let ean = $('dl.ux-labels-values--ean dd.ux-labels-values__values span.ux-textspans').text().trim() || null;
        let modelNumber = $('dl.ux-labels-values--model dd.ux-labels-values__values span.ux-textspans').text().trim() || null;
        const title = $('h1[class="x-item-title__mainTitle"]').text().trim();
        const brandEl = $('dl.ux-labels-values--brand dd');
        let brand = brandEl.length ? brandEl.text().trim() || null : null;

        const scriptContent = $('script')
            .filter((i, el) => ($(el).html() || "").includes('Object.assign($i18n=window.$i18n'))
            .first()
            .html() || "";

        const sellerLink = readItemSellerLink($, scriptContent);
        const profileUrl = sellerLink?.href ?? null;
        const displayName = sellerLink?.name ?? null;
        const entityIdMatch = scriptContent.match(/"entity_id"\s*:\s*"~([^"]+)"/);
        const ebayUsername = entityIdMatch ? entityIdMatch[1] : null;

        let platformSellerId = null;
        if (profileUrl) {
            const strMatch = profileUrl.match(/\/str\/([^/?]+)/i);
            const usrMatch = profileUrl.match(/\/usr\/([^/?]+)/i);
            if (strMatch) platformSellerId = strMatch[1];
            else if (usrMatch) platformSellerId = usrMatch[1];
            else {
                try {
                    const parsed = new URL(profileUrl, site.origin);
                    const storeName = parsed.searchParams.get('store_name') || parsed.searchParams.get('_ssn');
                    if (storeName) platformSellerId = storeName;
                    else {
                        const schMatch = profileUrl.match(/\/sch\/([^/?]+)\/m\.html/i);
                        if (schMatch && schMatch[1] !== 'i.html') platformSellerId = schMatch[1];
                    }
                } catch (_) {}
            }
        }

        // The seller card is part of the first paint, so the whole seller branch can start now
        // instead of after this page and its reviews are done.
        if (record.seller) {
            // Seeded once: on a retry the seller branch may already have replaced these with what
            // the store page says.
            if (!record.seller.profileUrl) {
                if (profileUrl) {
                    try {
                        record.seller.profileUrl = new URL(profileUrl, site.origin).toString();
                    } catch (_) {
                        record.seller.profileUrl = profileUrl;
                    }
                } else if (ebayUsername) {
                    // No seller link anywhere even after the refetch, but the page data still names the
                    // seller. /usr/{username} is where the hub fallback lands for such sellers too.
                    record.seller.profileUrl = `${site.origin}/usr/${encodeURIComponent(ebayUsername)}`;
                    log.info(`ITEM: no seller link anywhere on the page, using the seller's profile from the page data → ${record.seller.profileUrl}`);
                }
                record.seller.displayName = displayName;
                record.seller.ebayUsername = ebayUsername;
            }
            record.sellerRef = { platformSellerId, displayName, ebayUsername };
            await startSellerBranch(recordId, record, log);
            phase('seller branch started');
        }

        // Same for the reviews, when their filter links are already in the server-rendered DOM;
        // otherwise they are looked for again once the feedback widget has had a chance to load.
        let reviewsTask = startItemReviews(recordId, htmlPage, productFeedbackUrls($, landedUrl), log);
        if (reviewsTask) phase('item reviews fetch started');

        await fs.writeFile('scriptContent.js', scriptContent).catch(err => console.error('Error logging script:', err));

        const rawPriceTexts: string[] = [];
        $('div.x-price-primary span.ux-textspans').each((_i, el) => {
            rawPriceTexts.push($(el).text().trim());
        });
        const prices: ParsedCurrency[] = [];
        rawPriceTexts.forEach(text => {
            text.split(/\s+to\s+/i).forEach(part => {
                const parsed = parseCurrency(part, site.currency);
                if (parsed) prices.push(parsed);
            });
        });
        const priceValues = prices.map(p => p.cost);
        const priceMin = priceValues.length ? Math.min(...priceValues) : null;
        const priceMax = priceValues.length ? Math.max(...priceValues) : null;
        // An unmarked amount belongs to the marketplace's currency, not to USD.
        const currency = prices[0]?.currency || site.currency;

        // When the listing is priced in a foreign currency, eBay renders the buyer-facing conversion
        // next to it ("Aproximadamente 78,57 EUR"). That is the number a local buyer actually sees,
        // so keep it alongside the listing price rather than choosing one over the other. Absent
        // whenever the listing already prices in the site currency.
        const approxText = $('.x-price-approx__price').text().trim() || null;
        const approx = parseCurrency(approxText, site.currency);
        const localized = approx && approx.currency !== currency ? approx : null;

        const breadcrumb: string[] = [];
        const categoryPathIds: string[] = [];
        $('a.seo-breadcrumb-text').each((i, el) => {
            breadcrumb.push($(el).find('span').text().trim());
            const match = $(el).attr('href')?.match(/\/b\/[^/]+\/(\d+)\//);
            if (match) categoryPathIds.push(match[1]);
        });
        const leafCategoryName = breadcrumb.length ? breadcrumb[breadcrumb.length - 1] : null;
        const leafCategoryId = categoryPathIds.length ? categoryPathIds[categoryPathIds.length - 1] : null;

        let availableQuantity: number | null = null;
        let soldCount: number | null = null;
        $('div.x-quantity__availability span').each((i, el) => {
            const text = $(el).text().trim();
            if (text.toLowerCase().includes("last one")) { availableQuantity = 1; return; }
            const numMatch = text.match(/([\d,]+)/);
            const num = numMatch ? parseInt(numMatch[1].replace(/,/g, ''), 10) : null;
            if (/available/i.test(text)) availableQuantity = num;
            if (/sold/i.test(text)) soldCount = num;
        });

        const conditionText = $('div.x-item-condition-text span.ux-textspans').first().text().trim();
        const returnPolicySummary = $('div.vim.x-returns-minview.mar-b-20 div.ux-labels-values__values-content')
            .find('span.ux-textspans').map((i, el) => $(el).text().trim()).get()
            .join(' ').replace(/\s+/g, ' ').trim()
            .replace("See details- for more information about returns", "").trim();

        const specifications: Specification[] = [];
        const seenSpecs = new Set<string>();
        // Two layouts in the wild: the legacy one puts every pair in its own
        // `dl[data-testid="ux-labels-values"]`, the newer "evo" one puts them all in a single
        // `dl.ux-layout-section-evo__item` split into `.ux-layout-section-evo__col` cells.
        // The dt/dd class names are identical in both, so one pass over either row container works.
        $('dl[data-testid="ux-labels-values"], .x-about-this-item .ux-layout-section-evo__col').each((i, el) => {
            const name = $(el).find('dt.ux-labels-values__labels').text().replace(/\s+/g, ' ').trim();
            // Clone the value cell and strip the collapsed hidden duplicate, screen-reader-only
            // (.clipped) text, and inline actions — e.g. Condition's "Read more" / "See all
            // condition definitions" / "opens in a new window or tab" — before reading text.
            const $value = $(el).find('dd.ux-labels-values__values').clone();
            $value.find('[aria-hidden="true"], .clipped, [data-testid="ux-action"]').remove();
            const value = $value.text().replace(/\s+/g, ' ').trim();
            if (!name || !value || seenSpecs.has(name.toLowerCase())) return;
            seenSpecs.add(name.toLowerCase());
            specifications.push({ name, value });
        });

        // The evo layout dropped the `ux-labels-values--<field>` modifier classes the selectors
        // above rely on, so fall back to the parsed specifics table for the identity fields.
        const specValue = (label: string) => specifications.find(s => s.name.toLowerCase() === label)?.value || null;
        brand ??= specValue('brand');
        mpn ??= specValue('mpn');
        upc ??= specValue('upc');
        ean ??= specValue('ean');
        modelNumber ??= specValue('model');
        const gtin = upc || ean || null;

        let itemLocationText = $('div.ux-labels-values--shipping').find('span.ux-textspans.ux-textspans--SECONDARY').text().trim() || null;
        let itemCountryCode: string | null = null;
        if (itemLocationText) {
            itemLocationText = itemLocationText.replace('Located in:', '').trim();
            const parts = itemLocationText.split(',');
            const country = parts[parts.length - 1].trim().replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
            itemCountryCode = countries.getAlpha2Code(country, "en") || null;
        }

        phase('cheerio metadata extracted');

        if (rendered) {
            await page.evaluate(() => {
                const el = document.querySelector('.x-feedback-detail-list, .ux-summary__start--rating, [class*="reviews"]');
                if (el) el.scrollIntoView();
            });
            // Reduced from 8s to 3s. Widget often lazy-loads beyond 3s but rating
            // data is non-critical and items without reviews never render the widget anyway.
            await page.waitForSelector('span.ux-summary__start--rating, div.ux-histogram__item--bar', { timeout: 3000 }).catch(() => {});
            $ = cheerio.load(await page.content());
            phase('rating section ready (scroll+wait)');
            if (!reviewsTask) {
                reviewsTask = startItemReviews(recordId, htmlPage, productFeedbackUrls($, landedUrl), log);
                if (reviewsTask) phase('item reviews fetch started (after feedback widget load)');
            }
        }
        if (!reviewsTask && platformItemId && ebayUsername && $('.x-feedback-detail-list').length > 0) {
            // The feedback module is there but lazy — eBay fills it with the seller's "All items"
            // filters after render. Build those links instead of rendering for them.
            log.info('ITEM: feedback module is lazy-loaded, building its filter links');
            reviewsTask = startItemReviews(recordId, htmlPage, buildAllItemsFeedbackUrls(site.origin, platformItemId, ebayUsername), log);
            if (reviewsTask) phase('item reviews fetch started (built links)');
        }
        if (!reviewsTask) log.warning('No product feedback URL found, skipping product reviews');

        const { rating, reviewCount, ratingBreakdown } = readItemRatings($);

        // Images from PICTURE.mediaList JSON. Each gallery image is a VIImageType
        // whose thumbnail carries the URL. IMPORTANT: only eBay-hosted images have
        // an "imageId"; the seller's own CloudFront images do NOT. The old regex
        // required "imageId" between title and URL, so for a CloudFront thumbnail
        // the lazy scan jumped forward to the next eBay image's imageId — swallowing
        // every image in between (91 gallery images collapsed to 2). We drop the
        // imageId requirement and use [^{}] to confine each match to inside the
        // thumbnail object so it can't skip across mediaList items.
        const mediaRegex = /"_type":"VIImageType","thumbnail":\{[^{}]*?"title":"([^"]+)"[^{}]*?"URL":"([^"]+)"/g;
        const images: ProductImage[] = [...scriptContent.matchAll(mediaRegex)]
            .filter((m) => !m[1].toLowerCase().includes("video"))
            // Upscale eBay thumbnails (s-l140) to full-res; CloudFront URLs (no size
            // variants) are left untouched by the replace.
            .map((m): ProductImage => ({ url: m[2].replace(/s-l140\.(webp|jpg|jpeg|png)/i, "s-l1600.$1") }));

        const paymentsSectionRegex = /"payments"\s*:\s*\{[\s\S]*?"values"\s*:\s*\[\s*\{[\s\S]*?"textSpans"\s*:\s*\[([\s\S]*?)\]\s*\}\s*\]/m;
        const paymentsMatch = scriptContent.match(paymentsSectionRegex);
        let paymentMethods: string[] = [];
        if (paymentsMatch) {
            const spanRegex = /"accessibilityText"\s*:\s*"([^"]+)"/g;
            paymentMethods = [...paymentsMatch[1].matchAll(spanRegex)].map(m => m[1]);
        }

        // [technical] temporarily commented out the entire technical processing
        // const scriptBlocks = await page.$$eval('script', scripts => scripts.map(s => s.textContent).filter(Boolean));
        // const scriptBlocks: unknown[] = [];
        // const jsonState: Record<string, unknown> = {};
        // scriptBlocks.forEach(script => {
        //     const match = script.match(/window\.__INITIAL_STATE__\s*=\s*(\{.*\});/);
        //     if (match) { try { jsonState.rootKeys = Object.keys(JSON.parse(match[1])); } catch (e) {} }
        // });

        // const dataAttributes = await page.$$eval('*', elements => {
        //     const result = {};
        //     elements.forEach(el => {
        //         for (const attr of el.attributes) {
        //             if (attr.name.startsWith('data-')) result[attr.name] = attr.value;
        //         }
        //     });
        //     return result;
        // });
        // const dataAttributes: Record<string, unknown> = {};

        // const googleAnalytics = await page.$$eval('script', (scripts: HTMLScriptElement[]) => {
        //     const ids: string[] = [];
        //     scripts.forEach(s => {
        //         if (s.src?.includes('googletagmanager')) {
        //             const m = s.src.match(/id=([A-Z0-9-]+)/);
        //             if (m) ids.push(m[1]);
        //         }
        //         if (s.textContent?.includes('gtag(')) {
        //             const m = s.textContent.match(/gtag\(['"]config['"],\s*['"]([A-Z0-9-]+)['"]\)/);
        //             if (m) ids.push(m[1]);
        //         }
        //     });
        //     return ids;
        // });

        // const facebookPixel = await page.$$eval('script', (scripts: HTMLScriptElement[]) => {
        //     const ids: string[] = [];
        //     scripts.forEach(s => {
        //         if (s.textContent?.includes('fbq(')) {
        //             const m = s.textContent.match(/fbq\(['"]init['"],\s*['"]([0-9]+)['"]\)/);
        //             if (m) ids.push(m[1]);
        //         }
        //     });
        //     return ids;
        // });

        // const urlObj = new URL(request.url);
        // const pageContext = {
        //     pageType: request.url.includes('/itm/') ? 'listing' : 'searchResults',
        //     searchQuery: urlObj.searchParams.get('_nkw'),
        //     position: 0, listingType: null, campaignId: null
        // };

        // const jsBundles = await page.$$eval('script[src]', (scripts: HTMLScriptElement[]) => scripts.map(s => s.src));
        // const cssBundles = await page.$$eval('link[rel="stylesheet"]', (links: HTMLLinkElement[]) => links.map(l => l.href));

        // phase('tracking IDs + bundles extracted');

        const shippingOptions: ShippingOption[] = [];

        // Fetched HTML already holds the delivery block; a rendered page may still be painting it.
        let $after = $;
        if (rendered) {
            await page.waitForSelector('div.ux-labels-values--deliverto .ux-labels-values__values-content', { timeout: 3000 })
                .catch(() => {});
            // [technical] page.off('request', requestTracker);
            $after = cheerio.load(await page.content());
        }

        // Extract shipping cost + method directly from the page DOM (no modal click).
        const shippingValuesFirstDiv = $after('div.ux-labels-values--shipping div.ux-labels-values__values-content > div').first();
        const deliveryBolds = $after('div.ux-labels-values--deliverto span.ux-textspans--BOLD');
        if (shippingValuesFirstDiv.length) {
            const costText = shippingValuesFirstDiv.find('span.ux-textspans--BOLD').first().text().trim();
            const methodText = shippingValuesFirstDiv.clone()
                .find('span.ux-textspans--BOLD, span.ux-textspans--SUPERSCRIPT, button').remove()
                .end()
                .text()
                .replace(/\s+/g, ' ')
                .trim()
                .replace(/\.\s*$/, '');

            // No amount in the cost cell means free shipping, whatever word the site prints for it
            // ("Free", "Gratis", "Kostenlos") — so key off the parse, not off English text.
            let shipCost = 0, shipCurrency = site.currency;
            const parsedShip = parseCurrency(costText, site.currency);
            if (parsedShip) { shipCost = parsedShip.cost; shipCurrency = parsedShip.currency; }

            const minDays = deliveryBolds.length >= 1 ? getEstimatedDaysLeft($after(deliveryBolds[0]).text().trim()) : null;
            const maxDays = deliveryBolds.length >= 2 ? getEstimatedDaysLeft($after(deliveryBolds[1]).text().trim()) : null;

            if (costText || methodText) {
                shippingOptions.push({
                    name: methodText,
                    cost: shipCost,
                    currency: shipCurrency,
                    estimatedDeliveryMinDays: minDays,
                    estimatedDeliveryMaxDays: maxDays
                });
            }
        }

        phase('shipping block done');

        // Pick the first inner div ("Estimated between <date> and <date>") inside the deliverto values content.
        // Must target the leaf div directly — selecting all descendants would also match ancestor divs whose
        // text concatenates the sibling "Ships today..." div.
        let deliveryTimeText: string | null = null;
        const deliveryDateDiv = $after('div.ux-labels-values--deliverto .ux-labels-values__values-content > div').first();
        if (deliveryDateDiv.length) {
            const text = deliveryDateDiv.clone()
                .find('.ux-textspans__custom-view').remove()
                .end()
                .text().trim().replace(/\s+/g, ' ');
            if (/^Estimated between\s/i.test(text)) {
                deliveryTimeText = text.replace(/\s+to\s+\d{4,5}(?:-\d{4})?\s*$/i, '');
            }
        }

        // Started right after the first paint; by now it has usually long finished.
        const fetchedSamples = (await reviewsTask) ?? {};
        phase('item reviews fetched');

        // Fill in the product on the record the branches are already writing into. Everything they
        // own — the review samples, the seller section, a failure one of them recorded — is kept.
        const sampleSoFar = record.product!.reviewsSummary;
        // The scraper adds no params of its own, so this is the caller's URL as landed on.
        record.url = landedUrl;
        record.product = {
            id: platformItemId,
            isActive: true,
            title, brand,
            pricing: { currency, priceMin, priceMax, localized },
            stock: { availableQuantity, soldCount },
            shipping: { deliveryTimeText },
            paymentMethods,
            description: { html: null, plainText: null },
            specifications,
            media: { images, videos: [] },
            reviewsSummary: {
                rating, reviewCount, ratingBreakdown,
                negativeReviewSamples: fetchedSamples.negative ?? sampleSoFar.negativeReviewSamples,
                positiveReviewSamples: fetchedSamples.positive ?? sampleSoFar.positiveReviewSamples,
                neutralReviewSamples: fetchedSamples.neutral ?? sampleSoFar.neutralReviewSamples,
            }
        };
        // [technical] temporarily commented out the technical processing
        // record.technical = {
        //     scriptBlocks, jsonState, dataAttributes,
        //     rawUrlParameters: Object.fromEntries(urlObj.searchParams.entries()),
        //     experimentIds: [], trackingIds: { googleAnalytics, facebookPixel },
        //     pageContext, fulfilmentCodes: [], jsBundles, cssBundles, apiEndpoints
        // };

        // Await the description fetch we kicked off at the top of the handler.
        // By now, ~5-10s of Playwright work has happened in parallel, so the
        // 1-3.5s HTTP fetch usually has already resolved (step≈0s).
        const descRes = await descriptionPromise;
        if (descRes && descRes.statusCode === 200 && descRes.body) {
            const $desc = cheerio.load(descRes.body);
            $desc('script, style').remove();
            record.product.description.html = $desc.html();
            record.product.description.plainText = $desc('body').text().replace(/\s+/g, ' ').trim();
        } else if (descRes) {
            log.warning(`DESCRIPTION fetch ${descRes.statusCode}`, { itemId: platformItemId });
        } else {
            log.warning('DESCRIPTION iframe fetch failed or item id unresolved', { itemId: platformItemId });
        }
        phase('description awaited (parallel got)');

        await records.settle(recordId, 'ITEM', log);
        phase('ITEM handler done');
    });

    // ──────────────────── ITEM_REVIEWS ────────────────────
    // Scrape negative + positive review samples in parallel on two pages
    // sharing the same browser context (cookies, proxy, session).
    crawler.router.addHandler("ITEM_REVIEWS", async ({ page, request, log }) => {
        const phase = makePhaseLogger(log, 'ITEM_REVIEWS');
        phase('handler start');

        const userData = request.userData as RequestUserData;
        const recordId = recordIdOf(request);
        const { negativeUrl, positiveUrl, neutralUrl } = userData;

        // eBay renders both "This item" and "All items" tabpanels in the DOM
        // (the inactive one only has `hidden=""`), so unscoped selectors mix
        // them. Each evaluate below scopes to the "This item" panel by tab text.
        const scrapeSamples = async (p: Page, label: string) => {
            try {
                await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await p.waitForFunction(() => {
                    const tab = [...document.querySelectorAll('[role="tab"]')]
                        .find(t => /^This item/i.test(t.textContent?.trim() || ''));
                    const panel = tab && document.getElementById(tab.getAttribute('aria-controls') || '') || document;
                    if (panel.querySelector('.fdbk-result-status')) return true;
                    const cards = panel.querySelectorAll('li.fdbk-container[data-testid*="feedback-cards"]');
                    if (cards.length === 0) return false;
                    return (cards[0].querySelector('.fdbk-container__details__comment span')?.textContent?.trim()?.length ?? 0) > 0;
                }, { timeout: 20000 }).catch(() => {
                    log.warning(`${label}: Expected content not found`, { url: p.url() });
                });
                return await p.evaluate(() => {
                    const tab = [...document.querySelectorAll('[role="tab"]')]
                        .find(t => /^This item/i.test(t.textContent?.trim() || ''));
                    const panel = tab && document.getElementById(tab.getAttribute('aria-controls') || '') || document;
                    const cards = panel.querySelectorAll('li.fdbk-container[data-testid*="feedback-cards"]');
                    const results: {
                        user: string | null;
                        userFeedbackScore: number | null;
                        comment: string | null;
                        commentDate: string | null;
                        ratingType: string | null;
                        verifiedPurchase: boolean;
                    }[] = [];
                    cards.forEach((card, i) => {
                        if (i >= 5) return;
                        const comment = card.querySelector('.fdbk-container__details__comment span')?.textContent?.trim() || null;
                        if (!comment) return;
                        const userRaw = card.querySelector('.fdbk-container__details__info__username span:not(.fb-clipped)')?.textContent?.trim() || null;
                        let user: string | null = null;
                        let userFeedbackScore: number | null = null;
                        if (userRaw) {
                            const m = userRaw.match(/^(.+?)\s*\((\d[\d,]*)\)\s*$/);
                            if (m) { user = m[1].trim(); userFeedbackScore = parseInt(m[2].replace(/,/g, ''), 10); }
                            else user = userRaw;
                        }
                        const commentDate = card.querySelector('.fdbk-container__details__info__divide__time span')?.textContent?.trim() || null;
                        const svg = card.querySelector('svg[data-test-type]');
                        const ratingType = svg?.getAttribute('data-test-type')?.toLowerCase() || null;
                        const verifiedPurchase = !!card.querySelector('.fdbk-container__details__verified__purchase');
                        results.push({ user, userFeedbackScore, comment, commentDate, ratingType, verifiedPurchase });
                    });
                    return results;
                });
            } catch (err) {
                log.error(`${label} failed`, { url: p.url(), error: (err as Error).message });
                return [];
            }
        };

        // `page` is already navigated by Crawlee to request.url (primary URL);
        // the other one or two feedback types are scraped on secondary pages
        // opened in the same browser context so all run concurrently.
        const feedbackTypes: { type: 'negative' | 'positive' | 'neutral'; url: string | null | undefined }[] = [
            { type: 'negative', url: negativeUrl },
            { type: 'positive', url: positiveUrl },
            { type: 'neutral', url: neutralUrl },
        ];
        const primaryType = feedbackTypes.find(t => t.url === request.url)?.type
            ?? feedbackTypes.find(t => t.url)!.type;
        const samplesByType: Record<'negative' | 'positive' | 'neutral', ReviewSample[]> = {
            negative: [], positive: [], neutral: []
        };

        const secondaryPages: Page[] = [];
        try {
            const tasks: Promise<void>[] = [
                scrapeSamples(page, `ITEM_${primaryType.toUpperCase()}_REVIEWS`).then(r => { samplesByType[primaryType] = r; })
            ];
            for (const t of feedbackTypes) {
                if (t.type === primaryType || !t.url) continue;
                const secondaryPage = await page.context().newPage();
                secondaryPages.push(secondaryPage);
                const label = `ITEM_${t.type.toUpperCase()}_REVIEWS`;
                tasks.push(
                    secondaryPage.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
                        .then(async () => { samplesByType[t.type] = await scrapeSamples(secondaryPage, label); })
                        .catch((err: unknown) => {
                            log.error(`${label} navigation failed`, { url: t.url, error: (err as Error).message });
                        })
                );
            }
            await Promise.all(tasks);
            phase('parallel review pages scraped');

            // Looked up only now: ITEM swaps in the full product object when it finishes, and that
            // may have happened while these pages were loading.
            // Only the types this fallback was handed — the others were already fetched as HTML.
            const { reviewsSummary } = records.get(recordId).product!;
            if (negativeUrl) reviewsSummary.negativeReviewSamples = samplesByType.negative;
            if (positiveUrl) reviewsSummary.positiveReviewSamples = samplesByType.positive;
            if (neutralUrl) reviewsSummary.neutralReviewSamples = samplesByType.neutral;
            log.info(`ITEM_REVIEWS: negative=${samplesByType.negative.length}, positive=${samplesByType.positive.length}, neutral=${samplesByType.neutral.length}`);

            await records.settle(recordId, 'ITEM_REVIEWS', log);
            phase('ITEM_REVIEWS handler done');
        } finally {
            for (const p of secondaryPages) await p.close().catch(() => {});
        }
    });

    // ──────────────────── Branch starters ────────────────────
    // A branch request is enqueued at the front of the queue, so records already in flight finish
    // before new input URLs are started, and keyed per record, so that a retried parent cannot
    // enqueue it twice while two records pointing at the same seller still get one request each.
    async function enqueueBranch(recordId: string, label: string, url: string, userData: RequestUserData) {
        await crawler.addRequests([{
            url,
            label,
            uniqueKey: `${label}|${recordId}`,
            // These load their page through loadPage(); the review fallbacks are rendered by Crawlee.
            skipNavigation: label === 'SELLER_HUB' || label === 'SELLER_STORE',
            userData: { ...userData, recordId },
        }], { forefront: true });
    }

    /** Open `branch` on the record and enqueue its first request — once per record, however often called. */
    async function startBranch(recordId: string, branch: Branch, label: string, url: string, userData: RequestUserData) {
        if (!records.open(recordId, branch)) return;
        try {
            await enqueueBranch(recordId, label, url, userData);
        } catch (err) {
            records.abandon(recordId, branch);
            throw err;
        }
    }

    /**
     * Review samples for every feedback type that has a URL, fetched concurrently as HTML through
     * `page` — no extra page, no rendering. Each type eBay would not serve that way is started as
     * a browser branch (`label`) instead, carrying only the URLs still missing, so the samples
     * already fetched are not scraped twice. Never rejects: a failure becomes that fallback.
     */
    async function fetchReviewSamples(
        recordId: string,
        page: Page,
        urls: FeedbackUrls,
        read: (dom: cheerio.CheerioAPI) => ReviewSample[],
        branch: Branch,
        label: string,
        log: Log,
    ): Promise<Partial<Record<FeedbackType, ReviewSample[]>>> {
        const samples: Partial<Record<FeedbackType, ReviewSample[]>> = {};
        const blocked: FeedbackUrls = { negative: null, positive: null, neutral: null };
        await Promise.all(FEEDBACK_TYPES.map(async (type) => {
            const url = urls[type];
            if (!url) return;
            const fetched = await fetchHtml(page, url, hasReviewContent, log, `${label}_${type.toUpperCase()}`);
            if (fetched) samples[type] = read(fetched.$);
            else blocked[type] = url;
        }));

        // Primary URL drives Crawlee navigation; the others are opened on secondary pages inside
        // the fallback handler so all scrape concurrently there too.
        const fallback = blocked.negative || blocked.positive || blocked.neutral;
        if (fallback) {
            try {
                await startBranch(recordId, branch, label, fallback, {
                    negativeUrl: blocked.negative,
                    positiveUrl: blocked.positive,
                    neutralUrl: blocked.neutral,
                });
            } catch (err) {
                log.error(`${label}: could not start the browser fallback`, { error: (err as Error).message });
            }
        }
        return samples;
    }

    /** Fetch a product's review samples, or `null` when the page links no review filter at all. */
    function startItemReviews(
        recordId: string,
        page: Page,
        urls: FeedbackUrls,
        log: Log,
    ): Promise<Partial<Record<FeedbackType, ReviewSample[]>>> | null {
        if (!urls.negative && !urls.positive && !urls.neutral) return null;
        log.info(`ITEM feedbackUrls: negative=${urls.negative} | positive=${urls.positive} | neutral=${urls.neutral}`);
        return fetchReviewSamples(recordId, page, urls, readItemReviewSamples, 'ITEM_REVIEWS', 'ITEM_REVIEWS', log);
    }

    // Start the seller branch off the profile link on the product page. If that link goes to an
    // intermediate /sch/i.html hub, route through SELLER_HUB first to resolve the real seller URL
    // from the DOM; otherwise go straight to SELLER_STORE.
    async function startSellerBranch(recordId: string, record: ScrapedItem, log: Log) {
        const sellerUrl = record.seller?.profileUrl;
        if (!sellerUrl) {
            log.warning('No seller profileUrl found on product page, record will carry product-only data');
            // The caller asked for seller data and is not getting any — say so on the record rather
            // than shipping a half-empty seller section that reads like a dead store.
            markFailure(record, 'SELLER_UNRESOLVED', 'Product page exposed no seller profile link');
            return;
        }
        let isHub = false;
        try {
            // A relative seller href stays on the marketplace the item came from.
            const parsed = new URL(sellerUrl, siteFor(record.url).origin);
            // Hub patterns: /sch/i.html?_ssn=X  OR  /sch/{slug}/m.html
            isHub = /\/sch\/i\.html/i.test(parsed.pathname)
                || /\/sch\/[^/]+\/m\.html/i.test(parsed.pathname);
        } catch (_) {}

        if (isHub) {
            log.info(`startSellerBranch: product links to search hub, routing via SELLER_HUB → ${sellerUrl}`);
            await startBranch(recordId, 'SELLER', 'SELLER_HUB', sellerUrl, {});
        } else {
            const baseUrl = storeBaseUrl(sellerUrl);
            record.seller!.profileUrl = baseUrl;
            await startBranch(recordId, 'SELLER', 'SELLER_STORE', baseUrl, { sellerBaseUrl: baseUrl });
        }
    }

    // ──────────────────── SELLER_HUB ────────────────────
    // Intermediate page patterns:
    //   /sch/i.html?..._ssn={slug}      (search-filtered listing)
    //   /sch/{slug}/m.html?...          (seller's items listing)
    // Extract real seller URL from .str-seller-card if present, else from links
    // that point to /str/{slug} or /usr/{slug}, else construct from the path slug.
    crawler.router.addHandler("SELLER_HUB", async ({ page, request, log }) => {
        const phase = makePhaseLogger(log, 'SELLER_HUB');
        phase('handler start');

        // product_and_seller: ITEM already opened this. seller_only: first contact, so create it.
        const recordId = recordIdOf(request);
        records.open(recordId, 'SELLER', () => sellerSeed(recordId));
        const scrappedItem = records.get(recordId);

        const hubLinks = '.str-seller-card, a[href*="/str/"], a[href*="/usr/"]';
        const hub = await loadPage(page, request.url, {
            label: 'SELLER_HUB',
            isReady: ($) => $(hubLinks).length > 0,
            waitSelector: hubLinks,
            waitMs: 20000,
        }, log);
        phase(hub.rendered ? 'hub rendered' : 'hub fetched as HTML');

        // A hub URL for a seller eBay has removed 404s just like the store page does.
        const httpStatus = hub.status;
        if (isGoneStatus(httpStatus)) {
            scrappedItem.seller!.isActive = false;
            await records.fail(recordId, 'SELLER', 'SELLER_NOT_FOUND', `eBay returned HTTP ${httpStatus} for seller hub ${request.url}`, log);
            return;
        }

        try {
            if (hub.$(hubLinks).length === 0) {
                log.warning(`SELLER_HUB: no seller-card or store/user link found`, { url: request.url });
            }
            const resolvedSellerUrl = readHubSellerUrl(hub.$, hub.url);

            let sellerUrl = resolvedSellerUrl;

            // Fallback #2: construct from the slug in the URL path (/sch/{slug}/m.html)
            if (!sellerUrl || /\/sch\/i\.html/i.test(sellerUrl) || /\/sch\/[^/]+\/m\.html/i.test(sellerUrl)) {
                try {
                    const hubSite = siteFor(hub.url);
                    const parsed = new URL(request.url, hubSite.origin);
                    const pathMatch = parsed.pathname.match(/\/sch\/([^/]+)\/m\.html/i);
                    const slug = (pathMatch && pathMatch[1] !== 'i.html') ? pathMatch[1] : null;
                    const ssn = parsed.searchParams.get('_ssn') || parsed.searchParams.get('store_name');
                    const finalSlug = slug || ssn;
                    if (finalSlug) {
                        // Same marketplace as the hub — sending an ebay.es seller to ebay.com here
                        // would silently switch the whole seller flow to a different site.
                        sellerUrl = `${hubSite.origin}/usr/${finalSlug}`;
                        log.info(`SELLER_HUB: DOM resolution failed, falling back to slug → ${sellerUrl}`);
                    }
                } catch (_) {}
            }

            if (!sellerUrl) {
                log.warning(`SELLER_HUB: could not resolve real seller URL, pushing product-only data`, { url: request.url });
                await records.fail(recordId, 'SELLER', 'SELLER_UNRESOLVED', `Seller hub ${request.url} exposed no store/profile link`, log);
                return;
            }

            const cleaned = storeBaseUrl(sellerUrl);
            log.info(`SELLER_HUB: resolved → ${cleaned}`);
            scrappedItem.seller!.profileUrl = cleaned;
            const slugMatch = cleaned.match(/\/(?:str|usr)\/([^/?]+)/i);
            if (slugMatch && !scrappedItem.seller!.ebayUsername) {
                scrappedItem.seller!.ebayUsername = slugMatch[1];
            }

            // Same SELLER branch, so it stays open: the store handler is the one that settles it.
            await enqueueBranch(recordId, 'SELLER_STORE', cleaned, { sellerBaseUrl: cleaned });
            phase('SELLER_HUB handler done (enqueued SELLER_STORE)');
        } catch (err) {
            log.error(`SELLER_HUB failed`, { url: request.url, error: (err as Error).message });
            throw err;
        }
    });

    // ──────────────────── SELLER_STORE ────────────────────
    crawler.router.addHandler("SELLER_STORE", async ({ page, request, log }) => {
        const phase = makePhaseLogger(log, 'SELLER_STORE');
        phase('handler start');

        const userData = request.userData as RequestUserData;
        // product_and_seller: ITEM already opened this. seller_only: first contact, so create it.
        const recordId = recordIdOf(request);
        records.open(recordId, 'SELLER', () => sellerSeed(recordId));
        const scrappedItem = records.get(recordId);
        const seller = scrappedItem.seller!;
        const sellerBaseUrl = userData.sellerBaseUrl!;

        // Nothing on the shop, feedback or about tab depends on another, so all three start at once
        // (through the residential proxy each is a 4-8s request; one after another they were most
        // of the seller branch). The shop tab is still checked first below — a gone or walled
        // store discards whatever the tabs brought back.
        const storeUrl = request.url;
        const anchor = await anchorPageFor(page.context(), siteFor(storeUrl), log);
        // The shop tab: listing cards, store card and stats are all server-rendered, so it is
        // fetched as HTML like the other tabs; rendering it used to mean waiting the full 15s on
        // every store that has no listing grid at all.
        const shopPromise = loadPage(page, storeUrl, {
            label: 'SELLER_STORE shop tab',
            isReady: ($) => isSellerAlive($),
            waitSelector: 'article.str-item-card',
            waitMs: 15000,
        }, log);
        shopPromise.catch(() => {});

        // Each tab is fetched as HTML through the session; only a tab eBay will not serve that way
        // gets rendered, on a page of its own, once we know where the shop tab landed.
        const tabPages: Page[] = [];
        const loadTab = async (tab: 'feedback' | 'about', readySelector: string, required: boolean) => {
            const target = new URL(storeUrl);
            target.searchParams.set('_tab', tab);
            const fetched = anchor ? await fetchHtml(
                anchor, target.toString(),
                // A redirect that drops `_tab` lands on the shop tab instead — not this tab. A store
                // with no about section is a normal answer, not a reason to render.
                ($, finalUrl) => new URL(finalUrl).searchParams.get('_tab') === tab && (!required || $(readySelector).length > 0),
                log, `SELLER_STORE ${tab} tab`,
            ) : null;
            if (fetched) return fetched;

            const shop = await shopPromise;
            // The store URL redirected (a /usr/ profile to its /str/ store) and the redirect dropped
            // `_tab` — ask for the tab where the shop tab actually landed before rendering it.
            if (anchor && new URL(shop.url).pathname !== new URL(storeUrl).pathname) {
                const landedTab = new URL(shop.url);
                landedTab.searchParams.set('_tab', tab);
                const again = await fetchHtml(
                    anchor, landedTab.toString(),
                    ($, finalUrl) => new URL(finalUrl).searchParams.get('_tab') === tab && (!required || $(readySelector).length > 0),
                    log, `SELLER_STORE ${tab} tab (after redirect)`,
                );
                if (again) return again;
            }
            const tabPage = await page.context().newPage();
            tabPages.push(tabPage);
            const ready = await openStoreTab(tabPage, shop.url, tab, readySelector, log);
            // Some layouts already render the block on the shop tab.
            if (!ready && shop.$(readySelector).length > 0) return { $: shop.$, url: shop.url };
            if (!ready) log.warning(`SELLER_STORE: ${tab} content never rendered`, { url: request.url });
            return { $: cheerio.load(await tabPage.content()), url: tabPage.url() };
        };

        // The review samples only need the seller's username. A /str/ store's feedback tab always
        // links them in one shape (identical on bose, amazing-wireless, ecoflowsolar and an ebay.es
        // store), so with the username the product page gave us they start now instead of after
        // the feedback tab. A /usr/ profile links a different shape, and a seller_only seed only
        // knows the URL slug (`amazingwireless` for user `amazing-wireless`) — those wait for the
        // tab's own links.
        const knownUsername = scrappedItem.sellerRef?.ebayUsername;
        const earlyReviews = anchor && knownUsername && /\/str\//i.test(new URL(storeUrl).pathname)
            ? fetchReviewSamples(
                recordId, anchor, buildSellerFeedbackUrls(siteFor(storeUrl).origin, knownUsername),
                readSellerReviewSamples, 'SELLER_REVIEWS', 'SELLER_REVIEWS', log,
            ).then((samples) => { phase('seller reviews fetched (from username)'); return samples; })
            : null;

        const feedbackDone = (async () => {
            const feedbackTab = await loadTab('feedback', '.rating-element', true);
            phase('feedback tab loaded');

            const raw = readStoreFeedback(feedbackTab.$, feedbackTab.url);

            // ── Interpret the raw text, marketplace by marketplace ──
            const warnCount = (label: string, parsed: ReturnType<typeof parseCount>) => {
                if (parsed.unknownSuffix) {
                    log.warning(`SELLER_STORE: unrecognised count suffix on ${label} — add it to COUNT_MULTIPLIERS`, {
                        url: request.url, suffix: parsed.unknownSuffix,
                    });
                }
                return parsed.value;
            };

            const summary: FeedbackSummary = { positive: null, neutral: null, negative: null };
            const feedbackLinks: Record<'negative' | 'positive' | 'neutral', string | null> = {
                negative: null, positive: null, neutral: null,
            };
            for (const row of raw.ratingElements) {
                const type = feedbackTypeOf(row.href, row.label);
                if (!type) continue;
                summary[type] = warnCount(`feedback summary (${type})`, parseCount(row.countText));
                if (row.href) feedbackLinks[type] = row.href;
            }

            const detailedRatings: DetailedRatings = {
                accurateDescription: null, shippingSpeed: null, communication: null, shippingCost: null,
            };
            raw.detailedRatingRows.forEach((row, i) => {
                const value = parseAmount(row.valueText || '') ?? parseAmount(row.progressValue || '');
                // A DSR is a 0-5 star average; anything outside that came from markup we misread.
                if (value === null || value < 0 || value > 5) return;
                // eBay renders the four DSRs in a fixed order on every marketplace, so the position
                // is the reliable key; the English label match just protects against a reorder.
                const key = DSR_KEY_BY_LABEL(row.label)
                    ?? (raw.detailedRatingRows.length === DSR_ORDER.length ? DSR_ORDER[i] : null);
                if (key) detailedRatings[key] = value;
            });

            // `(23.560)` on ebay.es is 23560, not 23 — parseAmount reads the convention off the string.
            const feedbackScore = parseAmount(raw.feedbackCountText.replace(/[()]/g, '')) ?? null;
            // Both fields have always been read off this one element; they were only ever computed
            // by two different regexes over the same text, so keep them explicitly the same number.
            const totalSellerFeedbackCount = feedbackScore;

            let positivePercent: number | null = null;
            let itemsSold: number | null = null;
            let followers: number | null = null;
            const otherStats: typeof raw.storeStats = [];
            for (const stat of raw.storeStats) {
                if (stat.isFeedbackLink) {
                    positivePercent = parseAmount(stat.boldText.replace('%', ''));
                    continue;
                }
                otherStats.push(stat);
            }
            otherStats.forEach((stat, i) => {
                // en + es labels are verified; every other marketplace falls back to eBay's fixed
                // "% positive, items sold, followers" order, which is why the pair must be complete.
                const text = stat.text.toLowerCase();
                let key: (typeof STORE_STAT_ORDER)[number] | null = null;
                if (/sold|vendid/.test(text)) key = 'itemsSold';
                else if (/follow|seguidor/.test(text)) key = 'followers';
                else if (otherStats.length === STORE_STAT_ORDER.length) key = STORE_STAT_ORDER[i];

                if (key === 'itemsSold') itemsSold = warnCount('items sold', parseCount(stat.boldText));
                else if (key === 'followers') followers = warnCount('followers', parseCount(stat.boldText));
            });

            if (positivePercent === null && summary.positive !== null) {
                const total = (summary.positive || 0) + (summary.neutral || 0) + (summary.negative || 0);
                if (total > 0) positivePercent = Math.round((summary.positive / total) * 10000) / 100;
            }
            if (positivePercent === null && raw.altPercentText) {
                positivePercent = parseAmount(raw.altPercentText.replace('%', ''));
            }

            const { displayName, ebayUsername, storeId, logoUrl } = raw;

            let resolvedUsername = ebayUsername || seller.ebayUsername;
            if (!resolvedUsername) {
                const slugMatch = sellerBaseUrl.match(/\/(?:str|usr)\/([^/?]+)/i);
                if (slugMatch) resolvedUsername = slugMatch[1];
            }

            seller.displayName = displayName || seller.displayName || resolvedUsername;
            seller.ebayUsername = resolvedUsername;
            seller.storeId = storeId;
            seller.logoUrl = logoUrl;
            seller.feedbackScore = feedbackScore;
            seller.positivePercent = positivePercent;
            seller.itemsSold = itemsSold;
            seller.followers = followers;
            seller.feedback.summary = summary;
            seller.feedback.detailedRatings = detailedRatings;
            seller.totalSellerFeedbackCount = totalSellerFeedbackCount;

            // [technical] temporarily commented out the sellerTechnical processing
            // const sellerTechnical = await page.evaluate(() => {
            //     // const scriptBlocks = [...document.querySelectorAll('script')].map(s => s.textContent).filter(Boolean);
            //     const scriptBlocks = [];
            //     const jsonState = {};
            //     // scriptBlocks.forEach(script => {
            //     //     const match = script.match(/window\.__INITIAL_STATE__\s*=\s*(\{.*\});/);
            //     //     if (match) { try { jsonState.rootKeys = Object.keys(JSON.parse(match[1])); } catch (e) {} }
            //     // });

            //     const dataAttributes = {};
            //     // document.querySelectorAll('*').forEach(el => {
            //     //     for (const attr of el.attributes) {
            //     //         if (attr.name.startsWith('data-')) dataAttributes[attr.name] = attr.value;
            //     //     }
            //     // });

            //     const googleAnalytics: string[] = [];
            //     const facebookPixel: string[] = [];
            //     document.querySelectorAll('script').forEach(s => {
            //         if (s.src?.includes('googletagmanager')) {
            //             const m = s.src.match(/id=([A-Z0-9-]+)/);
            //             if (m) googleAnalytics.push(m[1]);
            //         }
            //         if (s.textContent?.includes('gtag(')) {
            //             const m = s.textContent.match(/gtag\(['"]config['"],\s*['"]([A-Z0-9-]+)['"]\)/);
            //             if (m) googleAnalytics.push(m[1]);
            //         }
            //         if (s.textContent?.includes('fbq(')) {
            //             const m = s.textContent.match(/fbq\(['"]init['"],\s*['"](\d+)['"]\)/);
            //             if (m) facebookPixel.push(m[1]);
            //         }
            //     });

            //     const jsBundles = [...document.querySelectorAll('script[src]')].map(s => (s as HTMLScriptElement).src);
            //     const cssBundles = [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => (l as HTMLLinkElement).href);

            //     return { scriptBlocks: scriptBlocks.length, jsonState, dataAttributes, trackingIds: { googleAnalytics, facebookPixel }, jsBundles, cssBundles };
            // });
            // scrappedItem.sellerTechnical = sellerTechnical;

            phase('seller data extracted');

            // The review samples need nothing else from this store, so they start right away,
            // concurrently with the about tab and the shop items — unless they already started
            // off the username above.
            if (earlyReviews) {
                const samples = await earlyReviews;
                if (samples.negative) seller.feedback.negativeReviewSamples = samples.negative;
                if (samples.positive) seller.feedback.positiveReviewSamples = samples.positive;
                if (samples.neutral) seller.feedback.neutralReviewSamples = samples.neutral;
            } else if (feedbackLinks.negative || feedbackLinks.positive || feedbackLinks.neutral) {
                const samples = await fetchReviewSamples(
                    recordId, anchor ?? (await shopPromise).htmlPage, feedbackLinks, readSellerReviewSamples, 'SELLER_REVIEWS', 'SELLER_REVIEWS', log,
                );
                if (samples.negative) seller.feedback.negativeReviewSamples = samples.negative;
                if (samples.positive) seller.feedback.positiveReviewSamples = samples.positive;
                if (samples.neutral) seller.feedback.neutralReviewSamples = samples.neutral;
                phase('seller reviews fetched');
            } else {
                log.warning('No seller feedback link found, skipping seller reviews');
            }
            return { resolvedUsername };
        })();

        // Same locale trap as the feedback tab — "about" is "Información" on ebay.es.
        const aboutRaw = (async () => {
            const aboutTab = await loadTab('about', '.str-about-description, .str-business-details', false);
            return readStoreAbout(aboutTab.$);
        })();

        // Awaited below on the happy path; until then, keep a failure from being reported as an
        // unhandled rejection.
        feedbackDone.catch(() => {});
        aboutRaw.catch(() => {});

        // Closes any fallback tab pages — so an early exit does not sit out their load timeouts —
        // then waits for the tab tasks to wind down: anything a task does (starting the
        // SELLER_REVIEWS fallback) must land before the SELLER branch settles. Safe to call twice.
        const closeTabs = async () => {
            const settled = Promise.allSettled([feedbackDone, aboutRaw, earlyReviews]);
            for (const p of tabPages) await p.close().catch(() => {});
            await settled;
            // A fallback page opened after the first pass above.
            for (const p of tabPages) await p.close().catch(() => {});
        };

        try {
            const shop = await shopPromise;
            const $store = shop.$;
            const landedUrl = shop.url;
            const site = siteFor(landedUrl);
            phase(shop.rendered ? 'shop tab rendered' : 'shop tab fetched as HTML');

            // Store removed from the platform — definitive.
            const httpStatus = shop.status;
            if (isGoneStatus(httpStatus)) {
                seller.isActive = false;
                await closeTabs();
                await records.fail(recordId, 'SELLER', 'SELLER_NOT_FOUND', `eBay returned HTTP ${httpStatus} for ${request.url}`, log);
                return;
            }
            // Same three-way split as the item page: no eBay chrome means we were walled and should
            // retry; chrome but none of the store markup means the store itself is gone.
            if (isWalled($store)) {
                throw blockedError(httpStatus, false);
            }
            if (!isSellerAlive($store)) {
                seller.isActive = false;
                await closeTabs();
                await records.fail(recordId, 'SELLER', 'SELLER_NOT_FOUND', `${request.url} rendered none of the store/profile markup`, log);
                return;
            }
            seller.isActive = true;

            const rawItems = readStoreItems($store, landedUrl);
            if (rawItems.length === 0) {
                log.warning(`SELLER_STORE: No store items found on Shop tab`, { url: request.url });
            }
            seller.storeItems = rawItems.map(item => {
                let priceMin: number | null = null, priceMax: number | null = null, currency: string | null = null;
                if (item.priceText) {
                    const parts = item.priceText.split(/\s+to\s+/i);
                    const fromParsed = parseCurrency(parts[0]?.trim(), site.currency);
                    if (fromParsed) { priceMin = fromParsed.cost; currency = fromParsed.currency; }
                    if (parts.length > 1) {
                        const toParsed = parseCurrency(parts[1]?.trim(), site.currency);
                        if (toParsed) priceMax = toParsed.cost;
                    }
                }
                return { name: item.name, imageUrl: item.imageUrl, currency, priceMin, priceMax, url: item.url };
            });
            log.info(`Scraped ${seller.storeItems.length} store items`);
            phase('store items extracted');

            const { resolvedUsername } = await feedbackDone;
            const aboutData = await aboutRaw;

            // These labels are translated too — ebay.es renders "Ubicación:", "Usuario desde:",
            // "Vendedor:". Matching them by English text left `memberSince` null on every
            // marketplace including ebay.com, where the key was normalised to `membersince` and so
            // never matched the `'member since'` lookup it was written for.
            //
            // Classify by the shape of the *value* instead: a four-digit year is a join date, the
            // seller's own username is a row we already have off the store header, and whatever is
            // left is the location. English labels still win when they are there.
            let aboutLocation: string | null = null;
            let aboutMemberSince: string | null = null;
            for (const row of aboutData.sellerInfoRows) {
                if (!row.value) continue;
                const label = row.label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
                if (label.includes('location')) { aboutLocation = row.value; continue; }
                if (label.includes('member since')) { aboutMemberSince = row.value; continue; }
                if (/\b(19|20)\d{2}\b/.test(row.value)) { aboutMemberSince ??= row.value; continue; }
                if (resolvedUsername && row.value.toLowerCase() === resolvedUsername.toLowerCase()) continue;
                aboutLocation ??= row.value;
            }

            // Business details stay a free-form passthrough map — keep eBay's own labels, trimmed of
            // the trailing colon and non-breaking space so the keys are usable.
            const businessDetails: Record<string, string> = {};
            for (const row of aboutData.businessDetailRows) {
                const key = row.label.replace(/[:\s\u00A0]+$/, '').trim().toLowerCase().replace(/\s+/g, '_');
                if (key && row.value) businessDetails[key] = row.value;
            }

            seller.about = {
                description: aboutData.aboutDescription,
                location: aboutLocation,
                memberSince: aboutMemberSince,
                businessDetails: Object.keys(businessDetails).length ? businessDetails : null
            };
            phase('about tab extracted');

            await closeTabs();
            await records.settle(recordId, 'SELLER', log);
            phase('SELLER_STORE handler done');
        } catch (err) {
            log.error(`SELLER_STORE failed`, { url: request.url, error: (err as Error).message });
            throw err;
        } finally {
            await closeTabs();
        }
    });

    // ──────────────────── SELLER_REVIEWS ────────────────────
    // Scrape seller negative + positive review samples in parallel on two pages
    // sharing the same browser context.
    crawler.router.addHandler("SELLER_REVIEWS", async ({ page, request, log }) => {
        const phase = makePhaseLogger(log, 'SELLER_REVIEWS');
        phase('handler start');

        const userData = request.userData as RequestUserData;
        const recordId = recordIdOf(request);
        const seller = records.get(recordId).seller!;
        const { negativeUrl, positiveUrl, neutralUrl } = userData;

        const scrapeSamples = async (p: Page, label: string) => {
            try {
                await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await p.waitForFunction(() => {
                    if (document.querySelector('.fdbk-result-status')) return true;
                    const rows = document.querySelectorAll('tr[data-feedback-id]');
                    if (rows.length > 0) {
                        return (rows[0].querySelector('.card__comment span')?.textContent?.trim()?.length ?? 0) > 0;
                    }
                    const cards = document.querySelectorAll('li.fdbk-container[data-testid*="feedback-cards"]');
                    if (cards.length > 0) {
                        return (cards[0].querySelector('.fdbk-container__details__comment span')?.textContent?.trim()?.length ?? 0) > 0;
                    }
                    return false;
                }, { timeout: 40000 }).catch(() => {
                    log.warning(`${label}: Expected content not found`, { url: p.url() });
                });
                return await p.evaluate(() => {
                    const results: {
                        user: string | null;
                        userFeedbackScore: number | null;
                        comment: string | null;
                        commentDate: string | null;
                        ratingType: string | null;
                        verifiedPurchase: boolean;
                    }[] = [];
                    const parseUser = (raw: string | null): { user: string | null; userFeedbackScore: number | null } => {
                        if (!raw) return { user: null, userFeedbackScore: null };
                        const m = raw.match(/^(.+?)\s*\((\d[\d,]*)\)\s*$/);
                        if (m) return { user: m[1].trim(), userFeedbackScore: parseInt(m[2].replace(/,/g, ''), 10) };
                        return { user: raw.trim(), userFeedbackScore: null };
                    };
                    document.querySelectorAll('tr[data-feedback-id]').forEach((row) => {
                        if (results.length >= 5) return;
                        const comment = row.querySelector('.card__comment span')?.textContent?.trim();
                        if (!comment) return;
                        const userName = row.querySelector('.card__from span[aria-label="Feedback left by buyer."]')?.textContent?.trim() || null;
                        const scoreText = row.querySelector('.card__from .no-wrap span')?.textContent?.trim().replace(/,/g, '');
                        const userFeedbackScore = scoreText ? parseInt(scoreText, 10) : null;
                        const tds = row.querySelectorAll('td');
                        const commentDate = tds[2]?.querySelector('span[aria-label]')?.textContent?.trim()
                            || tds[2]?.querySelector('span')?.textContent?.trim()
                            || null;
                        const svg = row.querySelector('svg[data-test-type]');
                        const ratingType = svg?.getAttribute('data-test-type')?.toLowerCase() || null;
                        const verifiedPurchase = Array.from(row.querySelectorAll('span'))
                            .some(s => s.textContent?.trim().toLowerCase() === 'verified purchase');
                        results.push({ user: userName, userFeedbackScore, comment, commentDate, ratingType, verifiedPurchase });
                    });
                    if (results.length === 0) {
                        document.querySelectorAll('li.fdbk-container[data-testid*="feedback-cards"]').forEach((card) => {
                            if (results.length >= 5) return;
                            const comment = card.querySelector('.fdbk-container__details__comment span')?.textContent?.trim();
                            if (!comment) return;
                            const userRaw = card.querySelector('.fdbk-container__details__info__username span:not(.fb-clipped)')?.textContent?.trim() || null;
                            const { user, userFeedbackScore } = parseUser(userRaw);
                            const commentDate = card.querySelector('.fdbk-container__details__info__divide__time span')?.textContent?.trim() || null;
                            const svg = card.querySelector('svg[data-test-type]');
                            const ratingType = svg?.getAttribute('data-test-type')?.toLowerCase() || null;
                            const verifiedPurchase = !!card.querySelector('.fdbk-container__details__verified__purchase');
                            results.push({ user, userFeedbackScore, comment, commentDate, ratingType, verifiedPurchase });
                        });
                    }
                    return results;
                });
            } catch (err) {
                log.error(`${label} failed`, { url: p.url(), error: (err as Error).message });
                return [];
            }
        };

        const feedbackTypes: { type: 'negative' | 'positive' | 'neutral'; url: string | null | undefined }[] = [
            { type: 'negative', url: negativeUrl },
            { type: 'positive', url: positiveUrl },
            { type: 'neutral', url: neutralUrl },
        ];
        const primaryType = feedbackTypes.find(t => t.url === request.url)?.type
            ?? feedbackTypes.find(t => t.url)!.type;
        const samplesByType: Record<'negative' | 'positive' | 'neutral', ReviewSample[]> = {
            negative: [], positive: [], neutral: []
        };

        const secondaryPages: Page[] = [];
        try {
            const tasks: Promise<void>[] = [
                scrapeSamples(page, `SELLER_${primaryType.toUpperCase()}_REVIEWS`).then(r => { samplesByType[primaryType] = r; })
            ];
            for (const t of feedbackTypes) {
                if (t.type === primaryType || !t.url) continue;
                const secondaryPage = await page.context().newPage();
                secondaryPages.push(secondaryPage);
                const label = `SELLER_${t.type.toUpperCase()}_REVIEWS`;
                tasks.push(
                    secondaryPage.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 40000 })
                        .then(async () => { samplesByType[t.type] = await scrapeSamples(secondaryPage, label); })
                        .catch((err: unknown) => {
                            log.error(`${label} navigation failed`, { url: t.url, error: (err as Error).message });
                        })
                );
            }
            await Promise.all(tasks);
            phase('parallel review pages scraped');

            // Only the types this fallback was handed — the others were already fetched as HTML.
            if (negativeUrl) seller.feedback.negativeReviewSamples = samplesByType.negative;
            if (positiveUrl) seller.feedback.positiveReviewSamples = samplesByType.positive;
            if (neutralUrl) seller.feedback.neutralReviewSamples = samplesByType.neutral;
            log.info(`SELLER_REVIEWS: negative=${samplesByType.negative.length}, positive=${samplesByType.positive.length}, neutral=${samplesByType.neutral.length}`);

            await records.settle(recordId, 'SELLER_REVIEWS', log);
            phase('SELLER_REVIEWS handler done');
        } finally {
            for (const p of secondaryPages) await p.close().catch(() => {});
        }
    });

    await crawler.run(startUrls);
    await Actor.exit();
})();
