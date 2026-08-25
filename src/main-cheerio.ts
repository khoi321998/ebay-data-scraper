/*
Cheerio-based eBay scraper — performance benchmark vs main.js (Playwright).
Input shape identical: { mode, startUrls: [string, ...] }

Trade-off vs main.js:
  - 5-10x faster (no browser, no JS execution, smaller payload)
  - Only extracts SSR-rendered fields (title, price, breadcrumb, specs, condition, seller anchor, images, payments)
  - CANNOT do: shipping country dropdown, lazy-loaded reviews, tab-based content (Feedback/About on seller page),
    network-level apiEndpoints capture, scroll-triggered hydration

Usage: `node src/main-cheerio.js`  (or add npm script)
*/
import "dotenv/config";

import { Actor, log as runLog } from "apify";
import { CheerioCrawler, Dataset } from "crawlee";

import { currentActorRunId } from "./actor-run.js";
import type { ActorInput, CaptureMode, ParsedCurrency, Specification } from "./dto/index.js";
import { siteFor } from "./ebay-sites.js";
import { auditExtraction, emptyExtractionReport, type FieldCheck, logExtractionReport } from "./extraction-audit.js";
import { parseCurrency } from "./parse-currency.js";

const VALID_MODES = ["product_only", "seller_only", "product_and_seller"];

// This script pushes its own flat benchmark shape (not ScrapedItem), so it declares its own
// expectations. Same intent as SCRAPED_ITEM_CHECKS: a selector that stops matching shows up
// as `extraction.missingFields` instead of a silent null.
const CHEERIO_ITEM_CHECKS: FieldCheck[] = [
    { path: "product.id.platformItemId", severity: "critical", selector: "URL /itm/{id}" },
    { path: "product.title", severity: "critical", selector: "h1.x-item-title__mainTitle" },
    { path: "product.pricing.priceMin", severity: "critical", selector: "div.x-price-primary span.ux-textspans" },
    { path: "product.pricing.currency", severity: "warning", selector: "div.x-price-primary span.ux-textspans" },
    { path: "product.specifications", severity: "warning", selector: 'dl[data-testid="ux-labels-values"] | .x-about-this-item .ux-layout-section-evo__col' },
    { path: "product.brand", severity: "warning", selector: 'dl.ux-labels-values--brand dd | specifics "Brand"' },
    { path: "product.category.breadcrumb", severity: "warning", selector: "a.seo-breadcrumb-text" },
    { path: "product.condition.conditionText", severity: "warning", selector: "div.x-item-condition-text span.ux-textspans" },
    { path: "product.media.images", severity: "warning", selector: "i18n script blob → VIImageType" },
    { path: "sellerRef.displayName", severity: "warning", selector: ".x-sellercard-atf__info__about-seller a .ux-textspans--BOLD", when: (r) => r.sellerRef != null },
];

const CHEERIO_SELLER_CHECKS: FieldCheck[] = [
    { path: "seller.displayName", severity: "critical", selector: ".str-seller-card__store-name h1" },
    { path: "seller.ebayUsername", severity: "warning", selector: "URL /str|/usr slug" },
    { path: "seller.itemsSold", severity: "warning" },
    { path: "seller.storeItems", severity: "warning", selector: ".str-item-card" },
];

