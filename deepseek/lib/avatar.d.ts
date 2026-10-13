type Code = 'AVATAR_CONFIG' | 'AVATAR_INPUT' | 'AVATAR_BUSY' | 'AVATAR_UNCERTAIN' | 'AVATAR_CANCELLED' | 'AVATAR_TIMEOUT' | 'AVATAR_HTTP' | 'AVATAR_RESPONSE' | 'AVATAR_PROVIDER' | 'AVATAR_DOWNLOAD' | 'AVATAR_STORAGE';
export declare class AvatarError extends Error {
    readonly code: Code;
    constructor(code: Code, message: string);
}
/** Test seams replace transports or time; production callers omit this object. */
export interface AvatarInternals {
    fetch?: typeof fetch;
    put?: (url: URL, headers: Record<string, string>, source: string, signal: AbortSignal) => Promise<void>;
    now?: () => number;
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
    timeoutMs?: number;
    requestTimeoutMs?: number;
    pollMs?: number;
}
export interface AvatarOptions {
    videoPath: string;
    audioPath: string;
    output: string;
    directory: string;
    /** Harness settings; when supplied, cloud credentials never fall back to process.env. */
    credentials?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    onStage?: (stage: string) => void | Promise<void>;
    internal?: AvatarInternals;
}
/** Only regional Tencent COS endpoints are supported; custom domains need separate signing. */
export declare function validateCosEndpoint(value: string): string;
/** COS API requests require the complete BucketName-APPID, not the console name alone. */
export declare function validateCosBucket(value: string): string;
export declare function configurationError(credentials?: NodeJS.ProcessEnv): string | undefined;
export declare function avatarConfigured(credentials?: NodeJS.ProcessEnv): boolean;
export interface PrivateMediaOptions {
    filePath: string;
    objectKey: string;
    contentType: string;
    signal?: AbortSignal;
    credentials?: NodeJS.ProcessEnv;
    /** Test seams; production callers use the streaming HTTPS uploader. */
    internal?: Pick<AvatarInternals, 'put' | 'now' | 'requestTimeoutMs'>;
}
/** Upload a private media object; keep the returned three-hour URL in memory only. */
export declare function uploadPrivateMedia(options: PrivateMediaOptions): Promise<string>;
/** Upload private sources, submit one paid request, and resume by saved task ID. */
export declare function generateAvatar(options: AvatarOptions): Promise<{
    videoPath: string;
    taskId: string;
}>;
export {};
