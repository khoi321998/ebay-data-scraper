export interface TrackingIds {
    googleAnalytics: string[];
    facebookPixel: string[];
}

export interface PageContext {
    pageType: string;
    searchQuery: string | null;
    position: number;
    listingType: string | null;
    campaignId: string | null;
}

/** Technical metadata captured from the product/listing page. */
export interface Technical {
    scriptBlocks: unknown[];
    jsonState: Record<string, unknown>;
    dataAttributes: Record<string, unknown>;
    rawUrlParameters: Record<string, string>;
    experimentIds: unknown[];
    trackingIds: TrackingIds;
    pageContext: PageContext;
    fulfilmentCodes: unknown[];
    jsBundles: string[];
    cssBundles: string[];
    apiEndpoints: string[];
}

/** Technical metadata captured from the seller store page. */
export interface SellerTechnical {
    scriptBlocks: number;
    jsonState: Record<string, unknown>;
    dataAttributes: Record<string, unknown>;
    trackingIds: TrackingIds;
    jsBundles: string[];
    cssBundles: string[];
}
