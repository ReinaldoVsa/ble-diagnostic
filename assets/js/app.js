/**
 * app.js — Inicialização, roteamento e eventos do BLE Diagnostic Scanner.
 *
 * Este módulo coordena as camadas:
 *   ble.js      → scanner, conexão, desconexão
 *   gatt.js     → serviços, características, read, notify
 *   demo.js     → modo demonstração (dados DEMO, sempre identificados)
 *   storage.js  → IndexedDB (inventário e histórico), preferências
 *   export.js   → JSON, relatórios e downloads
 *   ui.js       → renderização, sanitização, toasts, modais, log
 */

import { BleClient, friendlyError, isWebBluetoothSupported,
         isSecureContext, getBluetoothAvailability, normalizeOptionalServiceUuid } from './ble.js';
import { discoverServices, getCharacteristics, readCharacteristic,
         startNotifications, writeDiagnostic, getDescriptors, readDescriptor } from './gatt.js';
import { demoDevices, connectDemo, DEMO_UUIDS } from './demo.js';
import { Storage } from './storage.js';
import { buildJsonReport, buildTextReport, download } from './export.js';
import { $, $$, esc, el, toast, confirmModal, badge, kvRows,
         localTimestamp, Log } from './ui.js';

const APP_VERSION = '1.2.0';

/* ================= Estado da sessão ================= */

