import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';

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
} from '../src/page-parsers.js';

const card = (comment: string, user = 'a***b (1,234)') => `
    <li class="fdbk-container" data-testid="fdbk-feedback-cards">
        <div class="fdbk-container__details__info__username"><span class="fb-clipped">Buyer</span><span>${user}</span></div>
        <div class="fdbk-container__details__info__divide__time"><span>Past month</span></div>
        <div class="fdbk-container__details__comment"><span>${comment}</span></div>
        <svg data-test-type="NEGATIVE"></svg>
        <div class="fdbk-container__details__verified__purchase">Verified purchase</div>
    </li>`;

describe('isCaptchaUrl', () => {
    it('spots the splash captcha eBay serves with HTTP 200', () => {
        expect(isCaptchaUrl('https://www.ebay.es/splashui/captcha?ap=1&ru=x')).toBe(true);
        expect(isCaptchaUrl('https://www.ebay.com/splashui/challenge?ap=1&appName=orch&ru=x')).toBe(true);
        expect(isCaptchaUrl('https://www.ebay.es/str/x?_tab=about')).toBe(false);
    });
});

describe('readItemReviewSamples', () => {
    it('reads only the "This item" panel, capped at five', () => {
        const $ = cheerio.load(`
            <div role="tab" aria-controls="p-item">This item (12)</div>
            <div role="tab" aria-controls="p-all">All items (900)</div>
            <ul id="p-item">${[1, 2, 3, 4, 5, 6].map((i) => card(`item ${i}`)).join('')}</ul>
            <ul id="p-all" hidden="">${card('from another listing')}</ul>`);
        const samples = readItemReviewSamples($);
        expect(samples.map((s) => s.comment)).toEqual(['item 1', 'item 2', 'item 3', 'item 4', 'item 5']);
        expect(samples[0]).toEqual({
            user: 'a***b',
            userFeedbackScore: 1234,
            comment: 'item 1',
            commentDate: 'Past month',
            ratingType: 'negative',
            verifiedPurchase: true,
        });
    });
});

describe('readSellerReviewSamples', () => {
    it('reads the table layout', () => {
        const $ = cheerio.load(`<table>
            <tr data-feedback-id="1">
                <td><svg data-test-type="POSITIVE"></svg></td>
                <td><div class="card__comment"><span>Great seller</span></div>
                    <div class="card__from"><span aria-label="Feedback left by buyer.">k***1</span><span class="no-wrap"><span>1,069</span></span></div></td>
                <td><span aria-label="Past month">Past month</span></td>
                <td><span>Verified purchase</span></td>
            </tr></table>`);
        expect(readSellerReviewSamples($)).toEqual([{
            user: 'k***1',
            userFeedbackScore: 1069,
            comment: 'Great seller',
            commentDate: 'Past month',
            ratingType: 'positive',
            verifiedPurchase: true,
        }]);
    });

    it('falls back to the card layout', () => {
        const $ = cheerio.load(`<ul>${card('card layout')}</ul>`);
        expect(readSellerReviewSamples($).map((s) => s.comment)).toEqual(['card layout']);
    });
});

describe('hasReviewContent', () => {
    it('accepts cards, rows, or the empty-result status, and nothing else', () => {
        expect(hasReviewContent(cheerio.load(`<ul>${card('x')}</ul>`))).toBe(true);
        expect(hasReviewContent(cheerio.load('<div class="fdbk-result-status">No feedback</div>'))).toBe(true);
        // The seller review page answers "none" with its results table and no rows.
        expect(hasReviewContent(cheerio.load('<table id="feedback-cards"><tbody></tbody></table>'))).toBe(true);
        expect(readSellerReviewSamples(cheerio.load('<table id="feedback-cards"><tbody></tbody></table>'))).toEqual([]);
        expect(hasReviewContent(cheerio.load('<div id="gh"></div>'))).toBe(false);
    });
});

