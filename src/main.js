/*
Unified eBay scraper supporting three modes.
Input: {
  "mode": "product_only" | "seller_only" | "product_with_seller",
  "startUrls": [ "<url>", ... ]
}

Flows:
  product_only         ITEM → DESCRIPTION → ITEM_REVIEWS (negative ∥ positive) → pushData
  seller_only          (SELLER_HUB if hub URL →) SELLER_STORE → SELLER_REVIEWS (negative ∥ positive) → pushData
  product_with_seller  ITEM → DESCRIPTION → ITEM_REVIEWS (negative ∥ positive)
                        → (SELLER_HUB →) SELLER_STORE → SELLER_REVIEWS (negative ∥ positive) → pushData

Response shape is stable across modes. Fields not applicable to a given mode are null:
  - product_only  →  seller = null, sellerRef = null, sellerTechnical = null
  - seller_only   →  product = null, technical = null
*/
import { PlaywrightCrawler, ProxyConfiguration, Dataset } from "crawlee";
import got from "got";
import * as cheerio from "cheerio";
import fs from "fs/promises";
import fsSync from "fs";
import 'dotenv/config';
import countries from "i18n-iso-countries";
import { Actor } from 'apify';

const en = JSON.parse(fsSync.readFileSync('./node_modules/i18n-iso-countries/langs/en.json', 'utf8'));
countries.registerLocale(en);

function parseCurrency(input) {
    if (!input) return null;
    const currencyMap = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR' };
    const symbolMatch = input.match(/([$€£¥₹])\s*([\d,]+(?:\.\d+)?)/);
    if (symbolMatch) {
        const amount = parseFloat(symbolMatch[2].replace(/,/g, ''));
        return { currency: currencyMap[symbolMatch[1]] || symbolMatch[1], cost: amount };
    }
    const isoMatch = input.match(/([A-Z]{3})\s*([\d,]+(?:\.\d+)?)/);
    if (isoMatch) {
        const amount = parseFloat(isoMatch[2].replace(/,/g, ''));
        return { currency: isoMatch[1], cost: amount };
    }
    const isoSuffixMatch = input.match(/([\d,]+(?:\.\d+)?)\s*([A-Z]{3})/);
    if (isoSuffixMatch) {
        const amount = parseFloat(isoSuffixMatch[1].replace(/,/g, ''));
        return { currency: isoSuffixMatch[2], cost: amount };
    }
    return null;
}

function getEstimatedDaysLeft(dateText) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let currentYear = today.getFullYear();
    let targetDate = new Date(`${dateText} ${currentYear}`);
    if (targetDate < today) {
        targetDate = new Date(`${dateText} ${currentYear + 1}`);
    }
    const diffMs = targetDate - today;
    return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

function makePhaseLogger(log, label) {
    const t0 = Date.now();
    let last = t0;
    return (name) => {
        const now = Date.now();
        const step = ((now - last) / 1000).toFixed(2);
        const total = ((now - t0) / 1000).toFixed(2);
        log.info(`[${label}] ${name} | step=${step}s | total=${total}s`);
        last = now;
    };
}

function emptySellerSection() {
    return {
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
            positiveReviewSamples: []
        },
        totalSellerFeedbackCount: null,
        about: null,
        logoUrl: null,
        storeItems: []
    };
}

const VALID_MODES = ['product_only', 'seller_only', 'product_with_seller'];

