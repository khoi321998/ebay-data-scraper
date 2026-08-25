import type { ExtractionReport } from './extraction.dto.js';
import type { CaptureMode } from './input.dto.js';
import type { Product } from './product.dto.js';
import type { SellerRef, SellerSection } from './seller.dto.js';
import type { ScrapeOutcome } from './status.dto.js';
import type { SellerTechnical, Technical } from './technical.dto.js';

/**
 * The unified response shape pushed to the dataset. Shape is stable across all
 * capture modes — fields not applicable to a given mode are `null`.
 */
export interface ScrapedItem extends ScrapeOutcome {
    platform: 'ebay';
    url: string;
    /**
     * The Apify run that wrote this record, or `null` when scraped locally. Required, never
     * optional: a dataset appended to by several runs needs every row to say which one it came
     * from, and an absent key would read as "older record" rather than "ran off-platform".
     */
    actorRunId: string | null;
    capturedAt: string;
    captureMode: CaptureMode;
    product: Product | null;
    sellerRef: SellerRef | null;
    seller: SellerSection | null;
    technical: Technical | null;
    sellerTechnical: SellerTechnical | null;
    /** Which expected fields came back absent — see `extraction.dto.ts`. */
    extraction: ExtractionReport;
}

/** Shape of `request.userData` passed between crawler handlers. */
export interface RequestUserData {
    scrappedItem?: ScrapedItem;
    sellerBaseUrl?: string;
    negativeUrl?: string | null;
    positiveUrl?: string | null;
    neutralUrl?: string | null;
}
