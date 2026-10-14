/*
Cheerio readers for the pages the scraper fetches as HTML instead of rendering.

eBay server-renders everything these readers need — review cards, store feedback/about tabs, seller
review rows — so after a probe on 2026-10-14 they are fetched as plain HTML through the browser
session (see html-fetch.ts) instead of opened as pages. Each reader is a line-for-line port of the
`page.evaluate` it replaces: same selectors, same fallbacks, same output shape, so the record does
not change with the transport. The only differences are mechanical — `.text()` for `textContent`,
and URLs resolved against the page URL because cheerio, unlike the DOM, does not do it for us.

Every number and label on these pages is localized (`2 329` on ebay.es, "Positivos"), so like the
browser code before them, these readers only pull text out; interpreting it stays in main.ts with
the locale-tolerant parsers.
*/
import type { CheerioAPI } from 'cheerio';

import type { ReviewSample } from './dto/index.js';

/** How many review samples a record keeps per feedback type. */
const MAX_SAMPLES = 5;

/**
 * eBay's bot challenge pages — `/splashui/captcha` and `/splashui/challenge` (both seen on
 * 2026-10-14). Served with HTTP 200 *and* the global header, so `isWalled` misses them.
 */
export function isCaptchaUrl(url: string): boolean {
    return /\/splashui\/(captcha|challenge)/i.test(url);
}

function resolveUrl(href: string | undefined, baseUrl: string): string | null {
    if (!href) return null;
    try { return new URL(href, baseUrl).toString(); } catch (_) { return null; }
}

function splitUser(raw: string | null): { user: string | null; userFeedbackScore: number | null } {
    if (!raw) return { user: null, userFeedbackScore: null };
    const m = raw.match(/^(.+?)\s*\((\d[\d,]*)\)\s*$/);
    if (m) return { user: m[1].trim(), userFeedbackScore: parseInt(m[2].replace(/,/g, ''), 10) };
    return { user: raw.trim(), userFeedbackScore: null };
}

/**
 * Whether a review page has rendered its results — cards, rows, or an answer that there are none.
 * A page with neither did not give us its reviews, and the caller should fall back to the browser.
 *
 * "None" has two shapes: the product review page's `.fdbk-result-status`, and on the seller
 * review page the `#feedback-cards` table itself, which the server sends with zero rows (no class
 * or attribute marks it empty — only translated text such as "0 votos recibidos"). Missing that
 * second shape sent every seller with no negative feedback through a ~30s browser fallback.
 */
export function hasReviewContent($: CheerioAPI): boolean {
    return $('.fdbk-result-status').length > 0
        || $('li.fdbk-container[data-testid*="feedback-cards"]').length > 0
        || $('tr[data-feedback-id]').length > 0
        || $('table#feedback-cards').length > 0;
}

/**
 * Product review samples from `/fdbk/mweb_profile`.
 *
 * eBay renders both "This item" and "All items" tabpanels in the DOM (the inactive one only has
 * `hidden=""`), so unscoped selectors mix them — scope to the "This item" panel by tab text.
 */
export function readItemReviewSamples($: CheerioAPI): ReviewSample[] {
    let panelId: string | undefined;
    $('[role="tab"]').each((_i, tab) => {
        if (!/^This item/i.test($(tab).text().trim())) return true;
        panelId = $(tab).attr('aria-controls');
        return false;
    });
    const panel = panelId ? $(`[id="${panelId}"]`) : null;
    const cardSelector = 'li.fdbk-container[data-testid*="feedback-cards"]';
    const cards = panel?.length ? panel.find(cardSelector) : $(cardSelector);

    const results: ReviewSample[] = [];
    cards.each((i, card) => {
        if (i >= MAX_SAMPLES) return false;
        const $card = $(card);
        const comment = $card.find('.fdbk-container__details__comment span').first().text().trim() || null;
        if (!comment) return true;
        const userRaw = $card.find('.fdbk-container__details__info__username span:not(.fb-clipped)').first().text().trim() || null;
        const { user, userFeedbackScore } = splitUser(userRaw);
        const commentDate = $card.find('.fdbk-container__details__info__divide__time span').first().text().trim() || null;
        const ratingType = $card.find('svg[data-test-type]').first().attr('data-test-type')?.toLowerCase() || null;
        const verifiedPurchase = $card.find('.fdbk-container__details__verified__purchase').length > 0;
        results.push({ user, userFeedbackScore, comment, commentDate, ratingType, verifiedPurchase });
        return true;
    });
    return results;
}

/**
 * Seller review samples from `/fdbk/feedback_profile/{user}` — the table layout, falling back to
 * the card layout some sellers are served instead.
 */