const state = {
  found: [],              // dispositivos encontrados nesta sessão
  filter: 'all',
  sort: 'signal',
  selected: null,         // registro do dispositivo em foco
  nativeDevice: null,     // objeto navigator.bluetooth (ou DEMO)
  server: null,           // servidor GATT conectado
  connected: false,
  connectionError: null,
  stopWatchAds: null,     // função para parar watchAdvertisements
  stopNotifiers: [],     // funções para cancelar notificações ativas
  services: [],           // serviços descobertos
  notifications: [],     // eventos do monitor
  monitorPaused: false,
  scanBusy: false,
  reconnectAttempts: 0
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ble = new BleClient((msg) => Log.add(msg));

let stopPassiveScanFn = null; // função para encerrar a varredura passiva

let settings = Storage.getSettings();

/* ================= Utilidades ================= */

const NA = 'Não disponibilizado pelo sistema';

/** UUIDs padrão com nome conhecido (apenas para legibilidade). */
const KNOWN_UUID_NAMES = {
  [DEMO_UUIDS.batteryService]: 'Battery Service',
  [DEMO_UUIDS.batteryLevel]: 'Battery Level',
  [DEMO_UUIDS.deviceInfo]: 'Device Information',
  [DEMO_UUIDS.manufacturerName]: 'Manufacturer Name String',
  [DEMO_UUIDS.modelNumber]: 'Model Number String'
};

/** Exibe UUID sem alterá-lo; nomes conhecidos são apenas aditivos. */
function uuidLabel(uuid) {
  if (!uuid) return esc(NA);
  const known = KNOWN_UUID_NAMES[uuid];
  return esc(uuid) + (known ? ` <span class="badge blue">${esc(known)}</span>` : '');
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} copiado.`, 'ok', 2000);
  } catch {
    toast('Não foi possível copiar (permissão negada pelo navegador).', 'err');
  }
}

function optionalServicesFromSettings() {
  // Serviços padrão do Bluetooth SIG sempre autorizados + lista do técnico.
  const defaults = [DEMO_UUIDS.batteryService, DEMO_UUIDS.deviceInfo];
  const extra = String(settings.optionalServices || '')
    .split(/[\s,;]+/)
    .map((s) => normalizeOptionalServiceUuid(s))
    .filter(Boolean);
  return [...defaults, ...extra];
}

/* ================= Roteamento / navegação ================= */

const SCREENS = ['home', 'scanner', 'devices', 'device', 'gatt', 'monitor',
                 'diagnostic', 'history', 'settings', 'compat', 'permissions', 'privacy'];

function showScreen(name) {
  if (!SCREENS.includes(name)) return;
  SCREENS.forEach((s) => $('#screen-' + s)?.classList.toggle('hidden', s !== name));
  $$('.nav-btn[data-screen]').forEach((b) =>
    b.classList.toggle('active', b.dataset.screen === name));
  // Atualizações de tela ao entrar
  if (name === 'home') renderHome();
  if (name === 'scanner') renderScan();
  if (name === 'devices') renderDeviceInventory();
  if (name === 'device') renderDetail();
  if (name === 'gatt') renderGatt();
  if (name === 'monitor') renderMonitor();
  if (name === 'diagnostic') renderDiagnostic();
  if (name === 'history') renderHistory();
  if (name === 'settings') renderSettingsValues();
  if (name === 'compat') renderCompat();
  window.scrollTo({ top: 0 });
}

/* ================= Detecção de capacidades ================= */

async function refreshCapabilities() {
  const bt = $('#st-bt'), wb = $('#st-wb'), https = $('#st-https');

  const availability = await getBluetoothAvailability();
  if (availability === null) {
    bt.textContent = 'Não disponibilizado pelo sistema';
    $('#chip-bt').className = 'chip';
  } else {
    bt.textContent = availability ? 'Disponível' : 'Indisponível';
    $('#chip-bt').className = 'chip ' + (availability ? 'ok' : 'bad');
  }

  const supported = isWebBluetoothSupported();
  wb.textContent = supported ? 'Suportado' : 'Não suportado';
  $('#chip-wb').className = 'chip ' + (supported ? 'ok' : 'bad');

  const secure = isSecureContext();
  https.textContent = secure ? 'Seguro (HTTPS)' : 'HTTPS ausente';
  $('#chip-https').className = 'chip ' + (secure ? 'ok' : 'bad');

  // Aviso contextual do scanner
  const hint = $('#wb-hint');
  const parts = [];
  if (!supported) parts.push('Seu navegador não oferece Web Bluetooth. Utilize um navegador/dispositivo compatível (ex.: Chrome para Android).');
  if (!secure) parts.push('Web Bluetooth exige HTTPS.');
  if (settings.demoMode) parts.push('Modo demonstração ativo: a busca retorna apenas dispositivos DEMO fictícios.');
  if (supported && secure && !settings.demoMode && typeof navigator.bluetooth?.requestLEScan === 'function') {
    parts.push('Este navegador oferece varredura passiva experimental: "Iniciar busca" também a ativa automaticamente.');
  }
  hint.textContent = parts.join(' ');
  hint.className = 'notice ' + (parts.length ? (supported && secure ? '' : 'notice-warn') : 'hidden');
}

/* ================= Dashboard ================= */

function renderHome() {
  $('#stat-found').textContent = state.found.length;
  const connectedName = state.connected && state.selected
    ? (state.selected.name || 'Sem nome') : '—';
  $('#stat-connected').textContent = connectedName;
  $('#stat-services').textContent = state.services.length;
  const chars = state.services.reduce((a, s) => a + (s.characteristics?.length ?? 0), 0);
  $('#stat-chars').textContent = chars;
  $('#stat-lastdiag').textContent = state.lastDiagAt ? localTimestamp(state.lastDiagAt) : '—';
}

/* ================= Compatibilidade do navegador ================= */

/** Matriz de recursos BLE nativos realmente suportados (nada é presumido). */
function renderCompat() {
  const box = $('#compat-matrix');
  const proto = (name, method) =>
    typeof window[name] === 'function' && method in window[name].prototype;

  const rows = [
    ['Contexto seguro (HTTPS)', isSecureContext()],
    ['Web Bluetooth (requestDevice)', typeof navigator.bluetooth?.requestDevice === 'function'],
    ['Disponibilidade do adaptador (getAvailability)', typeof navigator.bluetooth?.getAvailability === 'function'],
    ['Dispositivos conhecidos (getDevices)', typeof navigator.bluetooth?.getDevices === 'function'],
    ['Esquecer permissão (forget)', proto('BluetoothDevice', 'forget')],
    ['Varredura passiva (requestLEScan)', typeof navigator.bluetooth?.requestLEScan === 'function'],
    ['Monitorar anúncios (watchAdvertisements)', proto('BluetoothDevice', 'watchAdvertisements')],
    ['Descritores GATT (getDescriptors)', proto('BluetoothRemoteGATTCharacteristic', 'getDescriptors')],
    ['Service Worker (PWA offline)', 'serviceWorker' in navigator],
    ['IndexedDB (histórico local)', !!window.indexedDB],
    ['Clipboard (copiar HEX/UUID)', !!navigator.clipboard]
  ];

  box.innerHTML = rows.map(([name, ok]) => `
    <div class="check-item ${ok ? 'state-ok' : 'state-warn'}">
      <span class="ico">${ok ? '✓' : '✗'}</span> ${esc(name)}
      ${ok ? '' : '<span class="badge warn">não suportado</span>'}
    </div>`).join('');
}

/* ================= Scanner ================= */

async function startScan() {
  if (state.scanBusy) return;

  // Modo demonstração: apenas dispositivos DEMO, jamais reais.
  if (settings.demoMode) {
    state.found = [...state.found.filter((d) => d.isDemo), ...demoDevices()
      .map((d) => ({ ...d, discoveredAt: new Date().toISOString() }))];
    Log.add('Busca DEMO iniciada (dados fictícios)');
    toast('Dispositivos DEMO carregados. Eles não são dispositivos reais.', 'warn', 5000);
    renderScan();
    return;
  }

  if (!isWebBluetoothSupported() || !isSecureContext()) {
    try { ble.assertReady(); } catch (err) {
      toast(err.message, 'err', 6000);
      Log.add(`Scanner bloqueado: ${err.message}`);
      return;
    }
  }

  state.scanBusy = true;
  $('#btn-scan').disabled = true;
  $('#btn-scan-home').disabled = true;
  $('#scan-status').textContent = 'Procurando dispositivos BLE... (o navegador abrirá um seletor de dispositivos)';
  Log.add('Scanner iniciado');

  // Fallback/enriquecimento automático: quando o navegador oferece varredura
  // passiva, ela é ativada na mesma busca (anúncios reais com RSSI).
  if (isWebBluetoothSupported() && typeof navigator.bluetooth?.requestLEScan === 'function' && !stopPassiveScanFn) {
    togglePassiveScan(); // sem await: preserva o gesto do usuário para o seletor
  }

  try {
    const native = await ble.requestDevice(optionalServicesFromSettings());
    const record = addFoundDevice(native);
    state.selected = record;
    // Enriquecimento com anúncios, quando o navegador oferecer (experimental):
    state.stopWatchAds?.();
    state.stopWatchAds = await ble.watchAdvertisements(native, (adv) => {
      Object.assign(record, {
        rssi: adv.rssi ?? record.rssi,
        txPower: adv.txPower ?? record.txPower,
        manufacturerData: adv.manufacturerData ?? record.manufacturerData,
        serviceData: adv.serviceData ?? record.serviceData,
        advertisedServices: adv.uuids ?? record.advertisedServices
      });
      renderScan();
    });
    showScreen('device');
  } catch (err) {
    const e = friendlyError(err);
    Log.add(`Scanner: ${e.message}`);
    toast(e.message, e.code === 'USER_CANCEL' ? 'info' : 'err', 5000);
  } finally {
    state.scanBusy = false;
    $('#btn-scan').disabled = false;
    $('#btn-scan-home').disabled = false;
    $('#scan-status').textContent = stopPassiveScanFn
      ? 'Varredura passiva ativa (experimental)... dispositivos aparecem na lista abaixo.'
      : '';
  }
}

/* ------- Dispositivos conhecidos (getDevices) e varredura passiva (requestLEScan) ------- */

/** Lista dispositivos com permissão já concedida pelo navegador. */
async function loadKnownDevices() {
  if (settings.demoMode) {
    toast('Dispositivos conhecidos estão indisponíveis no modo demonstração.', 'warn');
    return;
  }
  const listEl = $('#known-list');
  try {
    const devices = await ble.getKnownDevices();
    if (devices === null) {
      listEl.innerHTML = '';
      toast('Dispositivos conhecidos: Não disponibilizado pelo sistema.', 'warn', 5000);
      return;
    }
    if (!devices.length) {
      listEl.innerHTML = '<div class="empty">Nenhum dispositivo com permissão já concedida.</div>';
      return;
    }
    listEl.innerHTML = '<p class="hint">Dispositivos com permissão já concedida — toque para abrir os detalhes:</p>' +
      devices.map((dev) => `
        <div class="device-card" data-known="${esc(dev.id || '')}">
          <div class="d-name">${esc(dev.name || '(sem nome)')}</div>
          <div class="d-meta"><span>${esc(dev.id ? `ID: ${dev.id}` : `ID: ${NA}`)}</span></div>
          <div class="d-state ${state.connected && state.selected?.id === dev.id ? 'state-ok' : ''}">
            Status: ${state.connected && state.selected?.id === dev.id ? '● Conectado' : 'Disponível'}
          </div>
        </div>`).join('');
    $$('[data-known]', listEl).forEach((card) =>
      card.addEventListener('click', () => {
        const native = devices.find((dvv) => String(dvv.id) === card.dataset.known);
        if (!native) return;
        const rec = addFoundDevice(native);
        state.selected = rec;
        showScreen('device');
      }));
  } catch (err) {
    const e = friendlyError(err);
    Log.add(`Dispositivos conhecidos: ${e.message}`);
    toast(e.message, 'err', 5000);
  }
}

/** Liga/desliga a varredura passiva experimental, quando o navegador oferece. */
async function togglePassiveScan() {
  const btn = $('#btn-passive');
  if (stopPassiveScanFn) {
    stopPassiveScanFn();
    stopPassiveScanFn = null;
    btn.textContent = '📡 Varredura passiva (experimental)';
    $('#scan-status').textContent = '';
    return;
  }
  if (settings.demoMode) {
    toast('Varredura passiva está indisponível no modo demonstração.', 'warn');
    return;
  }
  try {
    const stop = await ble.requestPassiveScan(onPassiveAdvertisement);
    if (!stop) {
      toast('Varredura passiva: Não disponibilizado pelo sistema.', 'warn', 5000);
      return;
    }
    stopPassiveScanFn = stop;
    btn.textContent = '⏹ Parar varredura passiva';
    $('#scan-status').textContent = 'Varredura passiva ativa (experimental)... dispositivos aparecem na lista abaixo.';
    toast('Varredura passiva ativa.', 'ok');
  } catch (err) {
    const e = friendlyError(err);
    Log.add(`Varredura passiva: ${e.message}`);
    toast(e.message, 'err', 5000);
  }
}

/** Atualiza a lista de dispositivos com um anúncio real recebido. */
function onPassiveAdvertisement(adv) {
  if (!adv.deviceId) return;
  let rec = state.found.find((d) => !d.isDemo && d.id === adv.deviceId);
  if (!rec) {
    rec = {
      key: `real-${adv.deviceId}`,
      name: adv.name || '(sem nome)',
      id: adv.deviceId,
      rssi: adv.rssi,
      txPower: adv.txPower,
      manufacturerData: adv.manufacturerData,
      serviceData: adv.serviceData,
      advertisedServices: adv.uuids,
      discoveredAt: new Date().toISOString(),
      isDemo: false,
      native: adv.device
    };
    state.found.unshift(rec);
    Log.add(`Varredura passiva: dispositivo detectado — ${rec.name}`);
  } else {
    Object.assign(rec, {
      rssi: adv.rssi ?? rec.rssi,
      txPower: adv.txPower ?? rec.txPower,
      manufacturerData: adv.manufacturerData ?? rec.manufacturerData,
      serviceData: adv.serviceData ?? rec.serviceData,
      advertisedServices: adv.uuids ?? rec.advertisedServices,
      discoveredAt: new Date().toISOString()
    });
  }
  renderScan();
}

/** Registra um dispositivo real encontrado (sem inventar dados). */
function addFoundDevice(native) {
  const existing = state.found.find((d) => d.id === native.id && !d.isDemo);
  if (existing) {
    existing.discoveredAt = new Date().toISOString();
    return existing;
  }
  const record = {
    key: `real-${native.id}`,
    name: native.name || '(sem nome)',
    id: native.id || null,          // identificador opaco do navegador (não é MAC)
    rssi: null,                    // Web Bluetooth não fornece no seletor
    txPower: null,
    manufacturerData: null,
    serviceData: null,
    advertisedServices: null,
    discoveredAt: new Date().toISOString(),
    isDemo: false,
    native
  };
  state.found.unshift(record);
  return record;
}

function filteredAndSorted() {
  let list = state.found.slice();

  // Separação rigorosa: dados DEMO e reais nunca aparecem juntos.
  list = settings.demoMode
    ? list.filter((d) => d.isDemo)
    : list.filter((d) => !d.isDemo);

  switch (state.filter) {
    case 'strong': list = list.filter((d) => d.rssi !== null && d.rssi >= -60); break;
    case 'medium': list = list.filter((d) => d.rssi !== null && d.rssi < -60 && d.rssi >= -80); break;
    case 'weak': list = list.filter((d) => d.rssi !== null && d.rssi < -80); break;
    case 'withuuid': list = list.filter((d) => Array.isArray(d.advertisedServices) && d.advertisedServices.length > 0); break;
    case 'nouuid': list = list.filter((d) => !Array.isArray(d.advertisedServices) || d.advertisedServices.length === 0); break;
    default: break;
  }

  const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));
  const bySignal = (a, b) => (b.rssi ?? -Infinity) - (a.rssi ?? -Infinity);
  const byRecent = (a, b) => String(b.discoveredAt).localeCompare(String(a.discoveredAt));

  if (state.sort === 'name') list.sort(byName);
  else if (state.sort === 'recent') list.sort(byRecent);
  else list.sort(bySignal);

  return list;
}

function renderScan() {
  const listEl = $('#scan-list');
  const list = filteredAndSorted();
  if (!list.length) {
    listEl.innerHTML = '<div class="empty">Nenhum dispositivo na lista com este filtro.<br>Toque em "Iniciar busca".</div>';
    return;
  }
  listEl.innerHTML = list.map((d) => `
    <div class="device-card" data-key="${esc(d.key)}">
      <div class="d-name">${esc(d.name)} ${d.isDemo ? badge('DEMO', 'demo') : ''}</div>
      <div class="d-meta">
        <span>RSSI: ${d.rssi !== null && d.rssi !== undefined ? `${d.rssi} dBm` : esc(NA)}</span>
        <span>${esc(d.id ? `ID: ${d.id}` : `ID: ${NA}`)}</span>
      </div>
      <div class="d-state ${state.selected?.key === d.key ? 'state-ok' : ''}">
        Status: ${state.connected && state.selected?.key === d.key ? '● Conectado' : 'Detectado'}
        ${d.manufacturerData ? ` · Fabricante: ${esc(Object.keys(d.manufacturerData).join(', ') || NA)}` : ''}
        ${Array.isArray(d.advertisedServices) && d.advertisedServices.length
          ? ` · ${esc(d.advertisedServices.length)} Service UUID(s)` : ''}
      </div>
    </div>`).join('');
}

/* ================= Detalhes do dispositivo ================= */

function renderDetail() {
  const box = $('#device-detail');
  const d = state.selected;
  $('#detail-subtitle').textContent = d ? (d.name || 'Dispositivo sem nome') : '';
  if (!d) {
    box.innerHTML = '<div class="empty">Nenhum dispositivo selecionado. Use o Scanner.</div>';
    return;
  }
  const demoNote = d.isDemo
    ? '<div class="notice notice-warn">Modo demonstração: este é um dispositivo DEMO com dados fictícios. Ele não corresponde a um equipamento real.</div>'
    : '';

  box.innerHTML = `
    ${demoNote}
    <div class="card">
      ${kvRows([
        ['Nome', d.name ?? NA],
        ['ID disponível', d.id ?? NA],
        ['RSSI', d.rssi != null ? `${d.rssi} dBm` : NA],
        ['Tx Power', d.txPower != null ? `${d.txPower} dBm` : NA],
        ['Manufacturer Data', d.manufacturerData ? JSON.stringify(d.manufacturerData) : NA],
        ['Service Data', d.serviceData && Object.keys(d.serviceData).length ? JSON.stringify(d.serviceData) : NA],
        ['Services anunciados', Array.isArray(d.advertisedServices) && d.advertisedServices.length
          ? d.advertisedServices.join(', ') : (d.advertisedServices === null ? NA : '—')],
        ['Data/hora da descoberta', localTimestamp(new Date(d.discoveredAt))]
      ])}
      <div class="row-btns">
        <button id="btn-gatt-connect" class="btn btn-primary">Conectar via GATT</button>
        <button class="btn btn-ghost" data-screen="scanner">← Voltar ao scanner</button>
        ${d.native && typeof d.native.forget === 'function'
          ? '<button id="btn-forget" class="btn btn-ghost">Esquecer dispositivo</button>' : ''}
      </div>
      <p class="hint">O identificador exibido é o código opaco do navegador. A Web Bluetooth não expõe endereço MAC. RSSI e Tx Power só aparecem quando o navegador fornecer (watchAdvertisements).</p>
    </div>`;
  $('#btn-gatt-connect').addEventListener('click', connectSelected);
  $('#btn-forget')?.addEventListener('click', async () => {
    const ok = await confirmModal('Esquecer dispositivo',
      'Remove a permissão concedida pelo navegador a este dispositivo. Ele só voltará a aparecer após nova autorização.',
      'Esquecer', true);
    if (!ok) return;
    try {
      await ble.forgetDevice(d.native);
      state.found = state.found.filter((r) => r.isDemo || r.id !== d.id);
      if (state.selected === d) state.selected = null;
      toast('Dispositivo esquecido.', 'ok');
      renderScan();
      renderDetail();
    } catch (err) {
      toast(friendlyError(err).message, 'err');
    }
  });
}

/* ================= Conexão GATT ================= */

async function connectSelected() {
  const d = state.selected;
  if (!d) return;
  cleanupConnection();
  state.reconnectAttempts = 0;
  state.connectionError = null;
  setConnectionStatus('Conectando...');
  Log.add('Solicitação GATT');

  try {
    const timeoutMs = Math.max(5, Number(settings.discoverySeconds) || 30) * 1000;
    if (d.isDemo) {
      state.nativeDevice = null;
      state.server = await connectDemo(d);
    } else {
      state.nativeDevice = d.native;
      state.nativeDevice.addEventListener('gattserverdisconnected', onGattDisconnected);
      state.server = await ble.connect(state.nativeDevice, timeoutMs);
    }
    state.connected = true;
    state.services = [];
    Log.add('Conectado');
    toast('Conectado.', 'ok');
    showScreen('gatt');
    renderGatt();
  } catch (err) {
    const e = friendlyError(err);
    state.connectionError = e.message;
    state.connected = false;
    state.server = null;
    Log.add(`Falha na conexão: ${e.message}`);
    setConnectionStatus(`Falha na conexão — ${e.message}`, 'err');
    toast(`Falha na conexão: ${e.message}`, 'err', 6000);
  }
}

const RECONNECT_DELAYS = [2000, 5000, 15000]; // backoff (ms), até 3 tentativas
let userInitiatedDisconnect = false;

async function onGattDisconnected() {
  Log.add('Dispositivo desconectado');
  state.connected = false;
  state.server = null;
  cleanupConnection(true);
  renderGatt();
  renderDiagnostic();

  const canReconnect = settings.reconnect && !userInitiatedDisconnect &&
    state.selected && !state.selected.isDemo && state.nativeDevice;

  if (canReconnect && state.reconnectAttempts < RECONNECT_DELAYS.length) {
    const attempt = ++state.reconnectAttempts;
    const delay = RECONNECT_DELAYS[attempt - 1];
    Log.add(`Reconexão automática em ${delay / 1000}s (tentativa ${attempt}/${RECONNECT_DELAYS.length})`);
    toast(`Conexão perdida. Reconectando automaticamente (${attempt}/${RECONNECT_DELAYS.length})...`, 'warn');
    await sleep(delay);
    // Estado pode ter mudado durante a espera (conexão manual, demo, desconexão desejada).
    if (userInitiatedDisconnect || state.connected || !state.selected || state.selected.isDemo) return;
    try {
      state.server = await ble.connect(state.nativeDevice,
        Math.max(5, Number(settings.discoverySeconds) || 30) * 1000);
      state.connected = true;
      state.nativeDevice.addEventListener('gattserverdisconnected', onGattDisconnected);
      Log.add('Reconectado automaticamente');
      toast('Reconectado automaticamente. Redescobrindo serviços...', 'ok');
      renderGatt();
      await discoverAndRenderServices();
    } catch (err) {
      const e = friendlyError(err);
      state.connectionError = e.message;
      Log.add(`Reconexão automática falhou: ${e.message}`);
      onGattDisconnected(); // nova tentativa (respeita o limite)
    }
    return;
  }

  if (canReconnect) {
    toast('Não foi possível reconectar automaticamente.', 'err');
    Log.add('Reconexão automática esgotada');
  } else if (!userInitiatedDisconnect) {
    toast('Dispositivo desconectado.', 'warn');
  }
}

async function disconnectCurrent() {
  userInitiatedDisconnect = true;
  setTimeout(() => { userInitiatedDisconnect = false; }, 5000);
  if (state.selected?.isDemo) {
    // DEMO: apenas cancela notificações.
    state.stopNotifiers.forEach((stop) => stop());
    state.stopNotifiers = [];
    state.connected = false;
    state.server = null;
    Log.add('Desconectado (DEMO)');
    toast('Disconectado (DEMO).', 'ok');
    renderGatt();
    return;
  }
  state.stopNotifiers.forEach((stop) => { try { stop(); } catch {} });
  state.stopNotifiers = [];
  ble.disconnect(state.nativeDevice); // gera gattserverdisconnected → limpeza
  if (state.nativeDevice && !state.nativeDevice.gatt?.connected) {
    state.connected = false;
    state.server = null;
    renderGatt();
  }
}

function cleanupConnection(keepError = false) {
  state.stopNotifiers.forEach((stop) => { try { stop(); } catch {} });
  state.stopNotifiers = [];
  if (!keepError) state.connectionError = null;
  if (state.nativeDevice?.removeEventListener) {
    state.nativeDevice.removeEventListener('gattserverdisconnected', onGattDisconnected);
  }
}

function setConnectionStatus(text, tone = '') {
  const box = $('#gatt-connection');
  if (!box) return;
  const color = tone === 'err' ? 'state-err'
    : text.startsWith('●') ? 'state-ok' : '';
  box.innerHTML = `<p class="conn-status ${color}">${esc(text)}</p>`;
}

/* ================= GATT: serviços e características ================= */

async function discoverAndRenderServices() {
  if (!state.server) { toast('Conecte-se primeiro.', 'warn'); return; }
  Log.add('Descobrindo serviços');
  try {
    state.services = await discoverServices(state.server);
    const chars = state.services.reduce((a, s) => a + (s.characteristics?.length ?? 0), 0);
    Log.add(`Serviços descobertos: ${state.services.length} (${chars} características)`);
    renderGatt();
    renderHome();
    renderDiagnostic();
    // Salvamento automático (se habilitado) com técnico registrado previamente:
    if (settings.autoSaveHistory) await autoSaveDiagnostic();
  } catch (err) {
    const e = friendlyError(err);
    Log.add(`Falha na descoberta de serviços: ${e.message}`);
    toast(`Falha na descoberta de serviços: ${e.message}`, 'err', 6000);
  }
}

function renderGatt() {
  const box = $('#gatt-services');
  if (state.connected) {
    setConnectionStatus('● Conectado');
    $('#gatt-connection').insertAdjacentHTML('beforeend', `
      <div class="row-btns">
        <button id="btn-discover" class="btn btn-primary">Descobrir serviços</button>
        <button id="btn-disconnect" class="btn btn-danger">Desconectar</button>
        <button class="btn btn-secondary" data-screen="monitor">📡 Monitor</button>
      </div>`);
    $('#btn-discover').addEventListener('click', discoverAndRenderServices);
    $('#btn-disconnect').addEventListener('click', disconnectCurrent);
  } else if (state.connectionError) {
    setConnectionStatus(`Falha na conexão — ${state.connectionError}`, 'err');
  } else {
    setConnectionStatus('Desconectado');
  }

  if (!state.services.length) {
    box.innerHTML = `<div class="empty">${state.connected
      ? 'Serviços ainda não descobertos. Toque em "Descobrir serviços".'
      : 'Sem conexão ativa. Conecte-se pelo Scanner ou Detalhes BLE.'}</div>`;
    return;
  }

  box.innerHTML = state.services.map((s, i) => `
    <div class="svc-card" data-svc="${i}">
      <h2 class="card-title">Service</h2>
      <p class="uuid">UUID:<br>${uuidLabel(s.uuid)}</p>
      <p class="hint">Tipo: <b>${esc(s.type)}</b> · Características: <b>${s.characteristics?.length ?? 0}</b></p>
      ${s.characteristicError ? `<p class="hint state-err">Erro nas características: ${esc(s.characteristicError)}</p>` : ''}
      <button class="btn btn-secondary btn-sm" data-svc-toggle="${i}">Ver características</button>
      <div class="char-area hidden" id="svc-chars-${i}"></div>
    </div>`).join('');

  $$('[data-svc-toggle]').forEach((btn) =>
    btn.addEventListener('click', () => toggleCharacteristics(Number(btn.dataset.svcToggle))));
}

async function toggleCharacteristics(index) {
  const area = $(`#svc-chars-${index}`);
  if (!area.classList.contains('hidden')) { area.classList.add('hidden'); return; }
  const svc = state.services[index];
  const svcObj = state.server && (await state.server.getPrimaryServices().catch(() => []))
    .find((s) => s.uuid === svc.uuid);
  area.innerHTML = (svc.characteristics || []).map((c, ci) => charBlockHtml(c, index, ci)).join('');
  if ((svc.characteristics || []).some((c) => c.read)) {
    area.insertAdjacentHTML('afterbegin',
      '<div class="row-btns"><button class="btn btn-secondary btn-sm" data-batch-read>📖 Ler todas (READ)</button></div>');
  }
  area.classList.remove('hidden');
  const chars = await bindCharacteristicHandlers(area, svcObj);
  const batchBtn = $('[data-batch-read]', area);
  if (batchBtn && chars?.length) {
    batchBtn.addEventListener('click', () => batchRead(area, chars));
  }
}

