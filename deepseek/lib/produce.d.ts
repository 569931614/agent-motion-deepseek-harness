/** Render an editable project at absolute times and mux its original speech audio. */
export declare function renderProject(directory: string): Promise<void>;
/** Run SRT → CPU matting → template scene → original audio → H.264 pipeline. */
export declare function produce(args: string[]): Promise<string>;
