/** Browser half loaded by Harness; reuse its React renderer and native slots. */
interface Window {
    __ModuleLoader__: {
        load(module: {
            id: string;
            factory: (require: (id: string) => {
                createElement: (tag: string, props: Record<string, unknown>, ...children: unknown[]) => unknown;
            }) => unknown;
        }): void;
    };
}
interface SettingsShellEntry {
    store?: {
        create(): {
            actions?: {
                openSection?(id: string): void;
            };
        };
    };
}
interface ClientContext {
    slots: {
        inject(name: string, register: () => () => void): void;
        register(options: Record<string, unknown>, component: (props: {
            size: number;
        }) => unknown): () => void;
        entriesOfSlot(name: string): readonly SettingsShellEntry[];
    };
    effect(register: () => () => void): void;
}