export function readSellerReviewSamples($: CheerioAPI): ReviewSample[] {
    const results: ReviewSample[] = [];
    $('tr[data-feedback-id]').each((_i, row) => {
        if (results.length >= MAX_SAMPLES) return false;
        const $row = $(row);
        const comment = $row.find('.card__comment span').first().text().trim();
        if (!comment) return true;
        const userName = $row.find('.card__from span[aria-label="Feedback left by buyer."]').first().text().trim() || null;
        const scoreText = $row.find('.card__from .no-wrap span').first().text().trim().replace(/,/g, '');
        const userFeedbackScore = scoreText ? parseInt(scoreText, 10) : null;
        const dateCell = $row.find('td').eq(2);
        const commentDate = dateCell.find('span[aria-label]').first().text().trim()
            || dateCell.find('span').first().text().trim()
            || null;
        const ratingType = $row.find('svg[data-test-type]').first().attr('data-test-type')?.toLowerCase() || null;
        const verifiedPurchase = $row.find('span').toArray()
            .some((s) => $(s).text().trim().toLowerCase() === 'verified purchase');
        results.push({ user: userName, userFeedbackScore, comment, commentDate, ratingType, verifiedPurchase });
        return true;
    });
    if (results.length === 0) {
        $('li.fdbk-container[data-testid*="feedback-cards"]').each((_i, card) => {
            if (results.length >= MAX_SAMPLES) return false;
            const $card = $(card);
            const comment = $card.find('.fdbk-container__details__comment span').first().text().trim();
            if (!comment) return true;
            const userRaw = $card.find('.fdbk-container__details__info__username span:not(.fb-clipped)').first().text().trim() || null;
            const { user, userFeedbackScore } = splitUser(userRaw);
            const commentDate = $card.find('.fdbk-container__details__info__divide__time span').first().text().trim() || null;
            const ratingType = $card.find('svg[data-test-type]').first().attr('data-test-type')?.toLowerCase() || null;
            const verifiedPurchase = $card.find('.fdbk-container__details__verified__purchase').length > 0;
            results.push({ user, userFeedbackScore, comment, commentDate, ratingType, verifiedPurchase });
            return true;
        });
    }
    return results;
}

/** The product-rating summary on an item page: average, rating count and the star histogram. */
export function readItemRatings($: CheerioAPI): {
    rating: number | null;
    reviewCount: number | null;
    ratingBreakdown: Record<number, number>;
} {
    const ratingText = $('span.ux-summary__start--rating .ux-textspans').first().text().trim();
    const rating = parseFloat(ratingText) || null;
    const tabText = $('div.x-feedback-detail-list .tabs__item').first().text().trim();
    const tabMatch = tabText.match(/\((\d[\d,]*)\)/);
    const countText = $('span.ux-summary__count .ux-textspans').first().text().trim();
    const reviewCount = tabMatch
        ? parseInt(tabMatch[1].replace(/,/g, ''), 10)
        : parseInt(countText.split(' ')[0], 10) || null;
    const ratingBreakdown: Record<number, number> = {};
    $('div.ux-histogram__item--bar').each((_i, el) => {
        const stars = parseInt($(el).find('.ux-histogram__item--bar--stars').first().text().trim(), 10);
        const count = parseInt($(el).find('.ux-histogram__item--bar--c span').first().text().trim(), 10);
        if (!Number.isNaN(stars) && !Number.isNaN(count)) ratingBreakdown[stars] = count;
    });
    return { rating, reviewCount, ratingBreakdown };
}

/**
 * The item feedback filter URLs eBay builds client-side when it lazy-loads the feedback module.
 *
 * A listing with no "This item" feedback tab ships `.x-feedback-detail-list` empty in the HTML
 * and fills it in after render with the seller's "All items" filters. Rendering a page only to
 * read four links back is the cost this avoids; the links are always this shape (seen on
 * ebay.com 2026-10-14), keyed by the item id and the seller's username.
 */
export function buildAllItemsFeedbackUrls(
    origin: string,
    itemId: string,
    username: string,
): { negative: string; positive: string; neutral: string } {
    const url = (commentType: string) => {
        const u = new URL('/fdbk/mweb_profile', origin);
        u.search = new URLSearchParams({
            fdbkType: 'FeedbackReceivedAsSeller',
            item_id: itemId,
            username,
            allItemsTabListingId: itemId,
            tab: 'ALL',
            commentType,
            sort: 'RELEVANCEV2',
        }).toString();
        return u.toString();
    };
    return { negative: url('NEGATIVE'), positive: url('POSITIVE'), neutral: url('NEUTRAL') };
}

