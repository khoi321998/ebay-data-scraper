/** A currency amount parsed out of a free-form price string. */
export interface ParsedCurrency {
    currency: string;
    cost: number;
}

/** A single buyer feedback / review sample (used for both product and seller). */
export interface ReviewSample {
    user: string | null;
    userFeedbackScore: number | null;
    comment: string | null;
    commentDate: string | null;
    ratingType: string | null;
    verifiedPurchase: boolean;
}

/** A product specification name/value pair from the item specifics table. */
export interface Specification {
    name: string;
    value: string;
}

/** A product image reference. */
export interface ProductImage {
    url: string;
}

/** A shipping option extracted from the listing page. */
export interface ShippingOption {
    name: string;
    cost: number;
    currency: string;
    estimatedDeliveryMinDays: number | null;
    estimatedDeliveryMaxDays: number | null;
}