/** Leitura em lote de todas as características READ do serviço. */
async function batchRead(area, chars) {
  const blocks = $$('.char-block', area);
  let ok = 0, fail = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const block = blocks[i];
    if (!ch?.read || !block) continue;
    const result = $('[data-result]', block);
    try {
      const view = await readCharacteristic(ch.object ?? ch);
      result.innerHTML = dataViewHtml(view, ch.uuid);
      bindCopyButtons(result);
      ok++;
    } catch (err) {
      fail++;
      result.innerHTML = `<div class="data-view">Falha na leitura: ${esc(friendlyError(err).message)}</div>`;
    }
  }
  Log.add(`Leitura em lote concluída: ${ok} com sucesso, ${fail} com falha`);
  toast(`Leitura em lote: ${ok} lida(s), ${fail} com falha.`, fail ? 'warn' : 'ok');
}

function charBlockHtml(c, svcIndex, ci) {
  const props = [
    c.read && badge('READ', 'on'),
    c.write && badge('WRITE', 'warn'),
    c.writeWithoutResponse && badge('WRITE WITHOUT RESPONSE', 'warn'),
    c.notify && badge('NOTIFY', 'on'),
    c.indicate && badge('INDICATE', 'blue')
  ].filter(Boolean).join('');

  const buttons = [];
  if (c.read) buttons.push(`<button class="btn btn-primary btn-sm" data-act="read">Ler</button>`);
  if (c.notify || c.indicate) buttons.push(`<button class="btn btn-secondary btn-sm" data-act="notify">Ativar notificações</button>`);
  if (c.write || c.writeWithoutResponse) buttons.push(`<button class="btn btn-secondary btn-sm" data-act="wtool">Ferramenta de escrita</button>`);

  return `
    <div class="char-block" data-ci="${ci}">
      <p class="uuid">Characteristic UUID:<br>${uuidLabel(c.uuid)}</p>
      <p class="uuid">Service UUID: ${uuidLabel(c.serviceUuid)}</p>
      <div class="mt">${props || '<span class="badge">sem propriedades informadas</span>'}</div>
      <div class="row-btns">${buttons.join('')}</div>
      <div class="char-result" data-result></div>
    </div>`;
}