/**
 * The seller review filter links a /str/ store's feedback tab renders, built from the username.
 * Same shape on every store seen (2026-10-14: bose, amazing-wireless, ecoflowsolar, an ebay.es
 * store) — `/usr/` profiles link a different shape, so this is for stores only.
 */
export function buildSellerFeedbackUrls(
    origin: string,
    username: string,
): { negative: string; positive: string; neutral: string } {
    const url = (type: string) => {
        const u = new URL(`/fdbk/feedback_profile/${encodeURIComponent(username)}`, origin);
        // eBay percent-encodes the filter's `:` and `,`; URLSearchParams would write them the same.
        u.search = new URLSearchParams({
            filter: `feedback_page:RECEIVED_AS_SELLER,period:TWELVE_MONTHS,overall_rating:${type}`,
            commentType: type,
        }).toString();
        return u.toString();
    };
    return { negative: url('NEGATIVE'), positive: url('POSITIVE'), neutral: url('NEUTRAL') };
}

/**
 * The seller link on an item page: where it points and the name it shows.
 *
 * eBay renders the same link in two places — the seller card beside the buy box, and the "Store
 * information" module further down — and names the store again in the page data. Some responses
 * come without the seller card (seen on 2026-10-14, at a single request through the residential
 * proxy as well as under load), so each is tried in turn. All three point at the same place: the
 * store for a seller that has one, the `/sch/` hub for one that does not.
 */
