/** Browser half loaded by Harness; reuse its React renderer and native slots. */
interface Window {
  __ModuleLoader__: { load(module: { id: string; factory: (require: (id: string) => { createElement: (tag: string, props: Record<string, unknown>, ...children: unknown[]) => unknown }) => unknown }): void };
}
interface SettingsShellEntry {
  store?: { create(): { actions?: { openSection?(id: string): void } } };
}
interface ClientContext {
  slots: {
    inject(name: string, register: () => () => void): void;
    register(options: Record<string, unknown>, component: (props: { size: number }) => unknown): () => void;
    entriesOfSlot(name: string): readonly SettingsShellEntry[];
  };
  effect(register: () => () => void): void;
}
window.__ModuleLoader__.load({
  id: 'agent-motion',
  factory(require) {
    const { createElement } = require('react');
    return {
      inject: ['slots', 'layout'],
      apply(ctx: ClientContext) {
        let studioFrame: HTMLIFrameElement | null = null, settingsFrame: HTMLIFrameElement | null = null;
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'agent-motion' }, () => createElement('iframe', {
          title: '动效工坊', src: '/agent-motion/?embedded=1',
          ref: (element: HTMLIFrameElement | null) => { studioFrame = element; },
          style: { width: '100%', flex: 1, minHeight: 0, border: 0 },
        })));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'agent-motion', order: 20, label: '动效工坊',
        }, ({ size }) => createElement('svg', {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        }, createElement('rect', { x: 3, y: 5, width: 18, height: 14, rx: 2 }), createElement('path', { d: 'M10 9l5 3-5 3Z' }))));
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'agent-motion', order: 25, label: '动效工坊',
        }, () => createElement('iframe', {
          title: '动效工坊设置', src: '/agent-motion/settings.html',
          ref: (element: HTMLIFrameElement | null) => { settingsFrame = element; },
          style: { width: '100%', height: '100%', minHeight: 560, border: 0 },
        })));
        ctx.effect(() => {
          const openSettings = (event: MessageEvent) => {
            if (event.origin !== window.location.origin || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return;
            if (event.data.type === 'agent-motion-settings-saved') {
              if (settingsFrame?.contentWindow && event.source === settingsFrame.contentWindow) {
                studioFrame?.contentWindow?.postMessage({ type: 'agent-motion-settings-updated' }, window.location.origin);
              }
              return;
            }
            if (event.data.type !== 'agent-motion-open-settings' || !studioFrame?.contentWindow || event.source !== studioFrame.contentWindow) return;
            // The shell exposes its shared instance through the public slot ledger.
            // Re-read the winning entry so a replaced shell is never held here.
            ctx.slots.entriesOfSlot('sidebar.settings')[0]?.store?.create().actions?.openSection?.('agent-motion');
          };
          window.addEventListener('message', openSettings);
          return () => { window.removeEventListener('message', openSettings); studioFrame = null; settingsFrame = null; };
        });
      },
    };
  },
});