async function bindCharacteristicHandlers(area, svcObj) {
  const blocks = $$('.char-block', area);
  if (!svcObj) return null;
  const chars = await getCharacteristics(svcObj).catch(() => []);

  blocks.forEach((block, i) => {
    const ch = chars[i];
    if (!ch) return;
    const result = $('[data-result]', block);

    $$('[data-act]', block).forEach((btn) => btn.addEventListener('click', async () => {
      const act = btn.dataset.act;
      try {
        if (act === 'read') {
          const view = await readCharacteristic(ch.object ?? ch);
          result.innerHTML = dataViewHtml(view, ch.uuid);
          bindCopyButtons(result);
          Log.add(`Leitura realizada: ${ch.uuid}`);
        } else if (act === 'notify') {
          btn.disabled = true;
          btn.textContent = 'Notificações ativas';
          const stop = await startNotifications(ch.object ?? ch, (view) => {
            pushMonitorEvent(ch.uuid, view);
          });
          state.stopNotifiers.push(stop);
          toast('Notificações ativadas. Veja o Monitor BLE.', 'ok');
          Log.add(`Notificações ativadas: ${ch.uuid}`);
        } else if (act === 'wtool') {
          renderWriteTool(result, ch);
        }
      } catch (err) {
        const e = friendlyError(err);
        Log.add(`Operação GATT falhou: ${e.message}`);
        toast(e.message, 'err', 5000);
      }
    }));

    // Descritores (dados avançados): somente quando o navegador e o
    // dispositivo oferecerem a API nativa de descritores.
    const nativeCh = ch.object ?? ch;
    if (settings.advanced && typeof nativeCh.getDescriptors === 'function') {
      const dBtn = el('button', 'btn btn-ghost btn-sm', 'Descritores (avançado)');
      $('.row-btns', block).appendChild(dBtn);
      dBtn.addEventListener('click', () => showDescriptors(result, nativeCh));
    }
  });
  return chars;
}

