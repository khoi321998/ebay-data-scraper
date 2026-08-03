import type { ReviewSample } from './common.dto.js';

/** Lightweight seller reference attached to a product (product modes). */
export interface SellerRef {
    platformSellerId: string | null;
    displayName: string | null;
    ebayUsername: string | null;
}

export interface FeedbackSummary {
    positive: number | null;
    neutral: number | null;
    negative: number | null;
}

export interface DetailedRatings {
    accurateDescription: number | null;
    shippingSpeed: number | null;
    communication: number | null;
    shippingCost: number | null;
}

export interface SellerFeedback {
    summary: FeedbackSummary;
    detailedRatings: DetailedRatings;
    negativeReviewSamples: ReviewSample[];
    positiveReviewSamples: ReviewSample[];
    neutralReviewSamples: ReviewSample[];
}

export interface SellerAbout {
    description: string | null;
    location: string | null;
    memberSince: string | null;
    businessDetails: Record<string, string> | null;
}

export interface StoreItem {
    name: string | null;
    imageUrl: string | null;
    currency: string | null;
    priceMin: number | null;
    priceMax: number | null;
    url: string | null;
}

/** Full seller section populated in seller modes. */
export interface SellerSection {
    profileUrl: string | null;
    displayName: string | null;
    ebayUsername: string | null;
    storeId: string | null;
    feedbackScore: number | null;
    positivePercent: number | null;
    itemsSold: number | null;
    followers: number | null;
    feedback: SellerFeedback;
    totalSellerFeedbackCount: number | null;
    about: SellerAbout | null;
    logoUrl: string | null;
    storeItems: StoreItem[];
}
