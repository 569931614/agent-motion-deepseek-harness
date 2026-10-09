export interface Cue {
    index: number;
    start: number;
    end: number;
    text: string;
}
/** Normalize visible text to Simplified Chinese without changing subtitle timing. */
export declare function simplified(text: string): string;
/** Parse UTF-8 SRT, rejecting ambiguous overlapping cues and malformed timings. */
export declare function parseSrt(source: string): Cue[];
