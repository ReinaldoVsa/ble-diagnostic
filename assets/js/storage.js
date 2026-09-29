/**
 * storage.js — Persistência local.
 * - IndexedDB: dispositivos cadastrados (inventário) e histórico de diagnósticos.
 * - localStorage: preferências do aplicativo.
 *
 * Nenhuma credencial é armazenada. Nenhum dado sai do dispositivo.
 */

const DB_NAME = 'ble-diagnostic-db';
const DB_VERSION = 1;
const STORE_DEVICES = 'devices';    // inventário cadastrado manualmente
const STORE_HISTORY = 'history';    // diagnósticos salvos

let dbPromise = null;

/** Abre (ou cria) o banco. */
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_DEVICES)) {
        db.createObjectStore(STORE_DEVICES, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_HISTORY)) {
        db.createObjectStore(STORE_HISTORY, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function reqAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* ---------------- Inventário de dispositivos ---------------- */

async function saveDevice(data) {
  const db = await openDB();
  const record = {
    equipmentName: String(data.equipmentName || '').trim(),
    internalId: String(data.internalId || '').trim(),
    manufacturer: String(data.manufacturer || '').trim(),
    model: String(data.model || '').trim(),
    serialNumber: String(data.serialNumber || '').trim(),
    unit: String(data.unit || '').trim(),
    location: String(data.location || '').trim(),
    serviceUuid: String(data.serviceUuid || '').trim(),
    notes: String(data.notes || '').trim(),
    created_date: new Date().toISOString()
  };
  if (!record.equipmentName) throw new Error('Nome do equipamento é obrigatório.');
  const id = await reqAsPromise(tx(db, STORE_DEVICES, 'readwrite').add(record));
  return { ...record, id };
}

async function listDevices() {
  const db = await openDB();
  const all = await reqAsPromise(tx(db, STORE_DEVICES, 'readonly').getAll());
  return all.sort((a, b) => String(b.created_date).localeCompare(String(a.created_date)));
}

async function deleteDevice(id) {
  const db = await openDB();
  return reqAsPromise(tx(db, STORE_DEVICES, 'readwrite').delete(id));
}

/* ---------------- Histórico de diagnósticos ---------------- */

async function saveDiagnostic(report) {
  const db = await openDB();
  const record = {
    savedAt: new Date().toISOString(),
    deviceName: report?.device?.name ?? null,
    result: report?.diagnostic?.result ?? 'indefinido',
    servicesCount: report?.gatt?.services?.length ?? 0,
    characteristicsCount: report?.gatt?.services?.reduce(
      (acc, s) => acc + (s.characteristics?.length ?? 0), 0) ?? 0,
    isDemo: report?.diagnostic?.isDemo === true,
    report
  };
  const id = await reqAsPromise(tx(db, STORE_HISTORY, 'readwrite').add(record));
  return { ...record, id };
}

async function listDiagnostics() {
  const db = await openDB();
  const all = await reqAsPromise(tx(db, STORE_HISTORY, 'readonly').getAll());
  return all.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}

async function getDiagnostic(id) {
  const db = await openDB();
  return reqAsPromise(tx(db, STORE_HISTORY, 'readonly').get(id));
}

async function deleteDiagnostic(id) {
  const db = await openDB();
  return reqAsPromise(tx(db, STORE_HISTORY, 'readwrite').delete(id));
}

async function clearHistory() {
  const db = await openDB();
  return reqAsPromise(tx(db, STORE_HISTORY, 'readwrite').clear());
}

/* ---------------- Exportação completa ---------------- */

async function exportAll() {
  const [devices, history] = await Promise.all([listDevices(), listDiagnostics()]);
  return {
    application: 'BLE Diagnostic Scanner',
    exportedAt: new Date().toISOString(),
    devices,
    history: history.map(({ id, savedAt, deviceName, result, servicesCount, characteristicsCount, isDemo }) => ({
      id, savedAt, deviceName, result, servicesCount, characteristicsCount, isDemo
    }))
  };
}

/* ---------------- Preferências (localStorage) ---------------- */

const SETTINGS_KEY = 'ble-diagnostic-settings';

const DEFAULT_SETTINGS = {
  theme: 'dark',          // 'dark' | 'light'
  advanced: false,        // mostrar dados avançados
  fullUuids: false,       // mostrar UUIDs completos
  autoSaveHistory: true,  // salvar diagnóstico automaticamente ao concluir
  demoMode: false,        // modo demonstração (dados DEMO)
  refreshSeconds: 2,      // intervalo de atualização do monitor
  discoverySeconds: 30,  // tempo de descoberta/timeout
  reconnect: false,       // reconexão automática após queda (experimental)
  optionalServices: ''    // UUIDs de serviços autorizados, um por linha
};

function getSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function setSetting(key, value) {
  const settings = getSettings();
  settings[key] = value;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* localStorage indisponível: segue com valores em memória */
  }
  return settings;
}

export const Storage = {
  saveDevice, listDevices, deleteDevice,
  saveDiagnostic, listDiagnostics, getDiagnostic, deleteDiagnostic, clearHistory,
  exportAll,
  getSettings, setSetting, DEFAULT_SETTINGS
};