export function readItemSellerLink($: CheerioAPI, pageData: string): { href: string; name: string | null } | null {
    for (const selector of ['.x-sellercard-atf__info__about-seller a', '.x-store-information h3 a']) {
        const anchor = $(selector).first();
        const href = anchor.attr('href');
        if (href) return { href, name: anchor.find('.ux-textspans--BOLD').first().text().trim() || anchor.text().trim() || null };
    }
    const visitStore = pageData.match(/"name":"VISIT_STORE","params":\{"store_name":"([^"]+)"[^}]*\},"clientPresentationMetadata":\{"_ssn":"([^"]+)"/);
    if (visitStore) return { href: `/str/${visitStore[1]}`, name: visitStore[2] };
    return null;
}

export interface StoreItemRaw {
    name: string | null;
    imageUrl: string | null;
    priceText: string | null;
    url: string | null;
}

/**
 * The first ten listing cards on a store's shop tab.
 *
 * The server sends each image as `<picture><source type="image/webp" srcset="…webp"><img
 * src="…jpg">`, and the browser's JS swaps the `<img>` over to the webp; the rendered path read
 * `img.src` after that swap, so the webp source is preferred here to keep the same URLs.
 */
export function readStoreItems($: CheerioAPI, baseUrl: string): StoreItemRaw[] {
    const items: StoreItemRaw[] = [];
    $('article.str-item-card').each((_i, el) => {
        if (items.length >= 10) return false;
        const $el = $(el);
        const name = $el.find('.str-item-card__property-title .str-text-span').first().text().trim() || null;
        if (!name) return true;
        const img = $el.find('img[data-testid="str-img"]').first();
        const webp = img.parent('picture').find('source[type="image/webp"]').first().attr('srcset')?.trim().split(/[\s,]+/)[0];
        items.push({
            name,
            imageUrl: resolveUrl(webp || img.attr('src'), baseUrl),
            priceText: $el.find('.str-item-card__property-displayPrice').first().text().trim() || null,
            url: resolveUrl($el.find('a.str-item-card__link').first().attr('href'), baseUrl),
        });
        return true;
    });
    return items;
}

/** The real store/profile URL behind a `/sch/` seller hub page, or `null` if it links none. */
export function readHubSellerUrl($: CheerioAPI, baseUrl: string): string | null {
    const pick = (selector: string) => resolveUrl($(selector).first().attr('href'), baseUrl);
    return pick('.str-seller-card__store-name h1 a')
        || pick('a.str-profile-link')
        || pick('.str-seller-card__store-logo a')
        // Fallback: first anchor on the page that points to a seller store/profile
        || pick('a[href*="/str/"], a[href*="/usr/"]');
}

export interface StoreFeedbackRaw {
    ratingElements: { href: string | null; label: string | null; countText: string | null }[];
    detailedRatingRows: { label: string | null; valueText: string | null; progressValue: string | null }[];
    storeStats: { text: string; boldText: string; isFeedbackLink: boolean }[];
    feedbackCountText: string;
    altPercentText: string;
    displayName: string | null;
    ebayUsername: string | null;
    storeId: string | null;
    logoUrl: string | null;
}

/** Raw text off the store's feedback tab (`/str/{slug}?_tab=feedback`). */
export function readStoreFeedback($: CheerioAPI, baseUrl: string): StoreFeedbackRaw {
    const text = (selector: string) => $(selector).first().text().trim();

    const ratingElements = $('.rating-element').toArray().map((el) => {
        const $el = $(el);
        return {
            // The href carries `commentType=POSITIVE`, which is identical on every marketplace —
            // unlike the label beside it, which is the seller's language.
            href: resolveUrl($el.find('a').first().attr('href'), baseUrl),
            label: $el.children('span').first().text().trim() || null,
            countText: $el.find('.INLINE_LINK').first().text().trim() || null,
        };
    });

    const detailedRatingRows = $('.fdbk-detail-seller-rating').toArray().map((el) => {
        const $el = $(el);
        return {
            label: $el.find('.fdbk-detail-seller-rating__label span').first().text().trim() || null,
            // The value cell holds the visible `4.9` and a screen-reader-only `.fb-clipped`
            // "4.9 out of 5 stars"; the whole cell's text would glue them into `4.94.9 …`.
            valueText: $el.find('.fdbk-detail-seller-rating__value span:not(.fb-clipped)').first().text().trim() || null,
            // Same number as a plain, locale-independent attribute.
            progressValue: $el.find('progress').first().attr('value') || null,
        };
    });

    const storeStats = $('.str-seller-card__store-stats-content > div').toArray().map((div) => {
        const $div = $(div);
        return {
            text: $div.text().trim(),
            boldText: $div.find('.BOLD').first().text().trim(),
            // The percentage is the only stat wrapped in the feedback link — a structural marker,
            // so it survives translation.
            isFeedbackLink: $div.find('a.str-seller-card__feedback-link').length > 0,
        };
    });

    const feedbackCountText = $('.fdbk-detail-list__title .SECONDARY').first().text();
    const altPercentText = text('.fdbk-overall-rating__bar-text')
        || text('.fdbk-overall-rating .SECONDARY')
        || text('[class*="positive-feedback"]')
        || '';

    let ebayUsername: string | null = null;
    $('script').each((_i, s) => {
        const entityMatch = ($(s).html() || '').match(/"entity_id"\s*:\s*"~([^"]+)"/);
        if (!entityMatch) return true;
        ebayUsername = entityMatch[1];
        return false;
    });
    if (!ebayUsername) {
        const href = resolveUrl($('a[href*="fdbk/feedback_profile/"]').first().attr('href'), baseUrl);
        const hrefMatch = href?.match(/\/fdbk\/feedback_profile\/([^/?]+)/);
        if (hrefMatch) ebayUsername = decodeURIComponent(hrefMatch[1]);
    }
    if (!ebayUsername) ebayUsername = text('.fdbk-detail-list__title .PSEUDOLINK') || null;

    const displayName = text('.str-seller-card__store-name h1 a')
        || text('.str-seller-card__store-name h1')
        || text('.x-sellercard-atf__info__about-seller a .ux-textspans--BOLD')
        || $('img.str-header__logo--img').first().attr('alt')?.trim()
        || $('title').first().text().match(/^(.+?)\s*[|–—]/)?.[1].trim()
        || null;

    let storeId: string | null = null;
    const trackAttr = $('[data-track*="soid"]').first().attr('data-track');
    if (trackAttr) {
        try {
            const trackData = JSON.parse(trackAttr);
            storeId = trackData?.eventProperty?.['ads-soid'] || trackData?.eventProperty?.soid || null;
        } catch (_) { /* ignore malformed data-track */ }
    }

    const logoUrl = resolveUrl($('img.str-header__logo--img').first().attr('src'), baseUrl);

    return { ratingElements, detailedRatingRows, storeStats, feedbackCountText, altPercentText, displayName, ebayUsername, storeId, logoUrl };
}

export interface StoreAboutRaw {
    aboutDescription: string | null;
    sellerInfoRows: { label: string; value: string }[];
    businessDetailRows: { label: string; value: string }[];
}

/** Raw rows off the store's about tab (`/str/{slug}?_tab=about`). */
export function readStoreAbout($: CheerioAPI): StoreAboutRaw {
    const readRows = (selector: string) => $(selector).toArray().map((el) => ({
        label: $(el).find('.SECONDARY').first().text().trim(),
        value: $(el).find('.BOLD').first().text().trim(),
    }));
    return {
        aboutDescription: $('.str-about-description__description .str-text-span').first().text().trim() || null,
        sellerInfoRows: readRows('.str-about-description__seller-info > span'),
        businessDetailRows: readRows('.str-business-details__seller-info > span'),
    };
}
