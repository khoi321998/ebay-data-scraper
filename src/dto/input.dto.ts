/** Capture mode controls which sections of the response are populated. */
export type CaptureMode = 'product_only' | 'seller_only' | 'product_and_seller';

/** Raw Actor input as accepted by `Actor.getInput()`. */
export interface ActorInput {
    mode?: CaptureMode;
    startUrls?: string[];
    /** How many requests run at once (default 10, clamped to 1–50). */
    maxConcurrency?: number;
    /** Legacy aliases still accepted for backwards compatibility. */
    productUrls?: string[];
    sellerUrls?: string[];
}
