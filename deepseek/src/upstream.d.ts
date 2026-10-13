declare module '*.mjs' {
  export function startServer(options?: { port?: number; root?: string }): Promise<{ server: import('node:http').Server; url: string }>;
  export function launchBrowser(options?: import('playwright-core').LaunchOptions): Promise<import('playwright-core').Browser>;
  export function mediaPath(name: string): string;
  export function renderProject(directory: string): Promise<void>;
  export function validateEncoding(width: number, height: number, fps: number): void;
  export function validateMusicVolume(volume: number): void;
  export function findPython(): { command: string; prefix: string[]; executable: string };
  export function parseRange(value: string | undefined, size: number): { start: number; end: number } | false | null;
  export function createWorkspace(directory: string): string;
  export function snapshotRules(workspace: string, pluginRoot: string, directory: string): Promise<string>;
  export function ensureRuleReader(workspace: string, pluginRoot: string): Promise<void>;
}
