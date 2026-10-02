'use strict';

/*
 * End-to-end test: loads the real extension into Chromium and opens a mock
 * Google Chat page (tests/fixtures/mock-chat.html) served at chat.google.com.
 *
 *   npm run test:e2e
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  test('e2e (playwright is not installed)', { skip: 'run `npm install` first' }, () => {});
  return;
}

const EXT = path.join(__dirname, '..', 'extension');
const PAGE = fs.readFileSync(path.join(__dirname, 'fixtures', 'mock-chat.html'), 'utf8');
const URL = 'https://chat.google.com/u/0/dm/AAA';
const QUIET_MS = 3500; // long enough for the extension to react if it wanted to

const offer = (id, route = 'Hammond, IN → Terrell, TX') =>
  `${id} • ${route}\nLive pickup: Oct 02, 2026, 00:01 - 23:59 CDT\nLive dropoff: Oct 05, 2026, 08:00 - 17:00 CDT\nDry van\nPallet (packaging type)\n11387 lbs`;

let context;
let worker;
let userDataDir;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setSettings(patch) {
  await worker.evaluate(async (p) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, ...p } });
  }, patch);
}

async function readLog() {
  return worker.evaluate(async () => (await chrome.storage.local.get('log')).log || []);
}

async function openChat(query = '') {
  const page = await context.newPage();
  await page.goto(URL + query);
  await sleep(1500); // let the content script start and see the history
  return page;
}

const sent = (page) => page.evaluate(() => window.sent);
const add = (page, text, opts) => page.evaluate(([t, o]) => window.addMessage(t, o), [text, opts || {}]);
const waitSent = (page, n, timeout = 8000) =>
  page.waitForFunction((count) => window.sent.length >= count, n, { timeout });

before(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmc-e2e-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  await context.route('https://chat.google.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: PAGE })
  );
  worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
});

after(async () => {
  await context?.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

test('replies to a new offer, ignores old offers, follow-ups, chit-chat and own messages', async () => {
  const page = await openChat();

  await sleep(QUIET_MS);
  assert.deepEqual(await sent(page), [], 'must not answer an offer from 2 hours ago');

  await add(page, offer('UF-6212077119'));
  await waitSent(page, 1);
  assert.deepEqual(await sent(page), ['lmc -d']);

  await add(page, '$2460');
  await add(page, 'Hi, do you have trucks available today?');
  await sleep(QUIET_MS);
  assert.equal((await sent(page)).length, 1, 'price follow-up and chit-chat are not offers');

  await add(page, offer('UF-6212077120', 'Joliet, IL → Atlanta, GA'));
  await waitSent(page, 2, 30000); // per-chat cooldown is 20 s
  assert.deepEqual(await sent(page), ['lmc -d', 'lmc -d']);

  await add(page, offer('UF-6212077121', 'Gary, IN → Memphis, TN'), { own: true });
  await sleep(QUIET_MS);
  assert.equal((await sent(page)).length, 2, 'own messages are never answered');

  const log = await readLog();
  assert.equal(log.filter((e) => e.action === 'replied').length, 2);
  assert.ok(log.some((e) => e.action === 'skip-old' && e.loadId === 'UF-1111111111'));
  await page.close();
});

test('works without timestamps and sender ids, sending with Enter', async () => {
  const page = await openChat('?ts=0&button=0');
  await sleep(QUIET_MS);
  assert.deepEqual(await sent(page), [], 'history that was already on screen is old');

  await add(page, offer('UF-3333333333'));
  await waitSent(page, 1);
  await sleep(QUIET_MS);
  assert.deepEqual(await sent(page), ['lmc -d'], 'exactly one reply');
  await page.close();
});

test('does not touch a half-typed message, replies once the field is empty', async () => {
  const page = await openChat('?old=0');
  await page.evaluate(() => (document.getElementById('composer').textContent = 'hello'));
  await add(page, offer('UF-4444444444'));
  await sleep(QUIET_MS);
  assert.deepEqual(await sent(page), []);
  assert.equal(await page.evaluate(() => document.getElementById('composer').textContent), 'hello');

  await page.evaluate(() => (document.getElementById('composer').textContent = ''));
  await waitSent(page, 1);
  assert.deepEqual(await sent(page), ['lmc -d']);
  await page.close();
});

test('custom reply text', async () => {
  await setSettings({ replyText: 'lmc -Denis' });
  try {
    const page = await openChat('?old=0');
    await add(page, offer('UF-7777777777'));
    await waitSent(page, 1);
    assert.deepEqual(await sent(page), ['lmc -Denis']);
    await page.close();
  } finally {
    await setSettings({ replyText: 'lmc -d' });
  }
});

test('test mode highlights the offer and sends nothing', async () => {
  await setSettings({ testMode: true });
  try {
    const page = await openChat('?old=0');
    await add(page, offer('UF-5555555555'));
    await sleep(QUIET_MS);
    assert.deepEqual(await sent(page), []);
    const outline = await page.evaluate(() => [...document.querySelectorAll('.DTp27d')].pop().style.outline);
    assert.match(outline, /solid/);
    assert.ok((await readLog()).some((e) => e.action === 'test' && e.loadId === 'UF-5555555555'));
    await page.close();
  } finally {
    await setSettings({ testMode: false });
  }
});

test('switched off: no replies', async () => {
  await setSettings({ enabled: false });
  try {
    const page = await openChat('?old=0');
    await add(page, offer('UF-8888888888'));
    await sleep(QUIET_MS);
    assert.deepEqual(await sent(page), []);
    await page.close();
  } finally {
    await setSettings({ enabled: true });
  }
});

test('chat open in two tabs: still one reply', async () => {
  const a = await openChat('?old=0');
  const b = await openChat('?old=0');
  await Promise.all([add(a, offer('UF-6666666666')), add(b, offer('UF-6666666666'))]);
  await sleep(QUIET_MS + 1000);
  const total = (await sent(a)).length + (await sent(b)).length;
  assert.equal(total, 1);
  await a.close();
  await b.close();
});