/** Lista descritores GATT da característica (leitura somente quando permitida). */
async function showDescriptors(result, nativeCh) {
  try {
    const descriptors = await getDescriptors(nativeCh);
    if (!descriptors || !descriptors.length) {
      result.insertAdjacentHTML('beforeend',
        '<div class="data-view">Descritores: nenhum disponibilizado pelo dispositivo.</div>');
      return;
    }
    for (const desc of descriptors) {
      let html;
      try {
        const view = await readDescriptor(desc.object);
        html = `<div class="data-view">Descriptor UUID: <span class="mono">${esc(desc.uuid)}</span><br>` +
               `HEX: <span class="hex">${esc(view.hex)}</span> (${view.byteCount} bytes)</div>`;
      } catch (err) {
        html = `<div class="data-view">Descriptor UUID: <span class="mono">${esc(desc.uuid)}</span><br>` +
               `Leitura não permitida: ${esc(friendlyError(err).message)}</div>`;
      }
      result.insertAdjacentHTML('beforeend', html);
    }
    Log.add(`Descritores listados: ${descriptors.length}`);
  } catch (err) {
    const e = friendlyError(err);
    Log.add(`Descritores: ${e.message}`);
    toast(e.message, 'err', 5000);
  }
}

/** Bloco de visualização de dados (timestamp, UUID, HEX, UTF-8, bytes). */
function dataViewHtml(view, uuid) {
  const id = 'dv' + Math.random().toString(36).slice(2, 8);
  return `
    <div class="data-view" id="${id}">
      <div>Timestamp: ${esc(localTimestamp())}</div>
      <div>UUID: <span class="mono">${esc(uuid)}</span></div>
      <div>HEX: <span class="hex">${esc(view.hex)}</span></div>
      <div>UTF-8: ${view.utf8 !== null ? esc(view.utf8) : 'Não disponível'}</div>
      <div>Quantidade de bytes: ${view.byteCount}</div>
      <div class="row-btns">
        <button class="btn btn-ghost btn-sm" data-copy="hex" data-from="${id}">Copiar HEX</button>
        <button class="btn btn-ghost btn-sm" data-copy="uuid" data-from="${id}">Copiar UUID</button>
      </div>
    </div>`;
}