(async () => {
    await Actor.init();

    let mode = 'product_with_seller';
    let inputUrls = [];
    let extractShippingOptions = false;
    try {
        const input = await Actor.getInput();
        mode = input?.mode || 'product_with_seller';
        inputUrls = input?.startUrls || input?.productUrls || input?.sellerUrls || [];
        extractShippingOptions = input?.extractShippingOptions === true;
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

    // Build startUrls based on mode
    let startUrls;
    if (mode === 'seller_only') {
        startUrls = inputUrls.map(url => {
            const trimmed = url.replace(/\/+$/, '');
            const isHub = /\/sch\/i\.html/i.test(trimmed) || /\/sch\/[^/]+\/m\.html/i.test(trimmed);
            const seed = {
                platform: "ebay",
                url: trimmed,
                capturedAt: new Date().toISOString(),
                captureMode: mode,
                product: null,
                sellerRef: null,
                seller: emptySellerSection(),
                technical: null,
                sellerTechnical: null
            };
            seed.seller.profileUrl = trimmed;
            const slugMatch = trimmed.match(/\/(?:str|usr)\/([^/?]+)/i);
            if (slugMatch) seed.seller.ebayUsername = slugMatch[1];
            return {
                url: trimmed,
                label: isHub ? 'SELLER_HUB' : 'SELLER_STORE',
                userData: isHub ? { scrappedItem: seed } : { scrappedItem: seed, sellerBaseUrl: trimmed }
            };
        });
    } else {
        // product_only and product_with_seller both start at ITEM
        startUrls = inputUrls.map(url => ({
            url: `${url}?rt=nc&_ipg=1&location=US`,
            label: 'ITEM',
            userData: {}
        }));
    }

    const proxyConfiguration = await Actor.createProxyConfiguration({
        groups: ['RESIDENTIAL'],
        countryCode: 'US',
    });
    console.log('Using Apify RESIDENTIAL proxy');

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        requestHandlerTimeoutSecs: 300,
        minConcurrency: 1,
        maxConcurrency: 3,
        maxRequestRetries: 5,
        useSessionPool: true,
        sessionPoolOptions: { maxPoolSize: 20 },
        // eBay constantly swaps ad/payment iframes; walking them in parseWithCheerio
        // races the DOM and produces "Frame was detached" warnings. We never read
        // iframe content here, so skip the walk entirely.
        ignoreIframes: true,
        launchContext: {
            launchOptions: {
                headless: true,
                args: ['--disable-blink-features=AutomationControlled'],
            },
        },
        preNavigationHooks: [
            async ({ page, request }) => {
                // NOTE: do NOT use page.route() to block images/fonts/etc on www.ebay.com.
                // It changes the resource-loading fingerprint and Akamai serves
                // /splashui/captcha challenges on /fdbk/* (review/feedback) endpoints.
                // Tested 2026-05-07: blocking caused all review URLs to hit captcha.
                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Upgrade-Insecure-Requests': '1',
                });
                await page.addInitScript(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                    window.chrome = { runtime: {} };
                });
                // Warm session on first visit to avoid Akamai cold-start 403
                if (request.label === 'ITEM' || request.label === 'SELLER_STORE' || request.label === 'SELLER_HUB') {
                    const cookies = await page.context().cookies('https://www.ebay.com');
                    if (cookies.length === 0) {
                        await page.goto('https://www.ebay.com', { waitUntil: 'domcontentloaded', timeout: 15000 })
                            .catch(() => {});
                        await page.waitForTimeout(1500 + Math.random() * 1000);
                    }
                }
            }
        ],
        postNavigationHooks: [
            async ({ page, request, response, log }) => {
                const status = response?.status();
                if (!status || status < 400) return;
                const headers = response.headers();
                log.error(`POST-NAV ${status} on ${request.url}`, {
                    label: request.label,
                    retryCount: request.retryCount,
                    cfRay: headers['cf-ray'] || null,
                    server: headers['server'] || null,
                    contentType: headers['content-type'] || null,
                    xEbayC: headers['x-ebay-c-tracking'] || null,
                });
                const body = await response.text().catch(() => '');
                log.error(`Response body snippet (first 800 chars)`, { snippet: body.slice(0, 800) });
                const screenshotPath = `debug_403_${Date.now()}.png`;
                await page.screenshot({ path: screenshotPath, fullPage: false }).catch((e) => {
                    log.warning(`Screenshot failed: ${e.message}`);
                });
                log.error(`Screenshot saved → ${screenshotPath}`);
            },
        ],
        failedRequestHandler: async ({ request, log }, error) => {
            log.error(`Request failed: ${request.url}`, {
                label: request.label,
                retryCount: request.retryCount,
                error: error?.message || 'Unknown error',
            });
        },
    });

    // ──────────────────── ITEM ────────────────────
    crawler.router.addHandler("ITEM", async ({ page, request, parseWithCheerio, log }) => {
        const phase = makePhaseLogger(log, 'ITEM');
        phase('handler start');

        // Extract item ID from URL up-front (no page load needed) so we can
        // kick off the description HTTP fetch in parallel with the Playwright
        // page work. The ~1-3.5s of network latency hides inside the page-load
        // time entirely instead of being added on at the end.
        const platformMatch = request.url.match(/\/itm\/(?:[^/]+\/)?(\d+)/);
        const platformItemId = platformMatch ? platformMatch[1] : null;

        // Plain `got` (not gotScraping) — itm.ebaydesc.com has no Akamai, no
        // browser fingerprint needed. No proxy needed either.
        const descriptionPromise = platformItemId
            ? got({
                url: `https://itm.ebaydesc.com/itmdesc/${platformItemId}`,
                timeout: { request: 15000 },
                headers: { referer: request.url },
                throwHttpErrors: false,
                retry: { limit: 1 },
            }).catch((err) => {
                log.warning(`DESCRIPTION fetch failed: ${err.message}`, { itemId: platformItemId });
                return null;
            })
            : Promise.resolve(null);

        const apiEndpoints = [];
        const requestTracker = (req) => {
            const resourceType = req.resourceType();
            if (resourceType === 'xhr' || resourceType === 'fetch') {
                apiEndpoints.push(req.url());
            }
        };
        page.on('request', requestTracker);

        // Resolve as soon as the critical listing DOM is painted (title + price).
        // Falls through after 20s max if eBay's slow; cheerio parsing tolerates partial DOM.
        await page.waitForSelector('h1.x-item-title__mainTitle, div.x-price-primary', { timeout: 20000 })
            .catch(() => log.warning('ITEM: main title/price not rendered within 20s'));
        phase('main DOM rendered (h1/price wait)');
        const $ = await parseWithCheerio();
        phase('first parseWithCheerio done');

        const url = request.url;
        // platformItemId already extracted at handler start (above) for parallel description fetch

        const mpn = $('dl.ux-labels-values--mpn dd.ux-labels-values__values span.ux-textspans').text().trim() || null;
        const upc = $('dl.ux-labels-values--upc dd.ux-labels-values__values span.ux-textspans').text().trim() || null;
        const ean = $('dl.ux-labels-values--ean dd.ux-labels-values__values span.ux-textspans').text().trim() || null;
        const gtin = upc || ean || null;
        const modelNumber = $('dl.ux-labels-values--model dd.ux-labels-values__values span.ux-textspans').text().trim() || null;
        const title = $('h1[class="x-item-title__mainTitle"]').text().trim();
        const brandEl = $('dl.ux-labels-values--brand dd');
        const brand = brandEl.length ? brandEl.text().trim() || null : null;

        const scriptContent = $('script')
            .filter((i, el) => ($(el).html() || "").includes('Object.assign($i18n=window.$i18n'))
            .first()
            .html() || "";

        const sellerAnchor = $('.x-sellercard-atf__info__about-seller a');
        const profileUrl = sellerAnchor.attr('href') || null;
        const displayName = sellerAnchor.find('.ux-textspans--BOLD').text().trim() || null;
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
                    const parsed = new URL(profileUrl, 'https://www.ebay.com');
                    const storeName = parsed.searchParams.get('store_name') || parsed.searchParams.get('_ssn');
                    if (storeName) platformSellerId = storeName;
                    else {
                        const schMatch = profileUrl.match(/\/sch\/([^/?]+)\/m\.html/i);
                        if (schMatch && schMatch[1] !== 'i.html') platformSellerId = schMatch[1];
                    }
                } catch (_) {}
            }
        }

        await fs.writeFile('scriptContent.js', scriptContent).catch(err => console.error('Error logging script:', err));

        const rawPriceTexts = [];
        $('div.x-price-primary span.ux-textspans').each((_i, el) => {
            rawPriceTexts.push($(el).text().trim());
        });
        const prices = [];
        rawPriceTexts.forEach(text => {
            text.split(/\s+to\s+/i).forEach(part => {
                const parsed = parseCurrency(part);
                if (parsed) prices.push(parsed);
            });
        });
        const priceValues = prices.map(p => p.cost);
        const priceMin = priceValues.length ? Math.min(...priceValues) : null;
        const priceMax = priceValues.length ? Math.max(...priceValues) : null;
        const currency = prices[0]?.currency || 'USD';

        const breadcrumb = [];
        const categoryPathIds = [];
        $('a.seo-breadcrumb-text').each((i, el) => {
            breadcrumb.push($(el).find('span').text().trim());
            const match = $(el).attr('href').match(/\/b\/[^/]+\/(\d+)\//);
            if (match) categoryPathIds.push(match[1]);
        });
        const leafCategoryName = breadcrumb.length ? breadcrumb[breadcrumb.length - 1] : null;
        const leafCategoryId = categoryPathIds.length ? categoryPathIds[categoryPathIds.length - 1] : null;

        let availableQuantity = null;
        let soldCount = null;
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

        const specifications = [];
        $('dl[data-testid="ux-labels-values"]').each((i, el) => {
            const name = $(el).find('dt.ux-labels-values__labels').text().trim();
            const value = $(el).find('dd.ux-labels-values__values').text().trim();
            if (name && value) specifications.push({ name, value });
        });

        let itemLocationText = $('div.ux-labels-values--shipping').find('span.ux-textspans.ux-textspans--SECONDARY').text().trim() || null;
        let itemCountryCode = null;
        if (itemLocationText) {
            itemLocationText = itemLocationText.replace('Located in:', '').trim();
            const parts = itemLocationText.split(',');
            let country = parts[parts.length - 1].trim().replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
            itemCountryCode = countries.getAlpha2Code(country, "en") || null;
        }

        phase('cheerio metadata extracted');

        await page.evaluate(() => {
            const el = document.querySelector('.x-feedback-detail-list, .ux-summary__start--rating, [class*="reviews"]');
            if (el) el.scrollIntoView();
        });
        // Reduced from 8s to 3s. Widget often lazy-loads beyond 3s but rating
        // data is non-critical and items without reviews never render the widget anyway.
        await page.waitForSelector('span.ux-summary__start--rating, div.ux-histogram__item--bar', { timeout: 3000 }).catch(() => {});
        phase('rating section ready (scroll+wait)');

        const { rating, reviewCount, ratingBreakdown } = await page.evaluate(() => {
            const ratingText = document.querySelector('span.ux-summary__start--rating .ux-textspans')?.textContent?.trim() || '';
            const rating = parseFloat(ratingText) || null;
            const tabText = document.querySelector('div.x-feedback-detail-list .tabs__item')?.textContent?.trim() || '';
            const tabMatch = tabText.match(/\((\d[\d,]*)\)/);
            const countText = document.querySelector('span.ux-summary__count .ux-textspans')?.textContent?.trim() || '';
            const reviewCount = tabMatch
                ? parseInt(tabMatch[1].replace(/,/g, ''), 10)
                : parseInt(countText.split(' ')[0]) || null;
            const ratingBreakdown = {};
            document.querySelectorAll('div.ux-histogram__item--bar').forEach(el => {
                const stars = parseInt(el.querySelector('.ux-histogram__item--bar--stars')?.textContent?.trim() || '');
                const count = parseInt(el.querySelector('.ux-histogram__item--bar--c span')?.textContent?.trim() || '');
                if (!isNaN(stars) && !isNaN(count)) ratingBreakdown[stars] = count;
            });
            return { rating, reviewCount, ratingBreakdown };
        });

        const mediaRegex = /"_type"\s*:\s*"VIImageType"[\s\S]*?"thumbnail"\s*:\s*\{[\s\S]*?"title"\s*:\s*"([^"]+)"[\s\S]*?"imageId"\s*:\s*"([^"]+)"[\s\S]*?"URL"\s*:\s*"([^"]+)"/g;
        const mediaMatches = [...scriptContent.matchAll(mediaRegex)];
        const images = mediaMatches.map((m, i) => {
            const url = m[3].replace("s-l140.webp", "s-l960.webp");
            const alt = m[1];
            if (!alt.toLowerCase().includes("video")) {
                return { url, variantKey: m[2], isMain: (i === 0) };
            }
        }).filter(Boolean);

        const paymentsSectionRegex = /"payments"\s*:\s*\{[\s\S]*?"values"\s*:\s*\[\s*\{[\s\S]*?"textSpans"\s*:\s*\[([\s\S]*?)\]\s*\}\s*\]/m;
        const paymentsMatch = scriptContent.match(paymentsSectionRegex);
        let paymentMethods = [];
        if (paymentsMatch) {
            const spanRegex = /"accessibilityText"\s*:\s*"([^"]+)"/g;
            paymentMethods = [...paymentsMatch[1].matchAll(spanRegex)].map(m => m[1]);
        }

        // const scriptBlocks = await page.$$eval('script', scripts => scripts.map(s => s.textContent).filter(Boolean));
        const scriptBlocks = [];
        const jsonState = {};
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
        const dataAttributes = {};

        const googleAnalytics = await page.$$eval('script', scripts => {
            const ids = [];
            scripts.forEach(s => {
                if (s.src?.includes('googletagmanager')) {
                    const m = s.src.match(/id=([A-Z0-9\-]+)/);
                    if (m) ids.push(m[1]);
                }
                if (s.textContent?.includes('gtag(')) {
                    const m = s.textContent.match(/gtag\(['"]config['"],\s*['"]([A-Z0-9\-]+)['"]\)/);
                    if (m) ids.push(m[1]);
                }
            });
            return ids;
        });

        const facebookPixel = await page.$$eval('script', scripts => {
            const ids = [];
            scripts.forEach(s => {
                if (s.textContent?.includes('fbq(')) {
                    const m = s.textContent.match(/fbq\(['"]init['"],\s*['"]([0-9]+)['"]\)/);
                    if (m) ids.push(m[1]);
                }
            });
            return ids;
        });

        const urlObj = new URL(request.url);
        const pageContext = {
            pageType: request.url.includes('/itm/') ? 'listing' : 'searchResults',
            searchQuery: urlObj.searchParams.get('_nkw'),
            position: 0, listingType: null, campaignId: null
        };

        const jsBundles = await page.$$eval('script[src]', scripts => scripts.map(s => s.src));
        const cssBundles = await page.$$eval('link[rel="stylesheet"]', links => links.map(l => l.href));

        phase('tracking IDs + bundles extracted');

        const shippingOptions = [];
        if (extractShippingOptions) {
            const shippingButton = await page.$('div.ux-labels-values--shipping button span');
            const isShippingButtonVisible = shippingButton
                ? await shippingButton.isVisible().catch(() => false)
                : false;
            if (shippingButton && isShippingButtonVisible) {
                await shippingButton.scrollIntoViewIfNeeded().catch(() => {});
                await shippingButton.evaluate(el => el.click());
                // Wait up to 10s for the country dropdown; skip the whole block if it never renders.
                const countrySelect = await page.waitForSelector('#shCountry', { timeout: 10000 }).catch(() => null);
                if (countrySelect) {
                    // Pick US explicitly. Previously the loop took the first option with a value,
                    // which was alphabetically "American Samoa" (value="7") — incorrect for shipping cost.
                    let selectedLabel = null;
                    try {
                        await countrySelect.selectOption({ label: 'United States' });
                        selectedLabel = 'United States';
                    } catch (_) {
                        // Fallback: search options for one matching US
                        const options = await countrySelect.$$('option');
                        for (const option of options) {
                            const label = (await option.textContent())?.trim() || '';
                            if (/^(united states|usa|us)$/i.test(label)) {
                                const value = await option.getAttribute('value');
                                if (value) {
                                    await countrySelect.selectOption(value);
                                    selectedLabel = label;
                                    break;
                                }
                            }
                        }
                    }
                    log.info(`ITEM: shipping country selected`, { label: selectedLabel });
                    await page.click('button:has-text("Update")').catch(() => {});
                    await page.locator('div.ux-labels-values--deliveryto span.ux-textspans--BOLD').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
                    const selector = await parseWithCheerio();
                    const boldSpans = selector('div.ux-labels-values--deliveryto span[class="ux-textspans ux-textspans--BOLD"]');
                    const shippingPrice = selector('div.ux-labels-values--deliveryto > div.ux-labels-values__values > div > div:nth-child(3)').text().trim();
                    let shipPrice = 0, shipCurrency = "USD";
                    const parsed = parseCurrency(shippingPrice);
                    if (parsed) { shipPrice = parsed.cost; shipCurrency = parsed.currency; }
                    if (boldSpans.length > 0) {
                        shippingOptions.push({
                            name: selector(boldSpans[0]).text().trim(),
                            cost: shipPrice,
                            currency: shipCurrency,
                            estimatedDeliveryMinDays: getEstimatedDaysLeft(selector(boldSpans[1]).text().trim()),
                            estimatedDeliveryMaxDays: getEstimatedDaysLeft(selector(boldSpans[2]).text().trim())
                        });
                    }
                } else {
                    log.warning('ITEM: shipping country dropdown did not render, skipping shipping options');
                }
            }
        }

        phase('shipping block done');

        // Wait for the delivery-to block to materialize if it exists. Skip the wait
        // entirely when the element isn't on the page to save ~10s.
        await page.waitForSelector('div.ux-labels-values--deliveryto .ux-labels-values__values-content', { timeout: 3000 })
            .catch(() => {});
        page.off('request', requestTracker);

        const $after = await parseWithCheerio();
        // Pick the inner div matching "Estimated between <date> and <date>" inside the deliveryto block.
        let deliveryTimeText = null;
        $after('div.ux-labels-values--deliveryto div').each((_, el) => {
            const text = $after(el).clone().find('.ux-textspans__custom-view').remove().end().text().trim().replace(/\s+/g, ' ');
            if (/^Estimated between\s/i.test(text)) {
                deliveryTimeText = text;
                return false;
            }
        });

        const scrappedItem = {
            platform: "ebay",
            url: page.url(),
            capturedAt: new Date().toISOString(),
            captureMode: mode,
            product: {
                id: {
                    platformItemId,
                    otherIds: { mpn, modelNumber, ean, upc, gtin }
                },
                title, brand,
                category: { breadcrumb, leafCategoryName, leafCategoryId, categoryPathIds },
                pricing: { currency, price: priceMin, priceMin, priceMax },
                stock: { availableQuantity, soldCount },
                condition: { conditionText, returnPolicySummary, guaranteeLabels: [], authenticityClaims: [] },
                origin: { itemLocationText, itemCountryCode, shipsFromLocations: [], warehouseCountryCodes: [] },
                shipping: { options: shippingOptions, deliveryTimeText },
                paymentMethods,
                description: { html: null, plainText: null },
                specifications,
                media: { images, videos: [] },
                reviewsSummary: {
                    rating, reviewCount, ratingBreakdown,
                    negativeReviewSamples: [], positiveReviewSamples: [],
                    authenticityKeywords: [],
                    buyerMediaCounts: { images: 0, videos: 0 }
                }
            },
            sellerRef: mode === 'product_only' ? null : { platformSellerId, displayName, ebayUsername },
            seller: mode === 'product_only' ? null : emptySellerSection(),
            technical: {
                scriptBlocks, jsonState, dataAttributes,
                rawUrlParameters: Object.fromEntries(urlObj.searchParams.entries()),
                experimentIds: [], trackingIds: { googleAnalytics, facebookPixel },
                pageContext, fulfilmentCodes: [], jsBundles, cssBundles, apiEndpoints
            },
            sellerTechnical: null
        };

        // Seed the seller section with what we already know from the product page
        if (scrappedItem.seller) {
            if (profileUrl) {
                try {
                    scrappedItem.seller.profileUrl = new URL(profileUrl, 'https://www.ebay.com').toString();
                } catch (_) {
                    scrappedItem.seller.profileUrl = profileUrl;
                }
            }
            scrappedItem.seller.displayName = displayName;
            scrappedItem.seller.ebayUsername = ebayUsername;
        }

        const feedbackUrls = await page.evaluate(() => {
            const options = document.querySelectorAll('select[name="feedbackFilterDropdown"] option');
            const urls = { negative: null, positive: null };
            options.forEach(opt => {
                const val = opt.value || '';
                if (val.includes('commentType=NEGATIVE')) urls.negative = val;
                else if (val.includes('commentType=POSITIVE')) urls.positive = val;
            });
            return urls;
        });

        // Await the description fetch we kicked off at the top of the handler.
        // By now, ~5-10s of Playwright work has happened in parallel, so the
        // 1-3.5s HTTP fetch usually has already resolved (step≈0s).
        const descRes = await descriptionPromise;
        if (descRes && descRes.statusCode === 200 && descRes.body) {
            const $desc = cheerio.load(descRes.body);
            $desc('script, style').remove();
            scrappedItem.product.description.html = $desc.html();
            scrappedItem.product.description.plainText = $desc('body').text().replace(/\s+/g, ' ').trim();
        } else if (descRes) {
            log.warning(`DESCRIPTION fetch ${descRes.statusCode}`, { itemId: platformItemId });
        }
        phase('description awaited (parallel got)');

        log.info(`ITEM feedbackUrls: negative=${feedbackUrls?.negative} | positive=${feedbackUrls?.positive}`);

        // Enqueue ITEM_REVIEWS directly (DESCRIPTION queue round-trip removed)
        if (feedbackUrls?.negative || feedbackUrls?.positive) {
            // Primary URL drives Crawlee navigation; the other is opened on a second
            // page inside ITEM_REVIEWS so both scrape concurrently in one handler.
            const primary = feedbackUrls.negative || feedbackUrls.positive;
            await crawler.addRequests([{
                url: primary,
                label: "ITEM_REVIEWS",
                userData: {
                    scrappedItem,
                    negativeUrl: feedbackUrls.negative || null,
                    positiveUrl: feedbackUrls.positive || null,
                }
            }]);
        } else {
            log.warning('No product feedback URL found, skipping product reviews, going to seller');
            await chainToSeller(scrappedItem, log);
        }
        phase('ITEM handler done (enqueued next)');
    });

    // ──────────────────── ITEM_REVIEWS ────────────────────
    // Scrape negative + positive review samples in parallel on two pages
    // sharing the same browser context (cookies, proxy, session).
    crawler.router.addHandler("ITEM_REVIEWS", async ({ page, request, log }) => {
        const phase = makePhaseLogger(log, 'ITEM_REVIEWS');
        phase('handler start');

        const scrappedItem = request.userData.scrappedItem;
        const { negativeUrl, positiveUrl } = request.userData;

        const scrapeSamples = async (p, label) => {
            try {
                await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await p.waitForFunction(() => {
                    if (document.querySelector('.fdbk-result-status')) return true;
                    const cards = document.querySelectorAll('li.fdbk-container[data-testid="feedback-cards"]');
                    if (cards.length === 0) return false;
                    return cards[0].querySelector('.fdbk-container__details__comment span')?.textContent?.trim()?.length > 0;
                }, { timeout: 20000 }).catch(() => {
                    log.warning(`${label}: Expected content not found`, { url: p.url() });
                });
                return await p.evaluate(() => {
                    const cards = document.querySelectorAll('li.fdbk-container[data-testid="feedback-cards"]');
                    const results = [];
                    cards.forEach((card, i) => {
                        if (i >= 5) return;
                        const comment = card.querySelector('.fdbk-container__details__comment span')?.textContent?.trim() || null;
                        if (!comment) return;
                        const userRaw = card.querySelector('.fdbk-container__details__info__username span:not(.fb-clipped)')?.textContent?.trim() || null;
                        let user = null, userFeedbackScore = null;
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
                log.error(`${label} failed`, { url: p.url(), error: err.message });
                return [];
            }
        };

        // `page` is already navigated by Crawlee to request.url (primary URL).
        const primaryIsNegative = request.url === negativeUrl;
        const secondaryUrl = primaryIsNegative ? positiveUrl : negativeUrl;
        const primaryLabel = primaryIsNegative ? 'ITEM_NEGATIVE_REVIEWS' : 'ITEM_POSITIVE_REVIEWS';
        const secondaryLabel = primaryIsNegative ? 'ITEM_POSITIVE_REVIEWS' : 'ITEM_NEGATIVE_REVIEWS';

        let secondaryPage = null;
        try {
            const tasks = [scrapeSamples(page, primaryLabel)];
            if (secondaryUrl) {
                secondaryPage = await page.context().newPage();
                tasks.push(
                    secondaryPage.goto(secondaryUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
                        .then(() => scrapeSamples(secondaryPage, secondaryLabel))
                        .catch((err) => {
                            log.error(`${secondaryLabel} navigation failed`, { url: secondaryUrl, error: err.message });
                            return [];
                        })
                );
            }
            const [primarySamples, secondarySamples = []] = await Promise.all(tasks);
            phase('parallel review pages scraped');

            const negativeSamples = primaryIsNegative ? primarySamples : secondarySamples;
            const positiveSamples = primaryIsNegative ? secondarySamples : primarySamples;

            scrappedItem.product.reviewsSummary.negativeReviewSamples = negativeSamples;
            scrappedItem.product.reviewsSummary.positiveReviewSamples = positiveSamples;
            log.info(`ITEM_REVIEWS: negative=${negativeSamples.length}, positive=${positiveSamples.length}`);

            await chainToSeller(scrappedItem, log);
            phase('ITEM_REVIEWS handler done (chained to seller)');
        } finally {
            if (secondaryPage) await secondaryPage.close().catch(() => {});
        }
    });

    // Helper: after product flow done, chain into seller flow.
    // If mode is product_only, push data and stop here.
    // If the product page's seller link goes to an intermediate /sch/i.html hub,
    // route through SELLER_HUB first to resolve the real seller URL from the DOM.
    // Otherwise, go straight to SELLER_STORE.
    async function chainToSeller(scrappedItem, log) {
        if (mode === 'product_only') {
            await Dataset.pushData(scrappedItem);
            return;
        }
        const sellerUrl = scrappedItem.seller?.profileUrl;
        if (!sellerUrl) {
            log.warning('No seller profileUrl found on product page, pushing product-only data');
            await Dataset.pushData(scrappedItem);
            return;
        }
        let isHub = false;
        try {
            const parsed = new URL(sellerUrl, 'https://www.ebay.com');
            // Hub patterns: /sch/i.html?_ssn=X  OR  /sch/{slug}/m.html
            isHub = /\/sch\/i\.html/i.test(parsed.pathname)
                || /\/sch\/[^/]+\/m\.html/i.test(parsed.pathname);
        } catch (_) {}

        if (isHub) {
            log.info(`chainToSeller: product links to search hub, routing via SELLER_HUB → ${sellerUrl}`);
            await crawler.addRequests([{
                url: sellerUrl,
                label: "SELLER_HUB",
                userData: { scrappedItem }
            }]);
        } else {
            const baseUrl = sellerUrl.replace(/\/+$/, '');
            scrappedItem.seller.profileUrl = baseUrl;
            await crawler.addRequests([{
                url: baseUrl,
                label: "SELLER_STORE",
                userData: { scrappedItem, sellerBaseUrl: baseUrl }
            }]);
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

        const scrappedItem = request.userData.scrappedItem;
        try {
            await page.waitForSelector('.str-seller-card, a[href*="/str/"], a[href*="/usr/"]', { timeout: 20000 }).catch(() => {
                log.warning(`SELLER_HUB: no seller-card or store/user link found`, { url: request.url });
            });
            phase('seller card/link wait done');

            const resolvedSellerUrl = await page.evaluate(() => {
                const pick = (sel) => document.querySelector(sel)?.href || null;
                const fromCard = pick('.str-seller-card__store-name h1 a')
                    || pick('a.str-profile-link')
                    || pick('.str-seller-card__store-logo a');
                if (fromCard) return fromCard;
                // Fallback: first anchor on the page that points to a seller store/profile
                const anchor = document.querySelector('a[href*="/str/"], a[href*="/usr/"]');
                return anchor?.href || null;
            });

            let sellerUrl = resolvedSellerUrl;

            // Fallback #2: construct from the slug in the URL path (/sch/{slug}/m.html)
            if (!sellerUrl || /\/sch\/i\.html/i.test(sellerUrl) || /\/sch\/[^/]+\/m\.html/i.test(sellerUrl)) {
                try {
                    const parsed = new URL(request.url, 'https://www.ebay.com');
                    const pathMatch = parsed.pathname.match(/\/sch\/([^/]+)\/m\.html/i);
                    const slug = (pathMatch && pathMatch[1] !== 'i.html') ? pathMatch[1] : null;
                    const ssn = parsed.searchParams.get('_ssn') || parsed.searchParams.get('store_name');
                    const finalSlug = slug || ssn;
                    if (finalSlug) {
                        sellerUrl = `https://www.ebay.com/usr/${finalSlug}`;
                        log.info(`SELLER_HUB: DOM resolution failed, falling back to slug → ${sellerUrl}`);
                    }
                } catch (_) {}
            }

            if (!sellerUrl) {
                log.warning(`SELLER_HUB: could not resolve real seller URL, pushing product-only data`, { url: request.url });
                await Dataset.pushData(scrappedItem);
                return;
            }

            const cleaned = sellerUrl.split('?')[0].replace(/\/+$/, '');
            log.info(`SELLER_HUB: resolved → ${cleaned}`);
            scrappedItem.seller.profileUrl = cleaned;
            const slugMatch = cleaned.match(/\/(?:str|usr)\/([^/?]+)/i);
            if (slugMatch && !scrappedItem.seller.ebayUsername) {
                scrappedItem.seller.ebayUsername = slugMatch[1];
            }

            await crawler.addRequests([{
                url: cleaned,
                label: "SELLER_STORE",
                userData: { scrappedItem, sellerBaseUrl: cleaned }
            }]);
            phase('SELLER_HUB handler done (enqueued SELLER_STORE)');
        } catch (err) {
            log.error(`SELLER_HUB failed`, { url: request.url, error: err.message });
            throw err;
        }
    });

    // ──────────────────── SELLER_STORE ────────────────────
    crawler.router.addHandler("SELLER_STORE", async ({ page, request, log }) => {
        const phase = makePhaseLogger(log, 'SELLER_STORE');
        phase('handler start');

        const scrappedItem = request.userData.scrappedItem;
        const sellerBaseUrl = request.userData.sellerBaseUrl;
        try {
            await page.waitForSelector('article.str-item-card', { timeout: 15000 }).catch(() => {
                log.warning(`SELLER_STORE: No store items found on Shop tab`, { url: request.url });
            });
            phase('store items DOM ready');

            const rawItems = await page.evaluate(() => {
                const items = [];
                document.querySelectorAll('article.str-item-card').forEach((el) => {
                    if (items.length >= 10) return;
                    const name = el.querySelector('.str-item-card__property-title .str-text-span')?.textContent?.trim() || null;
                    const imageUrl = el.querySelector('img[data-testid="str-img"]')?.src || null;
                    const priceText = el.querySelector('.str-item-card__property-displayPrice')?.textContent?.trim() || null;
                    const itemUrl = el.querySelector('a.str-item-card__link')?.href || null;
                    if (name) items.push({ name, imageUrl, priceText, url: itemUrl });
                });
                return items;
            });
            scrappedItem.seller.storeItems = rawItems.map(item => {
                let priceMin = null, priceMax = null, currency = null;
                if (item.priceText) {
                    const parts = item.priceText.split(/\s+to\s+/i);
                    const fromParsed = parseCurrency(parts[0]?.trim());
                    if (fromParsed) { priceMin = fromParsed.cost; currency = fromParsed.currency; }
                    if (parts.length > 1) {
                        const toParsed = parseCurrency(parts[1]?.trim());
                        if (toParsed) priceMax = toParsed.cost;
                    }
                    if (!currency) currency = item.priceText.match(/[A-Z]{3}/)?.[0] || null;
                }
                return { name: item.name, imageUrl: item.imageUrl, currency, priceMin, priceMax, url: item.url };
            });
            log.info(`Scraped ${scrappedItem.seller.storeItems.length} store items`);
            phase('store items extracted');

            const feedbackClicked = await page.evaluate(() => {
                const tabs = document.querySelectorAll('[role="tab"]');
                for (const tab of tabs) {
                    if (tab.textContent?.trim().toLowerCase() === 'feedback') { tab.click(); return true; }
                }
                return false;
            });
            if (feedbackClicked) {
                await page.waitForSelector('.rating-element', { timeout: 30000 }).catch((err) => {
                    log.warning(`SELLER_STORE: Feedback content not found after clicking tab`, { url: request.url, error: err.message });
                });
            } else {
                log.warning(`SELLER_STORE: Feedback tab not found`, { url: request.url });
            }
            phase('feedback tab loaded');

            const { summary, detailedRatings, totalSellerFeedbackCount, displayName, ebayUsername, storeId, feedbackScore, positivePercent, itemsSold, followers, feedbackLinks, logoUrl } = await page.evaluate(() => {
                const summary = { positive: null, neutral: null, negative: null };
                document.querySelectorAll('.rating-element').forEach(el => {
                    const label = el.querySelector(':scope > span')?.textContent?.trim().toLowerCase();
                    const numText = el.querySelector('.INLINE_LINK')?.textContent?.trim().replace(/,/g, '');
                    const num = numText ? parseInt(numText, 10) : null;
                    if (label === 'positive') summary.positive = num;
                    else if (label === 'neutral') summary.neutral = num;
                    else if (label === 'negative') summary.negative = num;
                });

                const detailedRatings = {
                    accurateDescription: null, shippingSpeed: null,
                    communication: null, shippingCost: null
                };
                document.querySelectorAll('.fdbk-detail-seller-rating').forEach(el => {
                    const label = el.querySelector('.fdbk-detail-seller-rating__label span')?.textContent?.trim().toLowerCase();
                    const value = parseFloat(el.querySelector('.fdbk-detail-seller-rating__value')?.textContent?.trim());
                    if (!isNaN(value)) {
                        if (label?.includes('accurate')) detailedRatings.accurateDescription = value;
                        else if (label?.includes('shipping cost')) detailedRatings.shippingCost = value;
                        else if (label?.includes('shipping speed')) detailedRatings.shippingSpeed = value;
                        else if (label?.includes('communication')) detailedRatings.communication = value;
                    }
                });

                const feedbackCountText = document.querySelector('.fdbk-detail-list__title .SECONDARY')?.textContent || '';
                const totalSellerFeedbackCount = parseInt(feedbackCountText.replace(/[()\s,]/g, ''), 10) || null;

                let ebayUsername = null;
                const scripts = document.querySelectorAll('script');
                for (const s of scripts) {
                    const txt = s.textContent || '';
                    const entityMatch = txt.match(/"entity_id"\s*:\s*"~([^"]+)"/);
                    if (entityMatch) { ebayUsername = entityMatch[1]; break; }
                }
                if (!ebayUsername) {
                    const fdbkLink = document.querySelector('a[href*="fdbk/feedback_profile/"]');
                    if (fdbkLink) {
                        const hrefMatch = fdbkLink.href.match(/\/fdbk\/feedback_profile\/([^/?]+)/);
                        if (hrefMatch) ebayUsername = decodeURIComponent(hrefMatch[1]);
                    }
                }
                if (!ebayUsername) {
                    ebayUsername = document.querySelector('.fdbk-detail-list__title .PSEUDOLINK')?.textContent?.trim() || null;
                }

                const displayName = document.querySelector('.str-seller-card__store-name h1 a')?.textContent?.trim()
                    || document.querySelector('.str-seller-card__store-name h1')?.textContent?.trim()
                    || document.querySelector('.x-sellercard-atf__info__about-seller a .ux-textspans--BOLD')?.textContent?.trim()
                    || document.querySelector('img.str-header__logo--img')?.alt?.trim()
                    || (() => {
                        const t = document.title || '';
                        const m = t.match(/^(.+?)\s*[|–—]/);
                        return m ? m[1].trim() : null;
                    })()
                    || null;

                let storeId = null;
                const trackEl = document.querySelector('[data-track*="soid"]');
                if (trackEl) {
                    try {
                        const trackData = JSON.parse(trackEl.getAttribute('data-track'));
                        storeId = trackData?.eventProperty?.['ads-soid'] || trackData?.eventProperty?.soid || null;
                    } catch (e) {}
                }

                function parseAbbreviated(text) {
                    if (!text) return null;
                    const m = text.match(/([\d,.]+)\s*([KMB]?)/i);
                    if (!m) return null;
                    let num = parseFloat(m[1].replace(/,/g, ''));
                    const suffix = m[2].toUpperCase();
                    if (suffix === 'K') num *= 1000;
                    else if (suffix === 'M') num *= 1000000;
                    else if (suffix === 'B') num *= 1000000000;
                    return Math.round(num);
                }

                let itemsSold = null;
                let followers = null;
                document.querySelectorAll('.str-seller-card__store-stats-content > div').forEach(div => {
                    const text = div.textContent?.trim().toLowerCase() || '';
                    const boldText = div.querySelector('.BOLD')?.textContent?.trim() || '';
                    if (text.includes('items sold')) itemsSold = parseAbbreviated(boldText);
                    else if (text.includes('follower')) followers = parseAbbreviated(boldText);
                });

                const scoreText = document.querySelector('.fdbk-detail-list__title .SECONDARY')?.textContent || '';
                const scoreMatch = scoreText.match(/([\d,]+)/);
                const feedbackScore = scoreMatch ? parseInt(scoreMatch[1].replace(/,/g, ''), 10) : null;

                let positivePercent = null;
                const percentEl = document.querySelector('.fdbk-overall-rating__bar-text');
                if (percentEl) {
                    positivePercent = parseFloat(percentEl.textContent?.trim().replace('%', '')) || null;
                }
                if (!positivePercent) {
                    const altPercent = document.querySelector('.fdbk-overall-rating .SECONDARY')?.textContent?.trim()
                        || document.querySelector('[class*="positive-feedback"]')?.textContent?.trim()
                        || '';
                    const pctMatch = altPercent.match(/([\d.]+)\s*%/);
                    if (pctMatch) positivePercent = parseFloat(pctMatch[1]);
                }
                if (!positivePercent && summary.positive != null) {
                    const total = (summary.positive || 0) + (summary.neutral || 0) + (summary.negative || 0);
                    if (total > 0) positivePercent = Math.round((summary.positive / total) * 10000) / 100;
                }

                const feedbackLinks = { negative: null, positive: null };
                document.querySelectorAll('.rating-element').forEach(el => {
                    const label = el.querySelector(':scope > span')?.textContent?.trim().toLowerCase();
                    const href = el.querySelector('a')?.href;
                    if (label === 'negative' && href) feedbackLinks.negative = href;
                    else if (label === 'positive' && href) feedbackLinks.positive = href;
                });

                const logoUrl = document.querySelector('img.str-header__logo--img')?.src || null;

                return { summary, detailedRatings, totalSellerFeedbackCount, displayName, ebayUsername, storeId, feedbackScore, positivePercent, itemsSold, followers, feedbackLinks, logoUrl };
            });

            let resolvedUsername = ebayUsername || scrappedItem.seller.ebayUsername;
            if (!resolvedUsername) {
                const slugMatch = sellerBaseUrl.match(/\/(?:str|usr)\/([^/?]+)/i);
                if (slugMatch) resolvedUsername = slugMatch[1];
            }

            scrappedItem.seller.displayName = displayName || scrappedItem.seller.displayName || resolvedUsername;
            scrappedItem.seller.ebayUsername = resolvedUsername;
            scrappedItem.seller.storeId = storeId;
            scrappedItem.seller.logoUrl = logoUrl;
            scrappedItem.seller.feedbackScore = feedbackScore;
            scrappedItem.seller.positivePercent = positivePercent;
            scrappedItem.seller.itemsSold = itemsSold;
            scrappedItem.seller.followers = followers;
            scrappedItem.seller.feedback.summary = summary;
            scrappedItem.seller.feedback.detailedRatings = detailedRatings;
            scrappedItem.seller.totalSellerFeedbackCount = totalSellerFeedbackCount;

            const sellerTechnical = await page.evaluate(() => {
                // const scriptBlocks = [...document.querySelectorAll('script')].map(s => s.textContent).filter(Boolean);
                const scriptBlocks = [];
                const jsonState = {};
                // scriptBlocks.forEach(script => {
                //     const match = script.match(/window\.__INITIAL_STATE__\s*=\s*(\{.*\});/);
                //     if (match) { try { jsonState.rootKeys = Object.keys(JSON.parse(match[1])); } catch (e) {} }
                // });

                const dataAttributes = {};
                // document.querySelectorAll('*').forEach(el => {
                //     for (const attr of el.attributes) {
                //         if (attr.name.startsWith('data-')) dataAttributes[attr.name] = attr.value;
                //     }
                // });

                const googleAnalytics = [];
                const facebookPixel = [];
                document.querySelectorAll('script').forEach(s => {
                    if (s.src?.includes('googletagmanager')) {
                        const m = s.src.match(/id=([A-Z0-9\-]+)/);
                        if (m) googleAnalytics.push(m[1]);
                    }
                    if (s.textContent?.includes('gtag(')) {
                        const m = s.textContent.match(/gtag\(['"]config['"],\s*['"]([A-Z0-9\-]+)['"]\)/);
                        if (m) googleAnalytics.push(m[1]);
                    }
                    if (s.textContent?.includes('fbq(')) {
                        const m = s.textContent.match(/fbq\(['"]init['"],\s*['"](\d+)['"]\)/);
                        if (m) facebookPixel.push(m[1]);
                    }
                });

                const jsBundles = [...document.querySelectorAll('script[src]')].map(s => s.src);
                const cssBundles = [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => l.href);

                return { scriptBlocks: scriptBlocks.length, jsonState, dataAttributes, trackingIds: { googleAnalytics, facebookPixel }, jsBundles, cssBundles };
            });
            scrappedItem.sellerTechnical = sellerTechnical;
            phase('seller data + technical extracted');

            const aboutClicked = await page.evaluate(() => {
                const tabs = document.querySelectorAll('[role="tab"]');
                for (const tab of tabs) {
                    if (tab.textContent?.trim().toLowerCase() === 'about') { tab.click(); return true; }
                }
                return false;
            });
            if (aboutClicked) {
                await page.waitForSelector('.str-about-description__seller-info .BOLD', { timeout: 15000 }).catch(() => {});
            }
            const aboutData = await page.evaluate(() => {
                const aboutDescription = document.querySelector('.str-about-description__description .str-text-span')?.textContent?.trim() || null;
                const sellerInfoMap = {};
                document.querySelectorAll('.str-about-description__seller-info > span').forEach(el => {
                    const key = el.querySelector('.SECONDARY')?.textContent?.replace(/[: ]/g, '').trim().toLowerCase();
                    const value = el.querySelector('.BOLD')?.textContent?.trim();
                    if (key && value) sellerInfoMap[key] = value;
                });
                const businessDetails = {};
                document.querySelectorAll('.str-business-details__seller-info > span').forEach(el => {
                    const key = el.querySelector('.SECONDARY')?.textContent?.replace(/[: ]/g, '').trim().toLowerCase();
                    const value = el.querySelector('.BOLD')?.textContent?.trim();
                    if (key && value) businessDetails[key.replace(/\s+/g, '_')] = value;
                });
                return { aboutDescription, sellerInfoMap, businessDetails };
            });
            scrappedItem.seller.about = {
                description: aboutData.aboutDescription,
                location: aboutData.sellerInfoMap['location'] || null,
                memberSince: aboutData.sellerInfoMap['member since'] || null,
                businessDetails: Object.keys(aboutData.businessDetails).length ? aboutData.businessDetails : null
            };
            phase('about tab extracted');

            if (feedbackLinks.negative || feedbackLinks.positive) {
                const primary = feedbackLinks.negative || feedbackLinks.positive;
                await crawler.addRequests([{
                    url: primary,
                    label: "SELLER_REVIEWS",
                    userData: {
                        scrappedItem,
                        negativeUrl: feedbackLinks.negative || null,
                        positiveUrl: feedbackLinks.positive || null,
                    }
                }]);
            } else {
                log.warning('No seller feedback link found, pushing data');
                await Dataset.pushData(scrappedItem);
            }
            phase('SELLER_STORE handler done');
        } catch (err) {
            log.error(`SELLER_STORE failed`, { url: request.url, error: err.message });
            throw err;
        }
    });

    // ──────────────────── SELLER_REVIEWS ────────────────────
    // Scrape seller negative + positive review samples in parallel on two pages
    // sharing the same browser context.
    crawler.router.addHandler("SELLER_REVIEWS", async ({ page, request, log }) => {
        const phase = makePhaseLogger(log, 'SELLER_REVIEWS');
        phase('handler start');

        const scrappedItem = request.userData.scrappedItem;
        const { negativeUrl, positiveUrl } = request.userData;

        const scrapeSamples = async (p, label) => {
            try {
                await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await p.waitForFunction(() => {
                    if (document.querySelector('.fdbk-result-status')) return true;
                    const rows = document.querySelectorAll('tr[data-feedback-id]');
                    if (rows.length > 0) {
                        return rows[0].querySelector('.card__comment span')?.textContent?.trim()?.length > 0;
                    }
                    const cards = document.querySelectorAll('li.fdbk-container[data-testid="feedback-cards"]');
                    if (cards.length > 0) {
                        return cards[0].querySelector('.fdbk-container__details__comment span')?.textContent?.trim()?.length > 0;
                    }
                    return false;
                }, { timeout: 40000 }).catch(() => {
                    log.warning(`${label}: Expected content not found`, { url: p.url() });
                });
                return await p.evaluate(() => {
                    const results = [];
                    const parseUser = (raw) => {
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
                        document.querySelectorAll('li.fdbk-container[data-testid="feedback-cards"]').forEach((card) => {
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
                log.error(`${label} failed`, { url: p.url(), error: err.message });
                return [];
            }
        };

        const primaryIsNegative = request.url === negativeUrl;
        const secondaryUrl = primaryIsNegative ? positiveUrl : negativeUrl;
        const primaryLabel = primaryIsNegative ? 'SELLER_NEGATIVE_REVIEWS' : 'SELLER_POSITIVE_REVIEWS';
        const secondaryLabel = primaryIsNegative ? 'SELLER_POSITIVE_REVIEWS' : 'SELLER_NEGATIVE_REVIEWS';

        let secondaryPage = null;
        try {
            const tasks = [scrapeSamples(page, primaryLabel)];
            if (secondaryUrl) {
                secondaryPage = await page.context().newPage();
                tasks.push(
                    secondaryPage.goto(secondaryUrl, { waitUntil: 'domcontentloaded', timeout: 40000 })
                        .then(() => scrapeSamples(secondaryPage, secondaryLabel))
                        .catch((err) => {
                            log.error(`${secondaryLabel} navigation failed`, { url: secondaryUrl, error: err.message });
                            return [];
                        })
                );
            }
            const [primarySamples, secondarySamples = []] = await Promise.all(tasks);
            phase('parallel review pages scraped');

            const negativeSamples = primaryIsNegative ? primarySamples : secondarySamples;
            const positiveSamples = primaryIsNegative ? secondarySamples : primarySamples;

            scrappedItem.seller.feedback.negativeReviewSamples = negativeSamples;
            scrappedItem.seller.feedback.positiveReviewSamples = positiveSamples;
            log.info(`SELLER_REVIEWS: negative=${negativeSamples.length}, positive=${positiveSamples.length}`);

            await Dataset.pushData(scrappedItem);
            phase('SELLER_REVIEWS handler done (data pushed)');
        } finally {
            if (secondaryPage) await secondaryPage.close().catch(() => {});
        }
    });

    await crawler.run(startUrls);
    await Actor.exit();
})();
