import { describe, expect, it } from 'vitest';

import { storeBaseUrl } from '../src/ebay-sites.js';

describe('storeBaseUrl', () => {
    it('drops the tab pin that sent us to the wrong tab', () => {
        // The real input that produced `storeItems: []` — item cards only exist on the shop tab.
        expect(storeBaseUrl('https://www.ebay.es/str/bargaininc?_tab=feedback'))
            .toBe('https://www.ebay.es/str/bargaininc');
    });

    it('drops tracking and paging noise, and the trailing slash', () => {
        expect(storeBaseUrl('https://www.ebay.es/str/bargaininc?_trksid=p4429486.m3561.l161211'))
            .toBe('https://www.ebay.es/str/bargaininc');
        expect(storeBaseUrl('https://www.ebay.com/usr/someseller/?_pgn=3#anchor'))
            .toBe('https://www.ebay.com/usr/someseller');
    });

    it('leaves a hub URL alone — the seller lives in its query string', () => {
        const hub = 'https://www.ebay.es/sch/i.html?_ssn=bargainxinc';
        expect(storeBaseUrl(hub)).toBe(hub);
        const slugHub = 'https://www.ebay.es/sch/bargaininc/m.html?_nkw=&_sop=12';
        expect(storeBaseUrl(slugHub)).toBe(slugHub);
    });

    it('passes an unparseable string through instead of throwing', () => {
        expect(storeBaseUrl('not a url/')).toBe('not a url');
    });
});