describe('readStoreFeedback', () => {
    it('resolves relative hrefs and reads the visible DSR span only', () => {
        const $ = cheerio.load(`
            <div class="rating-element"><span>Positivos</span>
                <a href="/fdbk/feedback_profile/shop?commentType=POSITIVE"><span class="INLINE_LINK">2 329</span></a></div>
            <div class="fdbk-detail-seller-rating">
                <div class="fdbk-detail-seller-rating__label"><span>Accurate description</span></div>
                <div class="fdbk-detail-seller-rating__value"><span>4.9</span><span class="fb-clipped">4.9 out of 5 stars</span></div>
                <progress value="4.9"></progress></div>
            <img class="str-header__logo--img" alt="Shop" src="//i.ebayimg.com/logo.png">`);
        const raw = readStoreFeedback($, 'https://www.ebay.es/str/shop?_tab=feedback');
        expect(raw.ratingElements).toEqual([{
            href: 'https://www.ebay.es/fdbk/feedback_profile/shop?commentType=POSITIVE',
            label: 'Positivos',
            countText: '2 329',
        }]);
        expect(raw.detailedRatingRows[0].valueText).toBe('4.9');
        expect(raw.ebayUsername).toBe('shop');
        expect(raw.displayName).toBe('Shop');
        expect(raw.logoUrl).toBe('https://i.ebayimg.com/logo.png');
    });
});

describe('readStoreAbout', () => {
    it('reads label/value rows', () => {
        const $ = cheerio.load(`
            <div class="str-about-description__description"><span class="str-text-span">Hello</span></div>
            <div class="str-about-description__seller-info"><span><span class="SECONDARY">Location:</span><span class="BOLD">Spain</span></span></div>`);
        expect(readStoreAbout($)).toEqual({
            aboutDescription: 'Hello',
            sellerInfoRows: [{ label: 'Location:', value: 'Spain' }],
            businessDetailRows: [],
        });
    });
});

describe('readItemRatings', () => {
    it('reads the average, the count from the "This item" tab, and the histogram', () => {
        const $ = cheerio.load(`
            <span class="ux-summary__start--rating"><span class="ux-textspans">4.6</span></span>
            <span class="ux-summary__count"><span class="ux-textspans">7 product ratings</span></span>
            <div class="x-feedback-detail-list"><div class="tabs__item">This item (1,092)</div></div>
            <div class="ux-histogram__item--bar"><span class="ux-histogram__item--bar--stars">5</span><span class="ux-histogram__item--bar--c"><span>6</span></span></div>
            <div class="ux-histogram__item--bar"><span class="ux-histogram__item--bar--stars">1</span><span class="ux-histogram__item--bar--c"><span>1</span></span></div>`);
        expect(readItemRatings($)).toEqual({ rating: 4.6, reviewCount: 1092, ratingBreakdown: { 5: 6, 1: 1 } });
    });

    it('falls back to the summary count, and to nulls on a listing without ratings', () => {
        const $ = cheerio.load('<span class="ux-summary__count"><span class="ux-textspans">22 product ratings</span></span>');
        expect(readItemRatings($)).toEqual({ rating: null, reviewCount: 22, ratingBreakdown: {} });
        expect(readItemRatings(cheerio.load('<div></div>'))).toEqual({ rating: null, reviewCount: null, ratingBreakdown: {} });
    });
});

describe('buildAllItemsFeedbackUrls', () => {
    it('builds the links eBay renders client-side for the lazy feedback module', () => {
        const urls = buildAllItemsFeedbackUrls('https://www.ebay.com', '800769303202', 'love1973k');
        expect(urls.negative).toBe('https://www.ebay.com/fdbk/mweb_profile?fdbkType=FeedbackReceivedAsSeller&item_id=800769303202'
            + '&username=love1973k&allItemsTabListingId=800769303202&tab=ALL&commentType=NEGATIVE&sort=RELEVANCEV2');
        expect(urls.positive).toContain('commentType=POSITIVE');
        expect(urls.neutral).toContain('commentType=NEUTRAL');
    });
});