void (async () => {
    await Actor.init();

    runLog.info(`Actor run ID: ${currentActorRunId() ?? '(none — running locally)'}`);

    const input = await Actor.getInput<ActorInput>();
    const mode: CaptureMode = input?.mode || "product_and_seller";
    const inputUrls = input?.startUrls || input?.productUrls || input?.sellerUrls || [];

    if (!VALID_MODES.includes(mode)) {
        console.error(`Invalid mode: ${mode}. Must be one of ${VALID_MODES.join(", ")}`);
        return;
    }
    if (inputUrls.length === 0) {
        console.log("No startUrls provided!");
        return;
    }

    let startUrls;
    if (mode === "seller_only") {
        startUrls = inputUrls.map((url) => {
            const trimmed = url.replace(/\/+$/, "");
            const isHub = /\/sch\/i\.html/i.test(trimmed) || /\/sch\/[^/]+\/m\.html/i.test(trimmed);
            return {
                url: trimmed,
                label: isHub ? "SELLER_HUB" : "SELLER_STORE",
                userData: { sellerBaseUrl: trimmed },
            };
        });
    } else {
        startUrls = inputUrls.map((url) => {
            const u = new URL(url);
            u.searchParams.set("rt", "nc");
            u.searchParams.set("_ipg", "1");
            u.searchParams.set("location", "US");
            console.log(`[cheerio] ITEM start URL: ${u.toString()}`);
            return {
                url: u.toString(),
                label: "ITEM",
                userData: {},
            };
        });
    }

    // Benchmark script — one marketplace per run, so the proxy country is taken from the first
    // start URL rather than dispatched per request the way main.ts does it.
    const benchCountry = siteFor(startUrls[0]?.url ?? "").countryCode;
    const proxyConfiguration = await Actor.createProxyConfiguration({
        groups: ["RESIDENTIAL"],
        countryCode: benchCountry,
    });
    console.log(`[cheerio] Using Apify RESIDENTIAL proxy (${benchCountry})`);

    // ─── perf instrumentation ───
    const benchStart = Date.now();
    let itemsPushed = 0;
    const handlerTimes: { label: string; ms: number }[] = [];

    const crawler = new CheerioCrawler({
        proxyConfiguration,
        requestHandlerTimeoutSecs: 60,
        navigationTimeoutSecs: 30,
        minConcurrency: 1,
        maxConcurrency: 3,
        maxRequestRetries: 5,
        useSessionPool: true,
        persistCookiesPerSession: true,
        sessionPoolOptions: { maxPoolSize: 20 },
        // No manual header override here. got-scraping (the HTTP engine
        // CheerioCrawler uses) auto-generates a coherent Chrome fingerprint —
        // User-Agent + sec-ch-ua + sec-fetch-* + Accept-* + header order +
        // TLS ALPN — that matches a real browser. Setting User-Agent manually
        // breaks the coherence and Akamai (eBay's bot wall) detects it.
        preNavigationHooks: [
            async ({ session, request, sendRequest, log }) => {
                if (!session) return;
                if (request.userData?.isWarmup) return;
                // Akamai requires cookies (s, npii, dp1) set by the homepage
                // before /itm/* requests succeed. Warm the session by hitting
                // ebay.com once. sendRequest reuses the session's cookie jar
                // and proxy, so the subsequent navigation inherits cookies.
                // Cookies are per-marketplace — .ebay.es never gets them from ebay.com — so warm
                // the origin this request is headed for.
                const { origin } = siteFor(request.url);
                const cookieStr = session.getCookieString?.(origin) || "";
                if (!cookieStr) {
                    try {
                        const res = await sendRequest({
                            url: `${origin}/`,
                            method: "GET",
                            responseType: "text",
                        });
                        log.info(`[cheerio] warmup ${origin} status=${res.statusCode} cookies=${(session.getCookieString?.(origin) || "").length}b`);
                    } catch (e) {
                        log.warning(`[cheerio] warm-up failed: ${(e as Error).message}`);
                    }
                }
            },
        ],
        failedRequestHandler: async ({ request, log, response }, error) => {
            log.error(`[cheerio] failed: ${request.url}`, {
                label: request.label,
                retryCount: request.retryCount,
                statusCode: response?.statusCode,
                error: error?.message,
            });
        },
    });

    // ──────────────────── ITEM ────────────────────
    crawler.router.addHandler("ITEM", async ({ $, request, log }) => {
        const t0 = Date.now();

        const platformMatch = request.url.match(/\/itm\/(?:[^/]+\/)?(\d+)/);
        const platformItemId = platformMatch ? platformMatch[1] : null;
        const site = siteFor(request.url);

        const title = $("h1.x-item-title__mainTitle").text().trim() || null;
        let brand = $("dl.ux-labels-values--brand dd").text().trim() || null;
        let mpn = $("dl.ux-labels-values--mpn dd.ux-labels-values__values span.ux-textspans").text().trim() || null;
        let upc = $("dl.ux-labels-values--upc dd.ux-labels-values__values span.ux-textspans").text().trim() || null;
        let ean = $("dl.ux-labels-values--ean dd.ux-labels-values__values span.ux-textspans").text().trim() || null;

        const rawPriceTexts: string[] = [];
        $("div.x-price-primary span.ux-textspans").each((_i, el) => { rawPriceTexts.push($(el).text().trim()); });
        const prices: ParsedCurrency[] = [];
        rawPriceTexts.forEach((text) => {
            text.split(/\s+to\s+/i).forEach((part) => {
                const parsed = parseCurrency(part, site.currency);
                if (parsed) prices.push(parsed);
            });
        });
        const priceValues = prices.map((p) => p.cost);
        const priceMin = priceValues.length ? Math.min(...priceValues) : null;
        const priceMax = priceValues.length ? Math.max(...priceValues) : null;
        const currency = prices[0]?.currency || site.currency;

        const breadcrumb: string[] = [];
        $("a.seo-breadcrumb-text").each((_i, el) => { breadcrumb.push($(el).find("span").text().trim()); });

        const conditionText = $("div.x-item-condition-text span.ux-textspans").first().text().trim() || null;

        let availableQuantity = null;
        let soldCount = null;
        $("div.x-quantity__availability span").each((_i, el) => {
            const t = $(el).text().trim();
            if (t.toLowerCase().includes("last one")) {
                availableQuantity = 1;
                return;
            }
            const num = parseInt(t.match(/([\d,]+)/)?.[1]?.replace(/,/g, "") || "", 10) || null;
            if (/available/i.test(t)) availableQuantity = num;
            if (/sold/i.test(t)) soldCount = num;
        });

        const itemLocationText =
            $("div.ux-labels-values--shipping span.ux-textspans.ux-textspans--SECONDARY").text().trim() || null;

        const specifications: Specification[] = [];
        const seenSpecs = new Set<string>();
        // Two layouts in the wild: the legacy one puts every pair in its own
        // `dl[data-testid="ux-labels-values"]`, the newer "evo" one puts them all in a single
        // `dl.ux-layout-section-evo__item` split into `.ux-layout-section-evo__col` cells.
        // The dt/dd class names are identical in both, so one pass over either row container works.
        $('dl[data-testid="ux-labels-values"], .x-about-this-item .ux-layout-section-evo__col').each((_i, el) => {
            const name = $(el).find("dt.ux-labels-values__labels").text().replace(/\s+/g, " ").trim();
            // Clone the value cell and strip the collapsed hidden duplicate, screen-reader-only
            // (.clipped) text, and inline actions — e.g. Condition's "Read more" / "See all
            // condition definitions" / "opens in a new window or tab" — before reading text.
            const $value = $(el).find("dd.ux-labels-values__values").clone();
            $value.find('[aria-hidden="true"], .clipped, [data-testid="ux-action"]').remove();
            const value = $value.text().replace(/\s+/g, " ").trim();
            if (!name || !value || seenSpecs.has(name.toLowerCase())) return;
            seenSpecs.add(name.toLowerCase());
            specifications.push({ name, value });
        });

        // The evo layout dropped the `ux-labels-values--<field>` modifier classes the selectors
        // above rely on, so fall back to the parsed specifics table for the identity fields.
        const specValue = (label: string) =>
            specifications.find((s) => s.name.toLowerCase() === label)?.value || null;
        brand ??= specValue("brand");
        mpn ??= specValue("mpn");
        upc ??= specValue("upc");
        ean ??= specValue("ean");
        const gtin = upc || ean || null;

        // Seller info from product page
        const sellerAnchor = $(".x-sellercard-atf__info__about-seller a");
        const sellerProfileUrl = sellerAnchor.attr("href") || null;
        const sellerDisplayName = sellerAnchor.find(".ux-textspans--BOLD").text().trim() || null;

        // Pull a few signals from the i18n script blob (same source main.js uses)
        const scriptContent =
            $("script")
                .filter((_i, el) => ($(el).html() || "").includes("Object.assign($i18n=window.$i18n"))
                .first()
                .html() || "";
        const ebayUsername = scriptContent.match(/"entity_id"\s*:\s*"~([^"]+)"/)?.[1] || null;

        // Images from PICTURE.mediaList JSON (same approach as main.js). IMPORTANT:
        // only eBay-hosted images carry an "imageId"; the seller's own CloudFront
        // images do NOT. Requiring "imageId" made the lazy scan jump past every
        // CloudFront image to the next eBay imageId (91 gallery images collapsed to
        // 2). We drop the imageId requirement and use [^{}] to keep each match
        // inside the thumbnail object so it can't skip across mediaList items.
        const mediaRegex =
            /"_type":"VIImageType","thumbnail":\{[^{}]*?"title":"([^"]+)"[^{}]*?"URL":"([^"]+)"/g;
        const images = [...scriptContent.matchAll(mediaRegex)]
            .filter((m) => !m[1].toLowerCase().includes("video"))
            // Upscale eBay thumbnails (s-l140) to full-res; CloudFront URLs untouched.
            .map((m) => ({ url: m[2].replace(/s-l140\.(webp|jpg|jpeg|png)/i, "s-l1600.$1") }));

        const elapsed = Date.now() - t0;
        handlerTimes.push({ label: "ITEM", ms: elapsed });
        log.info(`[cheerio] ITEM scraped in ${elapsed}ms`, { url: request.url, title: title?.slice(0, 60) });

        const item = {
            platform: "ebay",
            url: request.url,
            capturedAt: new Date().toISOString(),
            captureMode: mode,
            crawler: "cheerio",
            scrapeDurationMs: elapsed,
            product: {
                id: { platformItemId, otherIds: { mpn, upc, ean, gtin } },
                title,
                brand,
                category: { breadcrumb },
                pricing: { currency, priceMin, priceMax },
                stock: { availableQuantity, soldCount },
                condition: { conditionText },
                origin: { itemLocationText },
                specifications,
                media: { images },
            },
            sellerRef:
                mode === "product_only"
                    ? null
                    : { profileUrl: sellerProfileUrl, displayName: sellerDisplayName, ebayUsername },
            extraction: emptyExtractionReport(),
        };
        item.extraction = auditExtraction(item, CHEERIO_ITEM_CHECKS);
        logExtractionReport(item.extraction, log, request.url);

        itemsPushed++;
        await Dataset.pushData(item);

        // For product_and_seller: chain to seller page if we have a URL
        if (mode === "product_and_seller" && sellerProfileUrl) {
            try {
                const absUrl = new URL(sellerProfileUrl, site.origin).toString().replace(/\/+$/, "");
                const isHub =
                    /\/sch\/i\.html/i.test(absUrl) || /\/sch\/[^/]+\/m\.html/i.test(absUrl);
                await crawler.addRequests([
                    {
                        url: absUrl,
                        label: isHub ? "SELLER_HUB" : "SELLER_STORE",
                        userData: { sellerBaseUrl: absUrl, parentItemId: platformItemId },
                    },
                ]);
            } catch (_) {}
        }
    });

    // ──────────────────── SELLER_HUB (resolve real seller URL) ────────────────────
    crawler.router.addHandler("SELLER_HUB", async ({ $, request, log }) => {
        const t0 = Date.now();
        let resolved =
            $(".str-seller-card__store-name h1 a").attr("href") ||
            $("a.str-profile-link").attr("href") ||
            $('a[href*="/str/"], a[href*="/usr/"]').first().attr("href") ||
            null;

        if (!resolved) {
            try {
                const hubSite = siteFor(request.url);
                const parsed = new URL(request.url, hubSite.origin);
                const slug =
                    parsed.pathname.match(/\/sch\/([^/]+)\/m\.html/i)?.[1] ||
                    parsed.searchParams.get("_ssn") ||
                    parsed.searchParams.get("store_name");
                if (slug && slug !== "i.html") resolved = `${hubSite.origin}/usr/${slug}`;
            } catch (_) {}
        }

        const elapsed = Date.now() - t0;
        handlerTimes.push({ label: "SELLER_HUB", ms: elapsed });
        log.info(`[cheerio] SELLER_HUB resolved in ${elapsed}ms → ${resolved}`);

        if (!resolved) {
            log.warning(`[cheerio] SELLER_HUB: could not resolve`, { url: request.url });
            return;
        }
        const cleaned = resolved.split("?")[0].replace(/\/+$/, "");
        await crawler.addRequests([
            { url: cleaned, label: "SELLER_STORE", userData: { sellerBaseUrl: cleaned } },
        ]);
    });

    // ──────────────────── SELLER_STORE (basic info, no tab clicks) ────────────────────
    crawler.router.addHandler("SELLER_STORE", async ({ $, request, log }) => {
        const t0 = Date.now();
        const sellerBaseUrl = request.userData.sellerBaseUrl || request.url;

        const slugMatch = sellerBaseUrl.match(/\/(?:str|usr)\/([^/?]+)/i);
        const ebayUsername = slugMatch ? slugMatch[1] : null;

        const displayName =
            $(".str-seller-card__store-name h1 a").text().trim() ||
            $(".str-seller-card__store-name h1").text().trim() ||
            $("img.str-header__logo--img").attr("alt")?.trim() ||
            null;

        const logoUrl = $("img.str-header__logo--img").attr("src") || null;

        const parseAbbreviated = (text: string | null | undefined): number | null => {
            if (!text) return null;
            const m = text.match(/([\d,.]+)\s*([KMB]?)/i);
            if (!m) return null;
            let num = parseFloat(m[1].replace(/,/g, ""));
            const suffix = m[2].toUpperCase();
            if (suffix === "K") num *= 1000;
            else if (suffix === "M") num *= 1e6;
            else if (suffix === "B") num *= 1e9;
            return Math.round(num);
        };

        let itemsSold = null;
        let followers = null;
        $(".str-seller-card__store-stats-content > div").each((_i, el) => {
            const text = $(el).text().trim().toLowerCase();
            const boldText = $(el).find(".BOLD").text().trim();
            if (text.includes("items sold")) itemsSold = parseAbbreviated(boldText);
            else if (text.includes("follower")) followers = parseAbbreviated(boldText);
        });

        // Limited store items (only what's in initial SSR HTML)
        const storeItems: { name: string | null; imageUrl: string | null; currency: string | null; priceMin: number | null; priceMax: number | null; url: string | null }[] = [];
        $("article.str-item-card").each((_i, el) => {
            if (storeItems.length >= 10) return;
            const name = $(el).find(".str-item-card__property-title .str-text-span").text().trim() || null;
            const imageUrl = $(el).find('img[data-testid="str-img"]').attr("src") || null;
            const priceText = $(el).find(".str-item-card__property-displayPrice").text().trim() || null;
            const url = $(el).find("a.str-item-card__link").attr("href") || null;
            if (name) {
                let priceMin = null;
                let priceMax = null;
                let currency = null;
                if (priceText) {
                    const storeCurrency = siteFor(request.url).currency;
                    const parts = priceText.split(/\s+to\s+/i);
                    const fromParsed = parseCurrency(parts[0]?.trim(), storeCurrency);
                    if (fromParsed) {
                        priceMin = fromParsed.cost;
                        currency = fromParsed.currency;
                    }
                    if (parts.length > 1) {
                        const toParsed = parseCurrency(parts[1]?.trim(), storeCurrency);
                        if (toParsed) priceMax = toParsed.cost;
                    }
                }
                storeItems.push({ name, imageUrl, currency, priceMin, priceMax, url });
            }
        });

        const elapsed = Date.now() - t0;
        handlerTimes.push({ label: "SELLER_STORE", ms: elapsed });
        log.info(`[cheerio] SELLER_STORE scraped in ${elapsed}ms`, {
            displayName,
            itemsSold,
            followers,
            storeItemsCount: storeItems.length,
        });

        const sellerData = {
            platform: "ebay",
            url: request.url,
            capturedAt: new Date().toISOString(),
            captureMode: mode,
            crawler: "cheerio",
            scrapeDurationMs: elapsed,
            recordType: "seller",
            seller: {
                profileUrl: sellerBaseUrl,
                displayName,
                ebayUsername,
                logoUrl,
                itemsSold,
                followers,
                storeItems,
            },
            extraction: emptyExtractionReport(),
        };
        sellerData.extraction = auditExtraction(sellerData, CHEERIO_SELLER_CHECKS);
        logExtractionReport(sellerData.extraction, log, request.url);

        if (mode === "seller_only") {
            itemsPushed++;
            await Dataset.pushData(sellerData);
        }
        // For product_and_seller, the ITEM record was already pushed; we only
        // log seller fields here — extending the ITEM record across requests
        // would require a shared store, which is out of scope for the benchmark.
    });

    await crawler.run(startUrls);

    const totalMs = Date.now() - benchStart;
    const byLabel = handlerTimes.reduce<Record<string, { count: number; totalMs: number }>>((acc, h) => {
        if (!acc[h.label]) acc[h.label] = { count: 0, totalMs: 0 };
        acc[h.label].count++;
        acc[h.label].totalMs += h.ms;
        return acc;
    }, {});
    const summary = Object.entries(byLabel).map(([label, s]) => ({
        label,
        count: s.count,
        avgMs: Math.round(s.totalMs / s.count),
        totalMs: s.totalMs,
    }));

    console.log("─".repeat(60));
    console.log("[cheerio] BENCHMARK RESULTS");
    console.log("─".repeat(60));
    console.log(`Mode:            ${mode}`);
    console.log(`Input URLs:      ${inputUrls.length}`);
    console.log(`Items pushed:    ${itemsPushed}`);
    console.log(`Total wall time: ${totalMs}ms (${(totalMs / 1000).toFixed(2)}s)`);
    console.log(`Avg per item:    ${itemsPushed ? Math.round(totalMs / itemsPushed) : 0}ms`);
    console.log(`Per-handler:`);
    summary.forEach((s) => {
        console.log(`  ${s.label.padEnd(15)} count=${s.count}  avg=${s.avgMs}ms  total=${s.totalMs}ms`);
    });
    console.log("─".repeat(60));

    await Actor.exit();
})();
