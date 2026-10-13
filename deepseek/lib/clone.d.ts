import { uploadPrivateMedia } from './avatar.js';
interface RunOptions {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    timeoutMs: number;
    maxOutputBytes: number;
}
/** Tests replace transport, media processes and time; production callers omit this. */
export interface CloneInternals {
    run?: (command: string, args: string[], options: RunOptions) => Promise<string>;
    upload?: typeof uploadPrivateMedia;
    fetch?: typeof fetch;
    now?: () => number;
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
    timeoutMs?: number;
    requestTimeoutMs?: number;
    pollMs?: number;
}
export interface CloneOptions {
    videoPath: string;
    directory: string;
    workspace: string;
    signal?: AbortSignal;
    /** Harness settings; when supplied, cloud credentials never fall back to process.env. */
    credentials?: NodeJS.ProcessEnv;
    onStage?: (stage: string) => void | Promise<void>;
    internal?: CloneInternals;
}
export declare class CloneError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** Extract the speaker sample once, create one voice, then resume by querying its ID. */
export declare function cloneVideoVoice(options: CloneOptions): Promise<{
    voiceId: string;
}>;
export {};
