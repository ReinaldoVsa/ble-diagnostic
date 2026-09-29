/**
 * ui.js — Utilitários de interface: renderização, sanitização, toasts,
 * modais, badges e log visual. Nenhuma lógica de negócio aqui.
 *
 * Segurança: TODO texto dinâmico exibido no DOM passa por esc() para evitar
 * injeção de HTML/XSS. Nunca use innerHTML com dados não sanitizados.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Escapa texto para exibição segura no DOM (sanitização). */
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Cria um elemento com classes e conteúdo seguro. */
function el(tag, className, textContent = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent !== null) node.textContent = textContent;
  return node;
}

/** Notificação flutuante curta. type: ok | warn | err | info */
function toast(message, type = 'info', duration = 3500) {
  const box = $('#toast-container');
  const t = el('div', `toast ${type === 'info' ? '' : type}`, message);
  box.appendChild(t);
  setTimeout(() => t.remove(), duration);
}

/** Modal de confirmação. Retorna Promise<boolean>. */
function confirmModal(title, message, confirmLabel = 'Confirmar', danger = false) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    const backdrop = el('div', 'modal-backdrop');
    const modal = el('div', 'modal');

    const h = el('h3', null, title);
    const p = el('p', null, message);
    const row = el('div', 'row-btns');

    const btnNo = el('button', 'btn btn-ghost', 'Cancelar');
    const btnYes = el('button', `btn ${danger ? 'btn-danger' : 'btn-primary'}`, confirmLabel);
    btnYes.style.marginLeft = 'auto';

    row.append(btnNo, btnYes);
    modal.append(h, p, row);
    backdrop.appendChild(modal);
    root.appendChild(backdrop);

    const close = (result) => { backdrop.remove(); resolve(result); };
    btnNo.addEventListener('click', () => close(false));
    btnYes.addEventListener('click', () => close(true));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(false); });
  });
}

/** Badge visual (ex.: READ, NOTIFY, DEMO). type: on | blue | warn | err | demo */
function badge(label, type = '') {
  return `<span class="badge ${type}">${esc(label)}</span>`;
}

/** Formata timestamp ISO local: YYYY-MM-DD HH:MM:SS */
function localTimestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
         `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/** Formata hora local curta: HH:MM:SS */
function localTime(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/** Renderiza uma lista de pares chave/valor <dl class="kv">. */
function kvRows(pairs) {
  const rows = pairs.map(([k, v]) =>
    `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  return `<dl class="kv">${rows}</dl>`;
}

/* ============ Log técnico visual (console opcional) ============ */

const Log = {
  entries: [],

  add(message) {
    const time = localTime();
    Log.entries.push({ time, message });
    if (Log.entries.length > 500) Log.entries.shift();
    Log.render();
  },

  render() {
    const list = $('#log-list');
    if (!list) return;
    list.innerHTML = Log.entries.map((e) =>
      `<div><span class="log-time">[${esc(e.time)}]</span> ${esc(e.message)}</div>`
    ).join('');
    list.scrollTop = list.scrollHeight;
  },

  clear() { Log.entries = []; Log.render(); },

  asText() {
    return Log.entries.map((e) => `[${e.time}] ${e.message}`).join('\n');
  },

  toggle(open) {
    const panel = $('#log-panel');
    if (open === undefined) open = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !open);
  }
};

export { $, $$, esc, el, toast, confirmModal, badge, kvRows, localTimestamp, localTime, Log };
