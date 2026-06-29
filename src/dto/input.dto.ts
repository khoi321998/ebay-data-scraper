/** Capture mode controls which sections of the response are populated. */
export type CaptureMode = 'product_only' | 'seller_only' | 'product_and_seller';

/** Raw Actor input as accepted by `Actor.getInput()`. */
export interface ActorInput {
    mode?: CaptureMode;
    startUrls?: string[];
    /** Legacy aliases still accepted for backwards compatibility. */
    productUrls?: string[];
    sellerUrls?: string[];
}
