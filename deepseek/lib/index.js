import * as filesystemSkills from '@deepseek-ai/dsh-skill-filesystem';
import { fileURLToPath } from 'node:url';
export const name = 'agent-motion';
export const inject = ['skills'];
/** Mount packaged production skills through the host's filesystem provider. */
export async function apply(ctx) {
    await ctx.plugin(filesystemSkills, {
        providerName: 'agent-motion',
        includeDefaultRoots: false,
        bundledSkillDir: fileURLToPath(new URL('../../.agents/skills/', import.meta.url)),
        watch: false,
    });
}
