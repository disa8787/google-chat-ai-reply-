/*
 * Runs inside Google Chat (chat.google.com, mail.google.com/chat and the Chat
 * frames embedded in Gmail). Watches the open conversation; when the latest
 * incoming messages are a load offer, sends the reply text ("lmc -d").
 */
(() => {
  'use strict';
  if (window.__lmcReplyBot) return;
  window.__lmcReplyBot = true;

  const Detector = globalThis.LoadOfferDetector;

  const DEFAULTS = {
    enabled: true,
    replyText: 'lmc -d',
    testMode: false,
    maxAgeMinutes: 15,
    autoOpenUnread: false,
  };

  // Google Chat markup. Class names come from Google's compiled CSS and have
  // been stable for years, but every lookup has a fallback.
  const SEL = {
    group: 'div.nF6pT',
    text: 'div[jsname="bgckF"], div.DTp27d, div.GDhqjd, div.vdlEi',
    timestamp: '[data-absolute-timestamp]',
    member: '[data-member-id], [data-hovercard-id]',
    composer: 'div[contenteditable="true"]',
    title: ['header[aria-label]', '[role="main"][aria-label]', 'span.mUIrbf-vQzf8d', 'div.nfJ0Zd', 'h1'],
  };

  const TAIL_LIMIT = 8; // how many latest messages to look at
  const CONVERSATION_COOLDOWN_MS = 20000;
  const SEND_DELAY_MS = 700;

  let settings = { ...DEFAULTS };
  let ownIds = new Set();
  let busy = false;
  let scanTimer = null;
  let lastConvKey = null;
  let lastUserInputAt = 0;
  const seenAt = new WeakMap(); // message element -> first time we saw it (0 = was already on screen)
  const handled = new Set(); // conversation|fingerprint we already dealt with
  const lastReplyAt = new Map(); // conversation -> time of our last reply
  const logged = new Set();

  // ---------------------------------------------------------------- helpers

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => Detector.normalize(s).toLowerCase();

  function isVisible(el) {
    return !!el && el.isConnected && el.getClientRects().length > 0;
  }

  function send(message) {
    try {
      return chrome.runtime.sendMessage(message).catch(() => null);
    } catch (e) {
      return Promise.resolve(null); // extension was reloaded; this copy is orphaned
    }
  }

  function log(action, details) {
    const entry = { time: Date.now(), action, ...details };
    console.info('[lmc-bot]', action, details);
    send({ type: 'log', entry });
  }

  function logOnce(key, action, details) {
    if (logged.has(key)) return;
    logged.add(key);
    log(action, details);
  }

  // data-absolute-timestamp may be in seconds, ms or µs.
  function toMs(value) {
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) return 0;
    if (v > 1e14) return v / 1000;
    if (v > 1e11) return v;
    if (v > 1e8) return v * 1000;
    return 0;
  }

  // ------------------------------------------------------------ conversation

  function conversationTitle() {
    for (const sel of SEL.title) {
      for (const el of document.querySelectorAll(sel)) {
        if (!isVisible(el)) continue;
        const text = Detector.normalize(el.getAttribute('aria-label') || el.textContent);
        if (text && text.length < 120) return text;
      }
    }
    return '';
  }

  function conversationKey() {
    return conversationTitle() || location.pathname + location.hash;
  }

  function getComposer() {
    const candidates = [...document.querySelectorAll(SEL.composer)].filter(
      (el) =>
        isVisible(el) &&
        !el.hasAttribute('g_editable') && // Gmail e-mail compose body
        !el.parentElement?.closest('[contenteditable="true"]')
    );
    if (!candidates.length) return null;
    // The main composer is the lowest one on screen.
    return candidates.reduce((a, b) => (b.getBoundingClientRect().bottom >= a.getBoundingClientRect().bottom ? b : a));
  }

  function composerText(el) {
    return Detector.normalize(el.innerText || el.textContent || '');
  }

  function scrollContainer(el) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const style = getComputedStyle(p);
      if (/(auto|scroll)/.test(style.overflowY) && p.clientWidth > 150) return p;
    }
    return document.querySelector('[role="main"]') || document.body;
  }

  // Own messages are drawn as right-aligned bubbles: lots of free space on the
  // left of the text and little on the right.
  function isRightAligned(el) {
    const box = scrollContainer(el).getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(el);
    const text = range.getBoundingClientRect();
    if (!text.width || !box.width) return false;
    const leftGap = text.left - box.left;
    const rightGap = box.right - text.right;
    return leftGap > 80 && leftGap > rightGap * 2;
  }

  function memberIdIn(node) {
    const m = node.querySelector(SEL.member);
    return m ? m.getAttribute('data-member-id') || m.getAttribute('data-hovercard-id') || '' : '';
  }

  function timestampIn(node) {
    const t = node.querySelector(SEL.timestamp);
    return t ? toMs(t.getAttribute('data-absolute-timestamp')) : 0;
  }

  // Chat draws the sender name and time only on the first message of a run;
  // later messages of the same run inherit them from the rows above.
  function messageMeta(el) {
    const row = el.closest(SEL.group);
    if (!row) return { sender: '', ts: 0, inheritedTs: 0 };
    let sender = memberIdIn(row);
    const ts = timestampIn(row);
    let inheritedTs = ts;
    let prev = row.previousElementSibling;
    for (let i = 0; i < 30 && prev && (!sender || !inheritedTs); i++, prev = prev.previousElementSibling) {
      if (!sender) sender = memberIdIn(prev);
      if (!inheritedTs) inheritedTs = timestampIn(prev);
    }
    return { sender, ts, inheritedTs };
  }

  /** Latest visible messages, oldest first. */
  function latestMessages() {
    const all = document.querySelectorAll(SEL.text);
    const out = [];
    for (let i = all.length - 1; i >= 0 && out.length < TAIL_LIMIT; i--) {
      const el = all[i];
      if (el.parentElement?.closest(SEL.text)) continue; // nested match
      if (!isVisible(el)) continue; // e.g. cached hidden conversation
      const text = Detector.normalize(el.innerText || el.textContent);
      if (!text) continue;
      out.push({ el, text, ...messageMeta(el) });
    }
    return out.reverse();
  }

  function isOwn(msg) {
    if (msg.sender && ownIds.has(msg.sender)) return true;
    if (norm(msg.text) === norm(settings.replyText)) return true;
    return isRightAligned(msg.el);
  }

  /** Incoming messages after our last message. */
  function incomingTail(messages) {
    const tail = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isOwn(messages[i])) break;
      tail.unshift(messages[i]);
    }
    return tail;
  }

  // ------------------------------------------------------------------ reply

  function sendButtonNear(composer) {
    const re = /^(send|отправ|enviar|envoyer|senden|invia|wyślij|надіслати)/i;
    const skip = /(schedul|later|запланир|позже|option|параметр|more|ещё)/i;
    let node = composer;
    for (let depth = 0; depth < 8 && node; depth++, node = node.parentElement) {
      for (const b of node.querySelectorAll('button, [role="button"]')) {
        const label = b.getAttribute('aria-label') || b.getAttribute('data-tooltip') || b.title || '';
        if (re.test(label.trim()) && !skip.test(label) && isVisible(b)) return b;
      }
    }
    return null;
  }

  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(
        new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })
      );
    }
  }

  async function typeAndSend(composer, text) {
    const previousFocus = document.activeElement;
    composer.focus();
    const sel = window.getSelection();
    sel.selectAllChildren(composer);
    sel.collapseToEnd();
    document.execCommand('insertText', false, text);
    if (!composerText(composer).includes(text)) {
      composer.textContent = text;
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    await sleep(250);

    const button = sendButtonNear(composer);
    if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') button.click();
    else pressEnter(composer);

    for (let i = 0; i < 10 && composerText(composer); i++) {
      await sleep(200);
      if (i === 4) pressEnter(composer); // button did not work, try Enter
    }

    if (previousFocus && previousFocus !== composer && previousFocus.isConnected && previousFocus.focus) {
      previousFocus.focus({ preventScroll: true });
    }
    return !composerText(composer);
  }

  // Remember which member id is "us" once our reply shows up in the chat.
  async function learnOwnId(text, otherSenders) {
    await sleep(1500);
    const mine = latestMessages().filter((m) => norm(m.text) === norm(text) && m.sender);
    const id = mine.length && mine[mine.length - 1].sender;
    if (id && !ownIds.has(id) && !otherSenders.includes(id)) {
      ownIds.add(id);
      send({ type: 'ownId', id });
    }
  }

  function highlight(messages) {
    for (const m of messages) {
      m.el.style.outline = '2px solid #f9ab00';
      m.el.style.outlineOffset = '2px';
    }
  }

  // ------------------------------------------------------------------- scan

  function isFresh(msg, now) {
    const maxAge = settings.maxAgeMinutes * 60000;
    if (msg.ts) return now - msg.ts <= maxAge;
    if (msg.inheritedTs && now - msg.inheritedTs <= maxAge) return true;
    return seenAt.get(msg.el) > 0;
  }

  // After the extension is switched off, reloaded or removed, this copy of the
  // script stays in the page but must not act any more.
  function extensionAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  async function scan() {
    if (!extensionAlive()) return stop();
    if (busy || !settings.enabled || !Detector) return;
    const messages = latestMessages();
    if (!messages.length) return;
    const composer = getComposer();
    if (!composer) return;

    const conv = conversationKey();
    const now = Date.now();

    // Messages that were already on screen when the conversation opened are
    // "old"; ones that appeared later are new. Only used when a message has no
    // timestamp of its own.
    const newcomers = messages.filter((m) => !seenAt.has(m.el));
    const baseline = conv !== lastConvKey || newcomers.length > 3;
    lastConvKey = conv;
    for (const m of newcomers) seenAt.set(m.el, baseline ? 0 : now);

    const tail = incomingTail(messages);
    if (!tail.length) return;

    // The newest offer: the shortest run of latest messages that reads as an
    // offer (an offer may be split into several messages, e.g. price last).
    let result = null;
    let offer = [];
    for (let k = tail.length - 1; k >= 0 && !result; k--) {
      const r = Detector.analyze(tail.slice(k).map((m) => m.text).join('\n'));
      if (r.isOffer) [result, offer] = [r, tail.slice(k)];
    }
    if (!result) return;

    const key = `${conv}|${result.fingerprint}`;
    if (handled.has(key)) return;

    if (!isFresh(tail[tail.length - 1], now)) {
      handled.add(key);
      logOnce(key, 'skip-old', { conversation: conv, route: result.route, loadId: result.loadId });
      return;
    }

    if (composerText(composer)) {
      logOnce(`${key}|typing`, 'wait-typing', { conversation: conv, route: result.route, loadId: result.loadId });
      return; // the user is typing here — try again on the next scan
    }
    if (now - (lastReplyAt.get(conv) || 0) < CONVERSATION_COOLDOWN_MS) return;

    busy = true;
    try {
      handled.add(key);
      const details = {
        conversation: conv,
        route: result.route,
        loadId: result.loadId,
        score: result.score,
        signals: result.signals.join(', '),
      };

      if (settings.testMode) {
        highlight(offer);
        log('test', details);
        return;
      }

      const claim = await send({ type: 'claim', key });
      if (claim && claim.ok === false) return; // another tab/frame already answered

      await sleep(SEND_DELAY_MS);
      const reply = settings.replyText;
      const ok = await typeAndSend(composer, reply);
      lastReplyAt.set(conv, Date.now());
      log(ok ? 'replied' : 'send-failed', { ...details, reply });
      if (ok) learnOwnId(reply, tail.map((m) => m.sender).filter(Boolean));
    } finally {
      busy = false;
    }
  }

  function scheduleScan(delay = 600) {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan().catch((e) => console.warn('[lmc-bot] scan failed', e));
    }, delay);
  }

  // -------------------------------------------- open unread DMs (optional)

  let lastOpenAt = 0;
  const openedAt = new Map();

  function openUnreadConversation() {
    if (!extensionAlive()) return stop();
    const now = Date.now();
    if (!settings.enabled || !settings.autoOpenUnread || busy) return;
    if (now - lastOpenAt < 15000 || now - lastUserInputAt < 60000) return;

    const unreadRe = /\bunread\b|непрочитан/i;
    for (const link of document.querySelectorAll('a[href*="/dm/"], a[href*="dm/"]')) {
      const item = link.closest('[role="treeitem"], [role="listitem"], [role="option"]') || link;
      if (!isVisible(item)) continue;
      if (item.getAttribute('aria-selected') === 'true' || link.getAttribute('aria-current')) continue;
      const labels = [item, ...item.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label') || '').join(' ');
      if (!unreadRe.test(labels)) continue;
      if (now - (openedAt.get(link.href) || 0) < 120000) continue;
      openedAt.set(link.href, now);
      lastOpenAt = now;
      log('open-unread', { conversation: Detector.normalize(link.getAttribute('aria-label') || link.textContent).slice(0, 80) });
      link.click();
      return;
    }
  }

  // ------------------------------------------------------------------ start

  function applySettings(stored) {
    settings = { ...DEFAULTS, ...(stored || {}) };
    if (!String(settings.replyText || '').trim()) settings.replyText = DEFAULTS.replyText;
  }

  async function start() {
    try {
      const data = await chrome.storage.local.get(['settings', 'ownIds']);
      applySettings(data.settings);
      ownIds = new Set(data.ownIds || []);
    } catch (e) {
      applySettings();
    }

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.settings) applySettings(changes.settings.newValue);
      if (changes.ownIds) ownIds = new Set(changes.ownIds.newValue || []);
    });

    for (const type of ['keydown', 'mousedown']) {
      document.addEventListener(type, (e) => e.isTrusted && (lastUserInputAt = Date.now()), true);
    }

    observer = new MutationObserver(() => scheduleScan());
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    interval = setInterval(() => {
      scheduleScan(0);
      openUnreadConversation();
    }, 4000);
    scheduleScan(0);
  }

  let observer = null;
  let interval = null;

  function stop() {
    if (observer) observer.disconnect();
    clearInterval(interval);
    clearTimeout(scanTimer);
  }

  start();
})();
