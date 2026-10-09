import type { Context } from '@deepseek-ai/cordis';
export declare const name = "agent-motion";
export declare const inject: string[];
/** Mount packaged production skills through the host's filesystem provider. */
export declare function apply(ctx: Context): Promise<void>;
