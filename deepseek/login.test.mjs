import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { launchBrowser } from '../scripts/browser.mjs';

test('same-site login bridge preserves Strict authentication after a cross-site launch redirect', { timeout: 45000 }, async t => {
  const token = Buffer.alloc(32, 7).toString('base64url'); // Synthetic launch token only.
  const invalid = Buffer.alloc(32, 8).toString('base64url');
  const records = [];
  let origin;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    const cookie = String(req.headers.cookie ?? '').includes('fixture-auth=accepted');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    if (req.headers.host.startsWith('localhost:')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<a id="direct" href="${origin}/?token=${token}">Direct</a><a id="bridge" href="${origin}/agent-motion/login#token=${token}">Bridge</a>`);
      return;
    }
    if (url.pathname === '/agent-motion/login' || url.pathname === '/agent-motion/login.js') {
      const filename = url.pathname.endsWith('.js') ? 'login.js' : 'login.html';
      res.writeHead(200, { 'content-type': filename.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' });
      res.end(readFileSync(new URL(`./web/${filename}`, import.meta.url)));
      return;
    }
    if (url.pathname !== '/') { res.writeHead(404).end(); return; }
    records.push({ token: url.searchParams.has('token'), cookie, site: req.headers['sec-fetch-site'] });
    if (url.searchParams.getAll('token').length === 1 && url.searchParams.get('token') === token) {
      res.writeHead(303, { location: './', 'set-cookie': 'fixture-auth=accepted; Path=/; HttpOnly; SameSite=Strict' });
      res.end();
      return;
    }
    res.writeHead(cookie ? 200 : 401, { 'content-type': 'text/html; charset=utf-8' });
    res.end(cookie ? '<!doctype html><body>fixture authenticated</body>' : 'dsh web authentication required');
  });
  await new Promise(resolve => server.listen(0, resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const outside = `http://localhost:${server.address().port}`;
  let browser;
  t.after(async () => { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  browser = await launchBrowser();

  await t.test('cross-site 303 can retain a cookie without sending it to the redirected root', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(outside);
      records.length = 0;
      await page.locator('#direct').click();
      assert.equal(await page.locator('body').textContent(), 'dsh web authentication required');
      assert.deepEqual(records.slice(0, 2), [
        { token: true, cookie: false, site: 'cross-site' },
        { token: false, cookie: false, site: 'cross-site' },
      ]);
      assert.ok((await context.cookies(origin)).some(cookie => cookie.name === 'fixture-auth' && cookie.httpOnly && cookie.sameSite === 'Strict'));
    } finally { await context.close(); }
  });

  await t.test('the actual bridge exchanges a fragment token from its same-origin page', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(outside);
      records.length = 0;
      await page.locator('#bridge').click();
      await page.waitForURL(origin + '/');
      assert.equal(await page.locator('body').textContent(), 'fixture authenticated');
      assert.deepEqual(errors, []);
      assert.ok(records.some(record => record.token && record.site === 'same-origin'));
      assert.ok(records.some(record => !record.token && record.cookie && record.site === 'same-origin'));
      assert.equal((await page.request.get(origin + '/')).status(), 200);
      await page.goto(origin + '/agent-motion/login');
      await page.waitForURL(origin + '/');
      assert.equal(await page.locator('body').textContent(), 'fixture authenticated');
    } finally { await context.close(); }
  });

  await t.test('missing or invalid tokens leave the root protected and allow manual retry', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      for (const suffix of ['', `#token=${invalid}`]) {
        await page.goto(outside);
        await page.goto(origin + '/agent-motion/login' + suffix);
        await page.waitForFunction(() => !location.hash && document.getElementById('loginButton')?.disabled === false);
        assert.equal(new URL(page.url()).pathname, '/agent-motion/login');
        assert.equal(await page.locator('#tokenInput').inputValue(), '');
        assert.equal((await page.request.get(origin + '/')).status(), 401);
        assert.equal((await context.cookies(origin)).some(cookie => cookie.name === 'fixture-auth'), false);
      }
      const before = records.length;
      await page.locator('#tokenInput').fill(outside + '/?token=' + token);
      await page.locator('#loginButton').click();
      await page.waitForFunction(() => document.getElementById('statusText')?.textContent.includes('当前本机地址'));
      assert.equal(records.length, before, 'A pasted foreign origin must not receive or exchange the token');
      await page.locator('#tokenInput').fill(origin + '/?token=' + token);
      await page.locator('#loginButton').click();
      await page.waitForURL(origin + '/');
      assert.equal(await page.locator('body').textContent(), 'fixture authenticated');
    } finally { await context.close(); }
  });
});
