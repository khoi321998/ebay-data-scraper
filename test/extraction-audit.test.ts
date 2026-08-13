import { describe, expect, it } from 'vitest';

import { auditExtraction, type FieldCheck, SCRAPED_ITEM_CHECKS } from '../src/extraction-audit.js';

const checks: FieldCheck[] = [
    { path: 'product.title', severity: 'critical' },
    { path: 'product.specifications', severity: 'warning', selector: 'dl[data-testid="ux-labels-values"]' },
    { path: 'product.stock.soldCount', severity: 'warning' },
    { path: 'seller.displayName', severity: 'critical', when: (r) => r?.seller != null },
];

const healthy = {
    product: { title: 'Dell Latitude 3190', specifications: [{ name: 'Brand', value: 'Dell' }], stock: { soldCount: 0 } },
    seller: null,
};

describe('auditExtraction', () => {
    it('reports ok when every applicable field is present', () => {
        const report = auditExtraction(healthy, checks);
        expect(report.status).toBe('ok');
        expect(report.missingFields).toEqual([]);
        // seller.displayName is gated off by `when`, so only 3 checks applied.
        expect(report.checkedFields).toBe(3);
    });

    it('treats 0 as a real value, not an absent field', () => {
        expect(auditExtraction(healthy, checks).missingFields).not.toContain('product.stock.soldCount');
    });

    it('flags an empty array — the shape a broken specifics selector produces', () => {
        const report = auditExtraction({ ...healthy, product: { ...healthy.product, specifications: [] } }, checks);
        expect(report.status).toBe('degraded');
        expect(report.missingFields).toEqual(['product.specifications']);
        // An issue carries only the field and the hook to fix — nothing else.
        expect(report.issues).toEqual([
            { field: 'product.specifications', selector: 'dl[data-testid="ux-labels-values"]' },
        ]);
    });

    it('omits `selector` entirely for a check that declares none', () => {
        const report = auditExtraction({ ...healthy, product: { ...healthy.product, title: '' } }, checks);
        expect(report.issues).toEqual([{ field: 'product.title' }]);
    });

    it('escalates to broken when a critical field is absent', () => {
        const report = auditExtraction({ ...healthy, product: { ...healthy.product, title: '' } }, checks);
        expect(report.status).toBe('broken');
        expect(report.missingFields).toContain('product.title');
    });

    it('skips checks whose `when` gate is closed, and applies them when open', () => {
        const withSeller = auditExtraction({ ...healthy, seller: { displayName: null } }, checks);
        expect(withSeller.checkedFields).toBe(4);
        expect(withSeller.missingFields).toContain('seller.displayName');
        expect(withSeller.status).toBe('broken');
    });

    it('survives a null section without throwing on the nested path', () => {
        const report = auditExtraction({ product: null, seller: null }, checks);
        expect(report.missingFields).toEqual(['product.title', 'product.specifications', 'product.stock.soldCount']);
    });

});

describe('SCRAPED_ITEM_CHECKS', () => {
    it('gates every product/seller check so mode-irrelevant sections are not flagged', () => {
        const sellerOnly = auditExtraction(
            { product: null, sellerRef: null, seller: { profileUrl: 'https://www.ebay.com/str/x', displayName: 'x' } },
            SCRAPED_ITEM_CHECKS,
        );
        expect(sellerOnly.missingFields.some((f) => f.startsWith('product.'))).toBe(false);
        expect(sellerOnly.missingFields.some((f) => f.startsWith('sellerRef.'))).toBe(false);
    });

    it('flags the evo-layout regression: specifics empty while the rest of the page parsed', () => {
        const report = auditExtraction(
            {
                product: {
                    id: '296977871958',
                    title: 'Dell Latitude 3190 2-in-1',
                    brand: null,
                    pricing: { priceMin: 89.99 },
                    specifications: [],
                    media: { images: [{ url: 'https://i.ebayimg.com/x.jpg' }] },
                    description: { plainText: 'desc' },
                    paymentMethods: ['Visa'],
                },
                sellerRef: null,
                seller: null,
            },
            SCRAPED_ITEM_CHECKS,
        );
        expect(report.status).toBe('degraded');
        expect(report.missingFields).toEqual(['product.specifications', 'product.brand']);
    });
});