function bindCopyButtons(root) {
  $$('[data-copy]', root).forEach((btn) => btn.addEventListener('click', () => {
    const view = $('#' + btn.dataset.from);
    if (btn.dataset.copy === 'hex') copyText($('.hex', view).textContent, 'HEX');
    else copyText($('.mono', view).textContent, 'UUID');
  }));
}

/**
 * Ferramenta de escrita GENÉRICA de diagnóstico.
 * Desabilitada por padrão. Sem payloads pré-definidos: o técnico autorizado
 * digita o conteúdo em hexadecimal. Nenhum comando específico de ATM ou
 * operação financeira existe neste aplicativo.
 */
function renderWriteTool(result, ch) {
  result.innerHTML = `
    <div class="data-view">
      <div class="notice notice-warn notice-inline">
        Ferramenta genérica de teste de escrita (diagnóstico). Não existem comandos
        pré-definidos. Use somente em dispositivos BLE autorizados e conhecidos.
      </div>
      <label class="setting"><span>Habilitar escrita</span><input type="checkbox" class="w-enable"></label>
      <input type="text" class="w-payload" placeholder="Payload HEX (ex.: 01 A4 FF)" maxlength="512">
      <div class="row-btns">
        <button class="btn btn-danger btn-sm w-send" disabled>Enviar teste (write)</button>
      </div>
    </div>`;
  const enable = $('.w-enable', result);
  const payload = $('.w-payload', result);
  const send = $('.w-send', result);
  enable.addEventListener('change', () => { send.disabled = !enable.checked; });
  send.addEventListener('click', async () => {
    try {
      const count = await writeDiagnostic(ch.object ?? ch, payload.value);
      Log.add(`Escrita genérica de teste: ${count} bytes para ${ch.uuid}`);
      toast(`${count} byte(s) enviado(s).`, 'ok');
    } catch (err) {
      const e = friendlyError(err);
      Log.add(`Escrita falhou: ${e.message}`);
      toast(e.message, 'err', 5000);
    }
  });
}

/* ================= Monitor de notificações ================= */

function pushMonitorEvent(uuid, view) {
  if (state.monitorPaused) return;
  state.notifications.push({ at: localTimestamp(), uuid, hex: view.hex, bytes: view.byteCount });
  if (state.notifications.length > 2000) state.notifications.shift();
  renderMonitor();
}

function renderMonitor() {
  const listEl = $('#monitor-list');
  if (!state.notifications.length) {
    listEl.innerHTML = '<div class="empty">Nenhum evento. Ative notificações em uma característica.</div>';
    return;
  }
  const items = state.notifications.slice(-200).reverse().map((n) => `
    <div class="monitor-item">
      <span class="m-time">${esc(n.at)}</span> NOTIFY<br>
      UUID: ${esc(n.uuid)}<br>
      Data: <span class="hex">${esc(n.hex)}</span> (${n.bytes} bytes)
    </div>`).join('');
  listEl.innerHTML = items;
}

/* ================= Diagnóstico ================= */

function computeChecklist() {
  const chars = state.services.flatMap((s) => s.characteristics || []);
  return {
    'Dispositivo detectado': { ok: !!state.selected, warn: !state.selected },
    'GATT disponível': { ok: !!(state.server || state.connected), warn: !(state.server || state.connected) },
    'Conexão estabelecida': { ok: state.connected, warn: !state.connected && !state.connectionError, err: !!state.connectionError },
    'Serviços descobertos': { ok: state.services.length > 0, warn: state.services.length === 0 },
    'Características descobertas': { ok: chars.length > 0, warn: chars.length === 0 },
    'READ disponível': { ok: chars.some((c) => c.read), warn: !chars.some((c) => c.read) },
    'NOTIFY disponível': { ok: chars.some((c) => c.notify || c.indicate), warn: !chars.some((c) => c.notify || c.indicate) }
  };
}

function renderDiagnostic() {
  const box = $('#diag-checklist');
  const checklist = computeChecklist();
  state.checklist = Object.fromEntries(Object.entries(checklist).map(([k, v]) => [k, v.ok]));

  box.innerHTML = Object.entries(checklist).map(([name, st]) => {
    if (st.err) return `<div class="check-item state-err"><span class="ico">✕</span> ${esc(name)} — Falha de conexão</div>`;
    if (st.ok) return `<div class="check-item state-ok"><span class="ico">✓</span> ${esc(name)}</div>`;
    return `<div class="check-item state-warn"><span class="ico">⚠</span> ${esc(name)} — Não suportado</div>`;
  }).join('') + (state.selected?.isDemo
    ? '<div class="notice notice-warn">Sessão DEMO: checklist gerado a partir de dados fictícios de demonstração.</div>'
    : '');
}

async function saveDiagnosticRecord(silentIfEmpty = false) {
  const form = readForm('#form-diagnostic');
  if (!form.technician && silentIfEmpty) {
    Log.add('Salvamento automático ignorado: técnico responsável não informado');
    return null;
  }
  if (!form.technician) {
    $('#diag-form-msg').textContent = 'Informe o técnico responsável.';
    $('#diag-form-msg').className = 'form-msg err';
    return null;
  }
  const report = buildJsonReport(state, form);
  const saved = await Storage.saveDiagnostic(report);
  state.lastDiagAt = new Date();
  Storage.setSetting('lastTechnician', form.technician);
  if (!silentIfEmpty) {
    $('#diag-form-msg').textContent = 'Diagnóstico salvo no histórico local.';
    $('#diag-form-msg').className = 'form-msg ok';
    toast('Diagnóstico salvo.', 'ok');
  }
  Log.add('Diagnóstico salvo no histórico local');
  renderHome();
  return saved;
}

async function autoSaveDiagnostic() {
  await saveDiagnosticRecord(true);
}

function readForm(selector) {
  const data = {};
  $$(selector + ' [name]').forEach((input) => { data[input.name] = input.value; });
  return data;
}

/* ================= Inventário (cadastro) ================= */

