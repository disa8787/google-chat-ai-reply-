/*
 * Shared state for all Chat tabs and frames:
 *  - "claim": makes sure one load offer gets exactly one reply even if Chat is
 *    open in several tabs;
 *  - activity log shown in the popup;
 *  - learned member ids of the account owner.
 */
'use strict';

const HANDLED_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const HANDLED_MAX = 1000;
const LOG_MAX = 50;

// Storage updates are read-modify-write; run them one at a time.
let queue = Promise.resolve();
function serial(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

async function claim(key) {
  const { handled = {} } = await chrome.storage.local.get('handled');
  const now = Date.now();
  if (handled[key] && now - handled[key] < HANDLED_TTL_MS) return { ok: false };

  handled[key] = now;
  const entries = Object.entries(handled)
    .filter(([, t]) => now - t < HANDLED_TTL_MS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, HANDLED_MAX);
  await chrome.storage.local.set({ handled: Object.fromEntries(entries) });
  return { ok: true };
}

async function addLog(entry) {
  const { log = [] } = await chrome.storage.local.get('log');
  log.unshift(entry);
  await chrome.storage.local.set({ log: log.slice(0, LOG_MAX) });
}

async function addOwnId(id) {
  const { ownIds = [] } = await chrome.storage.local.get('ownIds');
  if (!ownIds.includes(id)) await chrome.storage.local.set({ ownIds: [...ownIds, id].slice(-10) });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'claim') {
    serial(() => claim(msg.key)).then(sendResponse, () => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'log') serial(() => addLog(msg.entry));
  if (msg.type === 'ownId' && msg.id) serial(() => addOwnId(msg.id));
  return false;
});
