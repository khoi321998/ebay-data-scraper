// Quick probe: can we fetch itm.ebaydesc.com without Playwright?
// Tests 3 scenarios: plain got, got-scraping (with browser-like headers), with retry.
import { gotScraping } from 'got-scraping';
import * as cheerio from 'cheerio';

const TEST_URL = 'https://itm.ebaydesc.com/itmdesc/276843460112';

async function test(label, options = {}) {
    const start = Date.now();
    try {
        const res = await gotScraping({
            url: TEST_URL,
            timeout: { request: 20000 },
            throwHttpErrors: false,
            ...options,
        });
        const elapsed = Date.now() - start;
        const $ = cheerio.load(res.body || '');
        $('script, style').remove();
        const text = $('body').text().replace(/\s+/g, ' ').trim();
        console.log(`\n[${label}]`);
        console.log(`  status:      ${res.statusCode}`);
        console.log(`  elapsed:     ${elapsed}ms`);
        console.log(`  body length: ${(res.body || '').length}`);
        console.log(`  text length: ${text.length}`);
        console.log(`  server:      ${res.headers['server'] || '—'}`);
        console.log(`  content-type:${res.headers['content-type'] || '—'}`);
        console.log(`  body preview:`);
        console.log(`    ${(res.body || '').slice(0, 300).replace(/\s+/g, ' ')}`);
        console.log(`  text preview:`);
        console.log(`    ${text.slice(0, 200)}`);
    } catch (err) {
        const elapsed = Date.now() - start;
        console.log(`\n[${label}] FAILED after ${elapsed}ms`);
        console.log(`  error: ${err.message}`);
    }
}

console.log(`Testing: ${TEST_URL}`);
console.log(`(This is the URL that timed out at 60s in the Playwright crawler)\n`);

await test('1. Plain gotScraping (default browser-like headers)');
await test('2. With explicit ebay item referer', {
    headerGeneratorOptions: { browsers: [{ name: 'chrome' }] },
    headers: { referer: 'https://www.ebay.com/itm/276843460112' },
});
await test('3. Minimal headers, http2 disabled', {
    http2: false,
    headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'accept': 'text/html,*/*',
    },
});
