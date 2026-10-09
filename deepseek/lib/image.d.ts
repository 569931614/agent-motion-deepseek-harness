export interface ImageOptions {
    output: string;
    prompt?: string;
    model?: string;
    size?: string;
    references?: string[];
    maxImages?: number;
    watermark?: boolean;
    resume?: boolean;
    timeoutMs?: number;
    pollMs?: number;
}
/** Only raster image bytes are accepted, never HTML or SVG returned as a picture. */
export declare function imageExtension(bytes: Uint8Array): 'png' | 'jpg' | 'webp';
/** Submit once, poll the documented task endpoint, then save local images for rendering. */
export declare function generateImages(options: ImageOptions): Promise<string[]>;
export declare function imageCli(args: string[]): Promise<void>;
