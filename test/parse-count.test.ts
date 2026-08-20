import { describe, expect, it } from 'vitest';

import { parseAmount, parseCount } from '../src/parse-currency.js';

const NBSP = ' ';

describe('parseCount', () => {
    it('reads the counts ebay.es actually renders', () => {
        // Verified against https://www.ebay.es/str/bargaininc?_tab=feedback on 2026-08-20.
        expect(parseCount(`2${NBSP}329`).value).toBe(2329);
        expect(parseCount(`56${NBSP}mil`).value).toBe(56_000);
        expect(parseCount(`4,3${NBSP}mil`).value).toBe(4_300);
    });

    it('reads the en-US equivalents', () => {
        expect(parseCount('2,329').value).toBe(2329);
        expect(parseCount('56K').value).toBe(56_000);
        expect(parseCount('4.3K').value).toBe(4_300);
        expect(parseCount('1.2M').value).toBe(1_200_000);
    });

    it('does not let `m` swallow the words that merely start with it', () => {
        // Spanish/Italian thousands vs the million abbreviations they look like.
        expect(parseCount('56 mil').value).toBe(56_000);
        expect(parseCount('56 mila').value).toBe(56_000);
        expect(parseCount('56 mln').value).toBe(56_000_000);
        expect(parseCount('56 Mio.').value).toBe(56_000_000);
        expect(parseCount('56 Tsd.').value).toBe(56_000);
    });

    it('reports an unknown suffix instead of guessing a multiplier', () => {
        const parsed = parseCount('56 qqq');
        expect(parsed.value).toBe(56);
        expect(parsed.unknownSuffix).toBe('qqq');
    });

    it('returns null when there is no number at all', () => {
        expect(parseCount('').value).toBeNull();
        expect(parseCount(null).value).toBeNull();
        expect(parseCount('sin votos').value).toBeNull();
    });
});

describe('parseAmount on the seller-card numbers', () => {
    it('reads a European thousands separator as thousands, not as decimals', () => {
        // The old `parseInt('23.560')` gave 23 — a 1000x error in feedbackScore on every EU site.
        expect(parseAmount('23.560')).toBe(23_560);
        expect(parseAmount('23,560')).toBe(23_560);
    });

    it('keeps a one-digit tail as a decimal in both conventions', () => {
        expect(parseAmount('97,7')).toBe(97.7);
        expect(parseAmount('97.7')).toBe(97.7);
        expect(parseAmount('4,8')).toBe(4.8);
    });
});
