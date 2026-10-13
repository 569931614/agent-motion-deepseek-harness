export { renderProject } from '../../scripts/render-project.mjs';
/** Run SRT → CPU matting → template scene → original audio → H.264 pipeline. */
export declare function produce(args: string[]): Promise<string>;
