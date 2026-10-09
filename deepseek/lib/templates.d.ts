export interface Template {
    id: string;
    name: string;
    aliases: string[];
    palette: Record<'background' | 'surface' | 'text' | 'muted' | 'accent' | 'accentSecondary', string>;
    typography: {
        titleFont: string;
        bodyFont: string;
        titleFontPath: string;
        bodyFontPath: string;
        titleFallbackFont?: string;
    };
    layout: {
        person: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
        title: {
            x: number;
            y: number;
            width: number;
        };
        subtitle: {
            x: number;
            y: number;
            width: number;
        };
    };
    motion: {
        durationSeconds: number;
        easing: string;
        entrance: string;
    };
    content: {
        eyebrow: string;
        title: string;
        chapter: string;
        steps: string[];
        subtitle: string;
    };
}
/** Select a bundled template by a Chinese brief; explicit 风格: takes precedence. */
export declare function selectTemplate(brief: string, explicit?: string): Template;