async function renderDeviceInventory() {
  const listEl = $('#device-list');
  const devices = await Storage.listDevices();
  if (!devices.length) {
    listEl.innerHTML = '<div class="empty">Nenhum dispositivo cadastrado.</div>';
    return;
  }
  listEl.innerHTML = devices.map((d) => `
    <div class="hist-card">
      <div class="h-top"><strong>${esc(d.equipmentName)}</strong>
        <button class="btn btn-danger btn-sm" data-del-device="${d.id}">Excluir</button></div>
      <div class="h-meta">
        ${d.internalId ? `<span>ID interno: ${esc(d.internalId)}</span>` : ''}
        ${d.manufacturer ? `<span>Fabricante: ${esc(d.manufacturer)}</span>` : ''}
        ${d.model ? `<span>Modelo: ${esc(d.model)}</span>` : ''}
        ${d.serialNumber ? `<span>N° série: ${esc(d.serialNumber)}</span>` : ''}
        ${d.unit ? `<span>Unidade: ${esc(d.unit)}</span>` : ''}
        ${d.location ? `<span>Local: ${esc(d.location)}</span>` : ''}
        ${d.serviceUuid ? `<span class="mono">Service UUID: ${esc(d.serviceUuid)}</span>` : ''}
      </div>
      ${d.notes ? `<p class="hint">${esc(d.notes)}</p>` : ''}
    </div>`).join('');

  $$('[data-del-device]', listEl).forEach((btn) =>
    btn.addEventListener('click', async () => {
      const ok = await confirmModal('Excluir dispositivo', 'Confirmar a exclusão deste cadastro? Esta ação não pode ser desfeita.', 'Excluir', true);
      if (!ok) return;
      await Storage.deleteDevice(Number(btn.dataset.delDevice));
      toast('Cadastro excluído.', 'ok');
      renderDeviceInventory();
    }));
}

/* ================= Histórico ================= */

async function renderHistory() {
  const listEl = $('#history-list');
  const records = await Storage.listDiagnostics();
  if (!records.length) {
    listEl.innerHTML = '<div class="empty">Nenhum diagnóstico salvo ainda.</div>';
    return;
  }
  listEl.innerHTML = records.map((r) => `
    <div class="hist-card">
      <div class="h-top">
        <strong>${esc(r.deviceName || 'Dispositivo sem nome')} ${r.isDemo ? badge('DEMO', 'demo') : ''}</strong>
        <span class="h-date">${esc(localTimestamp(new Date(r.savedAt)))}</span>
      </div>
      <div class="h-meta">
        <span>Resultado: <b>${esc(r.result)}</b></span>
        <span>Serviços: ${r.servicesCount}</span>
        <span>Características: ${r.characteristicsCount}</span>
      </div>
      <div class="row-btns">
        <button class="btn btn-secondary btn-sm" data-hist-view="${r.id}">Visualizar</button>
        <button class="btn btn-secondary btn-sm" data-hist-export="${r.id}">Exportar</button>
        <button class="btn btn-danger btn-sm" data-hist-del="${r.id}">Excluir</button>
      </div>
    </div>`).join('');

  $$('[data-hist-view]', listEl).forEach((b) => b.addEventListener('click', async () => {
    const rec = await Storage.getDiagnostic(Number(b.dataset.histView));
    if (rec) viewReportModal(rec);
  }));
  $$('[data-hist-export]', listEl).forEach((b) => b.addEventListener('click', async () => {
    const rec = await Storage.getDiagnostic(Number(b.dataset.histExport));
    if (!rec) return;
    const json = buildJsonReportFromHistory(rec);
    download(`ble-diagnostico-${rec.id}.json`, JSON.stringify(json, null, 2));
  }));
  $$('[data-hist-del]', listEl).forEach((b) => b.addEventListener('click', async () => {
    const ok = await confirmModal('Excluir registro', 'Confirmar a exclusão deste diagnóstico? Esta ação não pode ser desfeita.', 'Excluir', true);
    if (!ok) return;
    await Storage.deleteDiagnostic(Number(b.dataset.histDel));
    toast('Registro excluído.', 'ok');
    renderHistory();
  }));
}

function buildJsonReportFromHistory(rec) {
  // O relatório completo foi salvo no momento do diagnóstico.
  return rec.report ?? { application: 'BLE Diagnostic Scanner', note: 'Relatório detalhado não disponível neste registro.', summary: rec };
}

function viewReportModal(rec) {
  const root = $('#modal-root');
  const backdrop = el('div', 'modal-backdrop');
  const modal = el('div', 'modal');
  const h = el('h3', null, 'Diagnóstico salvo');
  const pre = el('pre');
  pre.className = 'mono';
  pre.style.cssText = 'font-size:11px;overflow:auto;max-height:50vh;white-space:pre-wrap;word-break:break-all;';
  pre.textContent = JSON.stringify(buildJsonReportFromHistory(rec), null, 2);
  const row = el('div', 'row-btns');
  const close = el('button', 'btn btn-primary', 'Fechar');
  close.addEventListener('click', () => backdrop.remove());
  row.appendChild(close);
  modal.append(h, pre, row);
  backdrop.appendChild(modal);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  root.appendChild(backdrop);
}

/* ================= Configurações ================= */

function renderSettingsValues() {
  $('#set-theme').checked = settings.theme === 'light';
  $('#set-advanced').checked = settings.advanced === true;
  $('#set-fulluuid').checked = settings.fullUuids === true;
  $('#set-autosave').checked = settings.autoSaveHistory === true;
  $('#set-demo').checked = settings.demoMode === true;
  $('#set-refresh').value = settings.refreshSeconds;
  $('#set-timeout').value = settings.discoverySeconds;
  $('#set-reconnect').checked = settings.reconnect === true;
  $('#set-services').value = settings.optionalServices || '';
}

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme === 'light' ? 'light' : 'dark';
}

function bindSettings() {
  $('#set-theme').addEventListener('change', (e) => {
    settings = Storage.setSetting('theme', e.target.checked ? 'light' : 'dark');
    applyTheme();
  });
  $('#set-advanced').addEventListener('change', (e) => {
    settings = Storage.setSetting('advanced', e.target.checked);
  });
  $('#set-fulluuid').addEventListener('change', (e) => {
    settings = Storage.setSetting('fullUuids', e.target.checked);
    renderScan();
  });
  $('#set-autosave').addEventListener('change', (e) => {
    settings = Storage.setSetting('autoSaveHistory', e.target.checked);
  });
  $('#set-demo').addEventListener('change', async (e) => {
    settings = Storage.setSetting('demoMode', e.target.checked);
    if (!settings.demoMode) {
      // Nunca misturar DEMO com real: limpeza imediata ao desativar.
      state.found = state.found.filter((d) => !d.isDemo);
      if (state.selected?.isDemo) {
        cleanupConnection();
        state.connected = false;
        state.server = null;
        state.services = [];
        state.selected = null;
      }
      toast('Modo demonstração desativado. Dados DEMO removidos da sessão.', 'ok');
    } else {
      toast('Modo demonstração ativado. Toda busca retornará apenas dados DEMO.', 'warn', 5000);
    }
    if (settings.demoMode && stopPassiveScanFn) togglePassiveScan(); // encerra varredura passiva real
    Log.add(`Modo demonstração ${settings.demoMode ? 'ativado' : 'desativado'}`);
    refreshCapabilities();
    renderScan();
  });
  $('#set-refresh').addEventListener('change', (e) => {
    const v = Math.min(60, Math.max(1, Number(e.target.value) || 2));
    e.target.value = v;
    settings = Storage.setSetting('refreshSeconds', v);
  });
  $('#set-timeout').addEventListener('change', (e) => {
    const v = Math.min(120, Math.max(5, Number(e.target.value) || 30));
    e.target.value = v;
    settings = Storage.setSetting('discoverySeconds', v);
  });
  $('#set-reconnect').addEventListener('change', (e) => {
    settings = Storage.setSetting('reconnect', e.target.checked);
    Log.add(`Reconexão automática ${e.target.checked ? 'ativada' : 'desativada'}`);
  });
  $('#set-services').addEventListener('change', (e) => {
    settings = Storage.setSetting('optionalServices', e.target.value);
  });
  $('#btn-export-data').addEventListener('click', async () => {
    const data = await Storage.exportAll();
    download('ble-diagnostic-dados.json', JSON.stringify(data, null, 2));
    toast('Dados exportados.', 'ok');
  });
  $('#btn-clear-history').addEventListener('click', async () => {
    const ok = await confirmModal('Limpar histórico', 'Confirmar a exclusão de TODOS os diagnósticos salvos? Esta ação não pode ser desfeita.', 'Limpar tudo', true);
    if (!ok) return;
    await Storage.clearHistory();
    toast('Histórico limpo.', 'ok');
    Log.add('Histórico limpo pelo usuário');
    renderHistory();
  });
}

