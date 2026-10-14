/*
HTML fetched through the browser session, without rendering it.

Why not a plain HTTP client: a 2026-10-14 probe got eBay's `/splashui/captcha` on store tabs from
`got-scraping` even with a fresh cookie jar and header fingerprint per session, while a Playwright
page on the same IP, minutes later, loaded the same URLs clean. It is not about cookies earned by
the bot managers' sensor scripts — a fresh browser parked on `/robots.txt` (no JS ran, no `_abck`)
fetched `/itm/` fine — so what Akamai trusts is a request that comes from a real Chrome.

So the request goes out *from the page the crawler already has open*: `fetch()` inside it uses
Chrome's network stack, the session's cookies and the browser's proxy — the same identity that just
loaded a page — but nothing is parsed, painted, or followed up with CSS, images and scripts.
`fetch()` is bound by CORS, so a URL on another origin goes through `context.request` instead,
which still carries the context's cookies and proxy.
*/
import type { CheerioAPI } from 'cheerio';
import * as cheerio from 'cheerio';
import type { Log } from 'crawlee';
import type { Page } from 'playwright';

import { isCaptchaUrl } from './page-parsers.js';
import { isWalled } from './scrape-status.js';

const FETCH_TIMEOUT_MS = 20000;

interface RawResponse {
    status: number;
    url: string;
    html: string;
}

async function rawFetch(page: Page, url: string): Promise<RawResponse> {
    let sameOrigin = false;
    try { sameOrigin = new URL(url).origin === new URL(page.url()).origin; } catch (_) { /* fall through */ }

    if (sameOrigin) {
        return page.evaluate(async ({ target, timeoutMs }) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const res = await fetch(target, { credentials: 'include', signal: controller.signal });
                return { status: res.status, url: res.url, html: await res.text() };
            } finally {
                clearTimeout(timer);
            }
        }, { target: url, timeoutMs: FETCH_TIMEOUT_MS });
    }
    const res = await page.context().request.get(url, { timeout: FETCH_TIMEOUT_MS, failOnStatusCode: false });
    return { status: res.status(), url: res.url(), html: await res.text() };
}

/**
 * Fetch `url` through `page`'s session and parse it, or `null` when the page did not give us what
 * we came for — an error status, the captcha, the bot wall, or no sign of the expected content
 * (`isReady`). `null` is the caller's cue for its fallback (usually rendering the page), which the
 * caller logs itself.
 */
export async function fetchHtml(
    page: Page,
    url: string,
    isReady: ($: CheerioAPI, finalUrl: string) => boolean,
    log: Log,
    label: string,
): Promise<{ $: CheerioAPI; url: string } | null> {
    const t0 = Date.now();
    let res: RawResponse;
    try {
        res = await rawFetch(page, url);
    } catch (err) {
        log.warning(`${label}: HTML fetch failed — not using it`, { url, error: (err as Error).message });
        return null;
    }
    const ms = Date.now() - t0;
    if (isCaptchaUrl(res.url)) {
        log.warning(`${label}: HTML fetch hit the captcha — not using it`, { url, ms });
        return null;
    }
    if (res.status >= 400) {
        log.warning(`${label}: HTML fetch got HTTP ${res.status} — not using it`, { url, ms });
        return null;
    }
    const $ = cheerio.load(res.html);
    if (isWalled($)) {
        log.warning(`${label}: HTML fetch got a page without eBay chrome — not using it`, { url, ms });
        return null;
    }
    if (!isReady($, res.url)) {
        log.warning(`${label}: HTML fetch lacks the expected content — not using it`, { url, ms });
        return null;
    }
    log.info(`${label}: fetched as HTML in ${ms}ms (${Math.round(res.html.length / 1024)} KB)`, { url });
    return { $, url: res.url };
}
