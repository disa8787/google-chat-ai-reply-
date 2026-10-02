'use strict';

const DEFAULTS = {
  enabled: true,
  replyText: 'lmc -d',
  testMode: false,
  maxAgeMinutes: 15,
  autoOpenUnread: false,
};

const ACTIONS = {
  replied: 'Ответил',
  test: 'Тест: нашёл груз (не отправлял)',
  'send-failed': 'Не смог отправить',
  'skip-old': 'Пропустил старое предложение',
  'wait-typing': 'Жду: в поле ввода уже есть текст',
  'open-unread': 'Открыл непрочитанный чат',
};

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULTS };

function renderStatus() {
  const el = $('status');
  if (!settings.enabled) {
    el.textContent = 'Выключено';
    el.className = 'status off';
  } else if (settings.testMode) {
    el.textContent = 'Тестовый режим: ответы не отправляются';
    el.className = 'status test';
  } else {
    el.textContent = `Работает: отвечаю «${settings.replyText}» на предложения грузов`;
    el.className = 'status on';
  }
}

async function save(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.local.set({ settings });
  renderStatus();
}

function renderLog(log) {
  const list = $('log');
  list.textContent = '';
  if (!log.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Пока ничего. Откройте Google Chat и оставьте вкладку открытой.';
    list.append(li);
    return;
  }
  for (const e of log) {
    const li = document.createElement('li');
    const title = document.createElement('div');
    title.textContent = `${ACTIONS[e.action] || e.action}${e.route ? ': ' + e.route : ''}${e.loadId ? ' (' + e.loadId + ')' : ''}`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = [new Date(e.time).toLocaleString(), e.conversation].filter(Boolean).join(' · ');
    li.append(title, meta);
    list.append(li);
  }
}

function renderVerdict() {
  const text = $('sample').value;
  const out = $('verdict');
  out.textContent = '';
  if (!text.trim()) return;
  const r = LoadOfferDetector.analyze(text);
  const head = document.createElement('span');
  head.className = r.isOffer ? 'yes' : 'no';
  head.textContent = r.isOffer ? 'Это предложение груза ✔' : 'Не похоже на груз';
  out.append(head, ` — баллы: ${r.score}${r.signals.length ? ' (' + r.signals.join(', ') + ')' : ''}`);
}

async function init() {
  const data = await chrome.storage.local.get(['settings', 'log']);
  settings = { ...DEFAULTS, ...(data.settings || {}) };

  $('enabled').checked = settings.enabled;
  $('replyText').value = settings.replyText;
  $('maxAgeMinutes').value = settings.maxAgeMinutes;
  $('testMode').checked = settings.testMode;
  $('autoOpenUnread').checked = settings.autoOpenUnread;
  renderStatus();
  renderLog(data.log || []);

  for (const id of ['enabled', 'testMode', 'autoOpenUnread']) {
    $(id).addEventListener('change', (e) => save({ [id]: e.target.checked }));
  }
  $('replyText').addEventListener('change', (e) => {
    const value = e.target.value.trim() || DEFAULTS.replyText;
    e.target.value = value;
    save({ replyText: value });
  });
  $('maxAgeMinutes').addEventListener('change', (e) => {
    const value = Math.min(1440, Math.max(1, parseInt(e.target.value, 10) || DEFAULTS.maxAgeMinutes));
    e.target.value = value;
    save({ maxAgeMinutes: value });
  });
  $('sample').addEventListener('input', renderVerdict);
  $('clearLog').addEventListener('click', () => chrome.storage.local.set({ log: [] }));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.log) renderLog(changes.log.newValue || []);
  });
}

init();
