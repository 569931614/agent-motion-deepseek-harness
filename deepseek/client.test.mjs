import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function sandbox() {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  let plugin; const listeners = new Set();
  const window = { __ModuleLoader__: { load(module) { assert.equal(module.id, manifest.name); plugin = module; } },
    location: { origin: 'http://harness.test' },
    addEventListener(type, listener) { assert.equal(type, 'message'); listeners.add(listener); },
    removeEventListener(type, listener) { assert.equal(type, 'message'); listeners.delete(listener); },
  };
  runInNewContext(readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8'), {
    window,
  });
  const entries = new Map(), disposers = [];
  const client = plugin.factory(id => {
    assert.equal(id, 'react');
    return { createElement: (tag, props, ...children) => ({ tag, props, children }) };
  });
  let shell; const shellReads = [];
  client.apply({ effect(register) { disposers.push(register()); }, slots: {
    inject(name, register) { disposers.push(register()); },
    register(options, component) {
      entries.set(options.name, { options, component });
      return () => entries.delete(options.name);
    },
    entriesOfSlot(name) { shellReads.push(name); return shell ? [shell] : []; },
  } });
  return { manifest, entries, disposers, listeners, shellReads, setShell(next) { shell = next; }, send(event) { for (const listener of listeners) listener(event); } };
}

test('browser plugin registers native sidebar, main, and settings entries without bundling React', () => {
  const { manifest, entries, disposers } = sandbox();
  const sidebar = entries.get('sidebar.panellist'), main = entries.get('main');
  assert.equal(sidebar.options.label, '动效工坊');
  assert.equal(sidebar.options.id, main.options.key);
  const iframe = main.component({});
  assert.equal(iframe.tag, 'iframe');
  assert.equal(iframe.props.src, '/agent-motion/?embedded=1');
  assert.equal(iframe.props.title, '动效工坊');
  assert.equal(sidebar.component({ size: 18 }).props.width, 18);
  const settings = entries.get('settings.section');
  assert.equal(settings.options.id, 'agent-motion'); assert.equal(settings.options.label, '动效工坊'); assert.equal(settings.options.order, 25);
  const settingsFrame = settings.component({});
  assert.equal(settingsFrame.tag, 'iframe'); assert.equal(settingsFrame.props.title, '动效工坊设置'); assert.equal(settingsFrame.props.src, '/agent-motion/settings.html');
  assert.equal(settingsFrame.props.style.minHeight, 560); assert.equal(settingsFrame.props.style.width, '100%'); assert.equal(settingsFrame.props.style.border, 0);
  assert.equal(manifest.exports['./client'], './deepseek/lib/client.js');
  assert.equal(manifest.dsh.client.platform, 'web');
  disposers.forEach(dispose => dispose());
  assert.equal(entries.size, 0);
});

test('embedded open-settings messages use the current native shell and require the owned iframe and same origin', () => {
  const s = sandbox(), source = {}, actions = [];
  const iframe = s.entries.get('main').component({});
  iframe.props.ref({ contentWindow: source });
  s.setShell({ store: { create: () => ({ actions: { openSection: id => actions.push(id) } }) } });
  const valid = { origin: 'http://harness.test', source, data: { type: 'agent-motion-open-settings' } };
  for (const event of [
    { ...valid, origin: 'https://other.example' }, { ...valid, source: {} }, { ...valid, source: null },
    { ...valid, data: null }, { ...valid, data: 'agent-motion-open-settings' }, { ...valid, data: { type: 'other' } },
  ]) s.send(event);
  assert.deepEqual(actions, []); assert.deepEqual(s.shellReads, []);
  s.send(valid); assert.deepEqual(actions, ['agent-motion']);
  s.setShell({ store: { create: () => ({ actions: { openSection: id => actions.push('new-shell:' + id) } }) } });
  s.send(valid); assert.deepEqual(actions, ['agent-motion', 'new-shell:agent-motion']);
  assert.deepEqual(s.shellReads, ['sidebar.settings', 'sidebar.settings']);
  iframe.props.ref(null); s.send(valid); assert.equal(actions.length, 2);
  iframe.props.ref({ contentWindow: source }); s.setShell(undefined); s.send(valid); assert.equal(actions.length, 2);
});

