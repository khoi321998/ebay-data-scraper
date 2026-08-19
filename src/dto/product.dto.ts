import type { ParsedCurrency, ProductImage, ReviewSample, Specification } from './common.dto.js';

export interface Pricing {
    /** ISO 4217 the listing itself is priced in — falls back to the marketplace currency. */
    currency: string;
    priceMin: number | null;
    priceMax: number | null;
    /**
     * eBay's conversion into the marketplace currency, shown when the listing is priced in a
     * foreign one ("Aproximadamente 78,57 EUR" on ebay.es for a USD listing). Null when the
     * listing already prices in the site's own currency.
     */
    localized: ParsedCurrency | null;
}

export interface Stock {
    availableQuantity: number | null;
    soldCount: number | null;
}

export interface ProductShipping {
    deliveryTimeText: string | null;
}

export interface ProductDescription {
    html: string | null;
    plainText: string | null;
}

export interface ProductMedia {
    images: ProductImage[];
    videos: unknown[];
}

export interface ReviewsSummary {
    rating: number | null;
    reviewCount: number | null;
    ratingBreakdown: Record<number, number>;
    negativeReviewSamples: ReviewSample[];
    positiveReviewSamples: ReviewSample[];
    neutralReviewSamples: ReviewSample[];
}

export interface Product {
    id: string | null;
    title: string;
    brand: string | null;
    pricing: Pricing;
    stock: Stock;
    shipping: ProductShipping;
    paymentMethods: string[];
    description: ProductDescription;
    specifications: Specification[];
    media: ProductMedia;
    reviewsSummary: ReviewsSummary;
}
