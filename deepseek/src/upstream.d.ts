declare module '*.mjs' {
  export function startServer(options?: { port?: number; root?: string }): Promise<{ server: import('node:http').Server; url: string }>;
  export function launchBrowser(options?: import('playwright-core').LaunchOptions): Promise<import('playwright-core').Browser>;
  export function mediaPath(name: string): string;
}
