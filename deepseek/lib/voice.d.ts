export interface VoiceOptions {
    text: string;
    voice: string;
    /** The existing task directory supplied by the trusted Studio caller. */
    directory: string;
    /** A new .wav file inside this task directory; its parent must exist. */
    output: string;
    /** Harness settings; when supplied, cloud credentials never fall back to process.env. */
    credentials?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    /** Persist submission-uncertain state before the potentially charged run-task. */
    onSubmitted?: () => void | Promise<void>;
}
/** Submit one Beijing CosyVoice task; a disconnect never creates another paid task. */
export declare function synthesizeVoice(options: VoiceOptions): Promise<{
    audioPath: string;
}>;