describe('readStoreItems', () => {
    it('prefers the webp source the browser swaps in, and resolves links', () => {
        const $ = cheerio.load(`
            <article class="str-item-card">
                <a class="str-item-card__link" href="/itm/1?itmmeta=x"></a>
                <picture><source srcset="https://i.ebayimg.com/g/a/s-l300.webp" type="image/webp">
                    <img data-testid="str-img" src="https://i.ebayimg.com/g/a/s-l300.jpg"></picture>
                <div class="str-item-card__property-title"><span class="str-text-span">Mug</span></div>
                <div class="str-item-card__property-displayPrice">US $9.99</div>
            </article>
            <article class="str-item-card"><img data-testid="str-img" src="/b.jpg"></article>`);
        expect(readStoreItems($, 'https://www.ebay.com/str/shop')).toEqual([{
            name: 'Mug',
            imageUrl: 'https://i.ebayimg.com/g/a/s-l300.webp',
            priceText: 'US $9.99',
            url: 'https://www.ebay.com/itm/1?itmmeta=x',
        }]);
    });
});

describe('readHubSellerUrl', () => {
    it('prefers the seller card, then any store/profile link', () => {
        expect(readHubSellerUrl(cheerio.load(`
            <a href="/usr/other">x</a>
            <div class="str-seller-card__store-name"><h1><a href="/str/shop">Shop</a></h1></div>`), 'https://www.ebay.es/sch/i.html')).toBe('https://www.ebay.es/str/shop');
        expect(readHubSellerUrl(cheerio.load('<a href="/usr/other">x</a>'), 'https://www.ebay.es/sch/i.html')).toBe('https://www.ebay.es/usr/other');
        expect(readHubSellerUrl(cheerio.load('<div></div>'), 'https://www.ebay.es/sch/i.html')).toBeNull();
    });
});

describe('buildSellerFeedbackUrls', () => {
    it('builds exactly the links a /str/ store feedback tab renders', () => {
        const urls = buildSellerFeedbackUrls('https://www.ebay.com', 'amazing-wireless');
        expect(urls.negative).toBe('https://www.ebay.com/fdbk/feedback_profile/amazing-wireless?filter=feedback_page%3ARECEIVED_AS_SELLER'
            + '%2Cperiod%3ATWELVE_MONTHS%2Coverall_rating%3ANEGATIVE&commentType=NEGATIVE');
        expect(urls.positive).toBe('https://www.ebay.com/fdbk/feedback_profile/amazing-wireless?filter=feedback_page%3ARECEIVED_AS_SELLER'
            + '%2Cperiod%3ATWELVE_MONTHS%2Coverall_rating%3APOSITIVE&commentType=POSITIVE');
        expect(urls.neutral).toContain('overall_rating%3ANEUTRAL&commentType=NEUTRAL');
    });
});

describe('readItemSellerLink', () => {
    const card = '<div class="x-sellercard-atf__info__about-seller"><a href="/str/shop?_trksid=1"><span class="ux-textspans--BOLD">Shop Inc</span></a></div>';
    const storeInfo = '<div class="x-store-information"><h3><a href="https://www.ebay.com/str/shop?_trksid=2"><span class="ux-textspans--BOLD">Shop Inc</span></a></h3></div>';
    const pageData = '{"action":{"name":"VISIT_STORE","params":{"store_name":"shop","usecase":"STORES"},"clientPresentationMetadata":{"_ssn":"Shop Inc","presentationType":"OPEN_WINDOW"}}}';

    it('prefers the seller card', () => {
        expect(readItemSellerLink(cheerio.load(card + storeInfo), pageData)).toEqual({ href: '/str/shop?_trksid=1', name: 'Shop Inc' });
    });
    it('falls back to the store information module when the card is missing', () => {
        expect(readItemSellerLink(cheerio.load(storeInfo), pageData)).toEqual({ href: 'https://www.ebay.com/str/shop?_trksid=2', name: 'Shop Inc' });
    });
    it('falls back to the page data, then gives up', () => {
        expect(readItemSellerLink(cheerio.load('<div></div>'), pageData)).toEqual({ href: '/str/shop', name: 'Shop Inc' });
        expect(readItemSellerLink(cheerio.load('<div></div>'), '{}')).toBeNull();
    });
});
