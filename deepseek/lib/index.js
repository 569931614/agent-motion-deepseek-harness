import * as filesystemSkills from '@deepseek-ai/dsh-skill-filesystem';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { mountStudio } from './web.js';
export const name = 'agent-motion';
export const inject = ['skills'];
/** Mount packaged production skills through the host's filesystem provider. */
export async function apply(ctx) {
    await ctx.plugin(filesystemSkills, {
        providerName: 'agent-motion',
        includeDefaultRoots: false,
        bundledSkillDir: fileURLToPath(new URL('../../.agents/skills/', import.meta.url)),
        customSkillDirs: [path.join(resolveDshHome(), 'agent-motion', 'production', '.agents', 'skills')],
        watch: true,
    });
    ctx.inject(['webServer', 'connection', 'sessionController', 'workspaceController', 'credentials'], mountStudio);
}
