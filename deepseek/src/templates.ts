import { readFileSync } from 'node:fs';
import { simplified } from './srt.js';

export interface Template {
  id: string; name: string; aliases: string[];
  palette: Record<'background' | 'surface' | 'text' | 'muted' | 'accent' | 'accentSecondary', string>;
  typography: { titleFont: string; bodyFont: string; titleFontPath: string; bodyFontPath: string; titleFallbackFont?: string };
  layout: { person: { x: number; y: number; width: number; height: number }; title: { x: number; y: number; width: number }; subtitle: { x: number; y: number; width: number } };
  motion: { durationSeconds: number; easing: string; entrance: string };
  content: { eyebrow: string; title: string; chapter: string; steps: string[]; subtitle: string };
}

/** Select a bundled template by a Chinese brief; explicit 风格: takes precedence. */
export function selectTemplate(brief: string, explicit?: string): Template {
  const catalog: { styles: Template[] } = JSON.parse(readFileSync(new URL('../../templates/catalog.json', import.meta.url), 'utf8'));
  const text = simplified(brief).toLowerCase();
  const requested = explicit ?? /(?:风格|模板)\s*[:：]\s*([^\n，。;；]+)/.exec(text)?.[1]?.trim();
  const styles = catalog.styles.filter(style => style.aliases.some(alias => requested
    ? alias.toLowerCase() === requested.toLowerCase() || style.id === requested
    : text.includes(alias.toLowerCase())));
  if (requested && styles.length !== 1) throw new Error('Unknown style. Choose 科技感、教育风 or 营销风.');
  if (styles.length > 1) throw new Error('Brief mentions multiple styles. Specify one using 风格：科技感/教育风/营销风.');
  const style = styles[0] ?? catalog.styles[0];
  if (!style) throw new Error('Template catalog is empty.');
  for (const color of Object.values(style.palette)) {
    if (!/^#[\da-f]{6}$/i.test(color)) throw new Error(`Invalid template palette: ${style.id}`);
  }
  for (const rectangle of Object.values(style.layout)) {
    if (Object.values(rectangle).some(value => !Number.isFinite(value) || value < 0 || value > 1) || rectangle.x + rectangle.width > 1) {
      throw new Error(`Invalid normalized template layout: ${style.id}`);
    }
  }
  return style;
}
