import type { Context } from '@deepseek-ai/cordis';
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller';
import type { WorkspaceController } from '@deepseek-ai/dsh-api-workspace-controller';
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval';
import { type CredentialProvider } from '@deepseek-ai/dsh-credentials';
import { synthesizeVoice } from './voice.js';
import { generateAvatar, configurationError } from './avatar.js';
import { cloneVideoVoice } from './clone.js';
declare const styles: {
    readonly technology: "科技感";
    readonly education: "教育风";
    readonly marketing: "营销风";
};
type CredentialStore = Pick<CredentialProvider, 'readRecord' | 'modifyRecord' | 'describeRecord'>;
type Status = 'awaiting-upload' | 'ready' | 'queued' | 'running' | 'stopping' | 'completed' | 'failed' | 'cancelled';
type Phase = 'upload' | 'clone' | 'voice' | 'avatar' | 'subtitles' | 'matte' | 'composition' | 'export';
interface Input {
    subtitles: string;
    title: string;
    voiceSource: 'video' | 'existing';
    voice: string;
    style: keyof typeof styles;
    width: number;
    height: number;
}
interface Task extends Input {
    id: string;
    status: Status;
    stage: string;
    message: string;
    updatedAt: string;
    sessionId?: string;
    skillLoaded: boolean;
    lastSeq: number;
    events: string[];
    voiceSubmitted?: boolean;
    voiceReady?: boolean;
    avatarReady?: boolean;
    ruleRevision?: string;
    phase?: Phase;
}
type Controller = Pick<SessionController, 'create' | 'prompt' | 'inspect' | 'cancel' | 'projections' | 'updateQueue' | 'rename'>;
export declare function validateInput(value: unknown): Input;
/** One shared production environment; each job retains separate inputs, session and output. */
export declare class Studio {
    readonly storage: string;
    readonly controller: Controller;
    readonly workspaceController?: Pick<WorkspaceController, "create" | "rename"> | undefined;
    private readonly providers;
    private readonly credentials?;
    readonly workspace: string;
    private readonly tasks;
    private readonly uploads;
    private readonly refreshes;
    private readonly saves;
    private readonly executions;
    private readonly cloudJobs;
    private readonly approvals;
    private preparing?;
    private starting;
    private disposed;
    constructor(storage: string, controller: Controller, workspaceController?: Pick<WorkspaceController, "create" | "rename"> | undefined, providers?: {
        cloneVideoVoice: typeof cloneVideoVoice;
        synthesizeVoice: typeof synthesizeVoice;
        generateAvatar: typeof generateAvatar;
        configurationError: typeof configurationError;
    }, credentials?: CredentialStore | undefined);
    private cloudCredentials;
    private settingsWritable;
    private configurationFor;
    configuration(): Promise<object>;
    settings(value?: unknown): Promise<object>;
    private prepare;
    private save;
    private load;
    private inputDirectory;
    private outputDirectory;
    create(value: unknown): Promise<Task>;
    upload(id: string, request: Request): Promise<Task>;
    private prompt;
    execute(id: string, signal: AbortSignal): Promise<Task>;
    private run;
    cancel(id: string): Promise<Task>;
    status(id: string): Promise<Task>;
    private refresh;
    publicTask(task: Task): object;
    /** Use the host's approval waterfall; only the user's one-shot decision grants an action. */
    requestApproval(request: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>;
    approve(id: string, value: unknown): Promise<Task>;
    dispose(): void;
    api(action: string, request: Request): Promise<Response>;
    file(id: string, relative: string): Promise<string>;
}
/** Mounted only when the host's existing authenticated Web/session services are present. */
export declare function mountStudio(ctx: Context): void;
export {};