/* ================= Formulários ================= */

function bindForms() {
  $('#form-device').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = readForm('#form-device');
    const msg = $('#device-form-msg');
    if (!String(data.equipmentName || '').trim()) {
      msg.textContent = 'O nome do equipamento é obrigatório.';
      msg.className = 'form-msg err';
      return;
    }
    if (data.serviceUuid && !/^[0-9a-fA-F]{4}([0-9a-fA-F-]{4,33})?$/.test(String(data.serviceUuid).trim())
        && !String(data.serviceUuid).includes('-')) {
      // Validação leve: aceita 16 bits ou 128 bits; sem inventar valor.
      msg.textContent = 'Service UUID inválido (use 4 dígitos hex ou UUID 128 bits).';
      msg.className = 'form-msg err';
      return;
    }
    try {
      await Storage.saveDevice(data);
      e.target.reset();
      msg.textContent = 'Dispositivo salvo no inventário local.';
      msg.className = 'form-msg ok';
      toast('Dispositivo salvo.', 'ok');
      renderDeviceInventory();
    } catch (err) {
      msg.textContent = err.message || 'Falha ao salvar.';
      msg.className = 'form-msg err';
    }
  });

  $('#form-diagnostic').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveDiagnosticRecord(false);
  });

  $('#btn-export-json').addEventListener('click', () => {
    const form = readForm('#form-diagnostic');
    const report = buildJsonReport(state, form);
    download(`ble-diagnostico-${Date.now()}.json`, JSON.stringify(report, null, 2));
    Log.add('Relatório JSON exportado');
  });
  $('#btn-export-report').addEventListener('click', () => {
    const form = readForm('#form-diagnostic');
    download(`ble-relatorio-${Date.now()}.txt`, buildTextReport(buildJsonReport(state, form)), 'text/plain');
    Log.add('Relatório legível exportado');
  });

  // Pré-preenche o último técnico usado (conveniência, não obrigatório).
  const tech = $('input[name="technician"]');
  if (tech && settings.lastTechnician) tech.value = settings.lastTechnician;
}

/* ================= Log técnico ================= */

function bindLog() {
  $('#btn-log-fab').addEventListener('click', () => Log.toggle());
  $('#btn-log-side').addEventListener('click', () => Log.toggle());
  $('#btn-log-close').addEventListener('click', () => Log.toggle(false));
  $('#btn-log-clear').addEventListener('click', () => { Log.clear(); });
  $('#btn-log-copy').addEventListener('click', () => copyText(Log.asText(), 'Log'));
  $('#btn-log-export').addEventListener('click', () =>
    download(`ble-log-${Date.now()}.txt`, Log.asText(), 'text/plain'));
}

/* ================= Navegação / eventos globais ================= */

function bindGlobalEvents() {
  // Botões de navegação (sidebar, bottom nav e atalhos internos).
  document.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-screen]');
    if (nav && !nav.dataset.filter) showScreen(nav.dataset.screen);
  });

  $('#btn-scan').addEventListener('click', startScan);
  $('#btn-scan-home').addEventListener('click', () => { showScreen('scanner'); startScan(); });
  $('#btn-known').addEventListener('click', loadKnownDevices);
  $('#btn-passive').addEventListener('click', togglePassiveScan);
  $('#btn-known-home').addEventListener('click', async () => {
    showScreen('scanner');
    await loadKnownDevices();
  });

  // Filtros e ordenação do scanner
  $$('#scan-filters .filter-chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      $$('#scan-filters .filter-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.filter = chip.dataset.filter;
      renderScan();
    }));
  $('#scan-sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    renderScan();
  });

  // Seleção de dispositivo na lista do scanner
  $('#scan-list').addEventListener('click', (e) => {
    const card = e.target.closest('.device-card');
    if (!card) return;
    const record = state.found.find((d) => d.key === card.dataset.key);
    if (!record) return;
    state.selected = record;
    showScreen('device');
  });

  // Monitor
  $('#btn-monitor-pause').addEventListener('click', (e) => {
    state.monitorPaused = !state.monitorPaused;
    e.target.textContent = state.monitorPaused ? '▶ Retomar' : '⏸ Pausar';
    Log.add(`Monitor ${state.monitorPaused ? 'pausado' : 'retomado'}`);
  });
  $('#btn-monitor-clear').addEventListener('click', () => {
    state.notifications = [];
    renderMonitor();
  });
  $('#btn-monitor-export').addEventListener('click', () => {
    download(`ble-monitor-${Date.now()}.json`, JSON.stringify({
      application: 'BLE Diagnostic Scanner',
      events: state.notifications
    }, null, 2));
  });

  // Erros globais: a aplicação nunca deve travar sem aviso.
  window.addEventListener('unhandledrejection', (e) => {
    Log.add(`Erro não tratado: ${e.reason?.message || e.reason}`);
  });
  window.addEventListener('error', (e) => {
    Log.add(`Erro: ${e.message}`);
  });
}

/* ================= Inicialização ================= */

async function init() {
  applyTheme();
  bindGlobalEvents();
  bindForms();
  bindSettings();
  bindLog();
  renderSettingsValues();
  await refreshCapabilities();
  renderHome();
  renderScan();
  renderDiagnostic();
  renderMonitor();
  // Varredura passiva: botão visível somente quando o navegador oferece.
  const passiveSupported = isWebBluetoothSupported() &&
    typeof navigator.bluetooth?.requestLEScan === 'function';
  $('#btn-passive').classList.toggle('hidden', !passiveSupported);
  showScreen('home');
  Log.add(`BLE Diagnostic Scanner v${APP_VERSION} iniciado`);

  // Service Worker (cache, offline e atualização controlada).
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      reg.addEventListener('updatefound', () => {
        Log.add('Nova versão disponível (atualização baixada)');
        toast('Nova versão baixada. Reinicie o aplicativo para atualizar.', 'info', 6000);
      });
    } catch (err) {
      Log.add(`Service Worker indisponível: ${err.message}`);
    }
  }
}

init();
