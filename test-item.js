// Probe: can we fetch the ITEM page (www.ebay.com/itm/...) without Playwright?
// Target field: title via $('h1.x-item-title__mainTitle') — same selector as main.js:248
import { gotScraping } from 'got-scraping';
import * as cheerio from 'cheerio';

const ITEM_ID = '276843460112'; // same item from the log
const ITEM_URL = `https://www.ebay.com/itm/${ITEM_ID}?rt=nc&_ipg=1&location=US`;

async function test(label, options = {}) {
    const start = Date.now();
    try {
        const res = await gotScraping({
            url: ITEM_URL,
            timeout: { request: 25000 },
            throwHttpErrors: false,
            ...options,
        });
        const elapsed = Date.now() - start;
        const $ = cheerio.load(res.body || '');

        const title = $('h1.x-item-title__mainTitle').text().trim() || null;
        const titleAlt = $('h1[class="x-item-title__mainTitle"]').text().trim() || null;
        const priceTexts = [];
        $('div.x-price-primary span.ux-textspans').each((_, el) => {
            priceTexts.push($(el).text().trim());
        });
        const sellerName = $('.x-sellercard-atf__info__about-seller a .ux-textspans--BOLD').text().trim() || null;

        const bodyLen = (res.body || '').length;
        const isAkamaiBlock = (res.body || '').toLowerCase().includes('reference #') ||
            (res.body || '').toLowerCase().includes('access denied') ||
            (res.body || '').toLowerCase().includes('pardon our interruption');

        console.log(`\n[${label}]`);
        console.log(`  status:      ${res.statusCode}`);
        console.log(`  elapsed:     ${elapsed}ms`);
        console.log(`  body length: ${bodyLen}`);
        console.log(`  server:      ${res.headers['server'] || '—'}`);
        console.log(`  cf-ray:      ${res.headers['cf-ray'] || '—'}`);
        console.log(`  blocked?:    ${isAkamaiBlock ? '⚠️  YES (Akamai/block page)' : '✅ no block markers'}`);
        console.log(`  title:       ${title ? `✅ "${title.slice(0, 80)}..."` : '❌ NOT FOUND'}`);
        console.log(`  title (alt): ${titleAlt ? '✅ found' : '❌ NOT FOUND'}`);
        console.log(`  price texts: ${priceTexts.length ? `✅ ${JSON.stringify(priceTexts.slice(0, 3))}` : '❌ empty'}`);
        console.log(`  seller name: ${sellerName ? `✅ "${sellerName}"` : '❌ NOT FOUND'}`);
        if (!title && bodyLen > 0) {
            console.log(`  body preview (first 400 chars):`);
            console.log(`    ${(res.body || '').slice(0, 400).replace(/\s+/g, ' ')}`);
        }
    } catch (err) {
        const elapsed = Date.now() - start;
        console.log(`\n[${label}] FAILED after ${elapsed}ms`);
        console.log(`  error: ${err.message}`);
    }
}

console.log(`Testing: ${ITEM_URL}\n`);

await test('1. Plain gotScraping (default browser-like fingerprint)');
await test('2. With ebay-flavored Accept-Language headers', {
    headers: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Upgrade-Insecure-Requests': '1',
    },
});
await test('3. Force chrome browser fingerprint', {
    headerGeneratorOptions: {
        browsers: [{ name: 'chrome', minVersion: 120 }],
        operatingSystems: ['windows'],
        devices: ['desktop'],
        locales: ['en-US'],
    },
});