test('browser plugin disposal removes its message listener and clears the iframe reference', () => {
  const s = sandbox(), source = {}, actions = [];
  s.entries.get('main').component({}).props.ref({ contentWindow: source });
  s.setShell({ store: { create: () => ({ actions: { openSection: id => actions.push(id) } }) } });
  const listener = [...s.listeners][0], valid = { origin: 'http://harness.test', source, data: { type: 'agent-motion-open-settings' } };
  assert.equal(s.listeners.size, 1);
  s.disposers.forEach(dispose => dispose());
  assert.equal(s.listeners.size, 0); assert.equal(s.entries.size, 0);
  s.send(valid); listener(valid); assert.deepEqual(actions, []);
});

test('settings-saved forwards only a credential-free update from the owned settings iframe to the owned studio iframe', () => {
  const s = sandbox(), settingsSource = {}, received = [];
  const studioSource = { postMessage(message, origin) { received.push({ message, origin }); } };
  const studio = s.entries.get('main').component({}), settings = s.entries.get('settings.section').component({});
  studio.props.ref({ contentWindow: studioSource }); settings.props.ref({ contentWindow: settingsSource });
  const valid = { origin: 'http://harness.test', source: settingsSource, data: { type: 'agent-motion-settings-saved', secret: 'synthetic-secret-must-not-forward' } };
  for (const event of [{ ...valid, origin: 'https://other.example' }, { ...valid, source: {} }, { ...valid, source: studioSource }, { ...valid, data: null }]) s.send(event);
  assert.equal(received.length, 0); assert.deepEqual(s.shellReads, []);
  s.send(valid);
  assert.equal(received.length, 1); assert.equal(received[0].origin, 'http://harness.test');
  assert.deepEqual(Object.keys(received[0].message), ['type']); assert.equal(received[0].message.type, 'agent-motion-settings-updated');
  settings.props.ref(null); s.send(valid); assert.equal(received.length, 1);
  settings.props.ref({ contentWindow: settingsSource }); studio.props.ref(null); s.send(valid); assert.equal(received.length, 1);
  studio.props.ref({ contentWindow: studioSource }); const listener = [...s.listeners][0];
  s.disposers.forEach(dispose => dispose()); listener(valid); assert.equal(received.length, 1); assert.equal(s.listeners.size, 0);
});

test('studio retries definite execution rejection but never resubmits an uncertain paid request', async () => {
  const source = readFileSync(new URL('./web/app.js', import.meta.url), 'utf8');
  const functions = source.slice(0, source.indexOf("$('chooseVideo').onclick"));
  assert.ok(functions.includes('async function submit()'));
  for (const status of [409, 503, 500, 'network']) {
    const storage = new Map(); let executions = 0;
    const load = () => {
      const nodes = new Map();
      const context = {
        URLSearchParams, location: { search: '' }, clearTimeout() {}, setTimeout() {},
        document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); } },
        localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
        async fetch(url) {
          if (url.includes('/execute?')) {
            executions++;
            if (status === 'network') throw new TypeError('Connection lost after submission');
            return new Response(JSON.stringify({ error: 'Mock execute response' }), { status });
          }
          assert.ok(url.includes('/status?'));
          return new Response(JSON.stringify({ id: 'test-job', status: 'ready' }));
        },
      };
      // Exercise real submit/status logic; rendering and form restoration are covered by browser QA.
      runInNewContext(functions + `
        render = () => {}; restoreForm = () => {};
        task = { id: 'test-job', status: 'ready' }; config = { ready: true }; configLoading = false;
        globalThis.studio = { submit, refreshTask };
      `, context);
      return context.studio;
    };
    const page = load(); await page.submit();
    const uncertain = status === 500 || status === 'network';
    assert.equal(storage.has('agent-motion-execute-uncertain'), uncertain, String(status));
    await page.refreshTask(); await page.submit();
    assert.equal(executions, uncertain ? 1 : 2, String(status));
    const restored = load(); await restored.refreshTask(); await restored.submit();
    assert.equal(executions, uncertain ? 1 : 3, `reload ${status}`);
  }
});
