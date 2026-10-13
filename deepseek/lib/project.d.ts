/** Export only this task and its local preview/render dependencies; never the shared production root. */
export declare function exportProject(workspace: string, taskId: string): Promise<string>;
