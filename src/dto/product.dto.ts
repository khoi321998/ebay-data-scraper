import type { ProductImage, ReviewSample, Specification } from './common.dto.js';

export interface Pricing {
    currency: string;
    priceMin: number | null;
    priceMax: number | null;
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
