import type { CaptureMode } from './input.dto.js';
import type { Product } from './product.dto.js';
import type { SellerRef, SellerSection } from './seller.dto.js';
import type { SellerTechnical, Technical } from './technical.dto.js';

/**
 * The unified response shape pushed to the dataset. Shape is stable across all
 * capture modes — fields not applicable to a given mode are `null`.
 */
export interface ScrapedItem {
    platform: 'ebay';
    url: string;
    capturedAt: string;
    captureMode: CaptureMode;
    product: Product | null;
    sellerRef: SellerRef | null;
    seller: SellerSection | null;
    technical: Technical | null;
    sellerTechnical: SellerTechnical | null;
}

/** Shape of `request.userData` passed between crawler handlers. */
export interface RequestUserData {
    scrappedItem?: ScrapedItem;
    sellerBaseUrl?: string;
    negativeUrl?: string | null;
    positiveUrl?: string | null;
    neutralUrl?: string | null;
}
