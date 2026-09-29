/**
 * ble.js — Camada Bluetooth Low Energy.
 * Responsável por: detecção de suporte, scanner (requestDevice), conexão,
 * desconexão e monitoramento de anúncios.
 *
 * HONESTIDADE TÉCNICA:
 * - A Web Bluetooth API NÃO oferece varredura passiva em segundo plano.
 *   A "busca" usa navigator.bluetooth.requestDevice(), que abre o seletor
 *   nativo do navegador. O aplicativo não inventa RSSI, MAC Address ou UUID.
 * - Dados de anúncio (RSSI, Tx Power, Manufacturer Data) só existem quando
 *   o navegador suporta watchAdvertisements(); caso contrário, a interface
 *   exibe "Não disponibilizado pelo sistema".
 */

/* ---------------- Erros amigáveis ---------------- */

/** Erro BLE com código interno para tratamento pela UI. */
export class BleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BleError';
    this.code = code;
  }
}

/** Converte exceções da plataforma em mensagens claras para o técnico. */
export function friendlyError(err) {
  if (err instanceof BleError) return err;
  const code = err?.name || '';
  const map = {
    NotFoundError: new BleError('USER_CANCEL', 'Seleção de dispositivo cancelada pelo usuário.'),
    SecurityError: new BleError('SECURITY', 'Permissão negada: serviço não autorizado (UUID fora da lista de serviços conhecidos).'),
    NetworkError: new BleError('NETWORK', 'Falha na conexão: verifique se o Bluetooth está ligado e o dispositivo está próximo.'),
    InvalidStateError: new BleError('DISCONNECTED', 'Dispositivo desconectado.'),
    NotSupportedError: new BleError('NOT_SUPPORTED', 'Operação não suportada por este dispositivo ou navegador.'),
    TimeoutError: new BleError('TIMEOUT', 'Tempo limite da operação excedido.'),
    AbortError: new BleError('ABORTED', 'Operação cancelada.')
  };
  const mapped = map[code];
  if (mapped) return mapped;
  const message = err instanceof Error ? err.message : String(err);
  return new BleError('UNKNOWN', `Erro inesperado: ${message}`);
}

/* ---------------- Detecção de capacidades ---------------- */

/** Web Bluetooth suportado neste navegador? */
export function isWebBluetoothSupported() {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

/** Contexto seguro (HTTPS ou localhost)? */
export function isSecureContext() {
  return window.isSecureContext === true;
}

/** Adaptador Bluetooth presente/ligado? (getAvailability, quando existir) */
export async function getBluetoothAvailability() {
  if (!isWebBluetoothSupported() || typeof navigator.bluetooth.getAvailability !== 'function') {
    return null; // não disponibilizado pelo sistema
  }
  try {
    return await navigator.bluetooth.getAvailability();
  } catch {
    return null;
  }
}

/* ---------------- Cliente BLE ---------------- */

/**
 * Wrapper da Web Bluetooth API. Todo acesso BLE passa por aqui.
 * O parâmetro logger recebe entradas do log técnico.
 */
export class BleClient {
  constructor(logger = () => {}) {
    this.logger = logger;
  }

  /** Garante precondições antes de qualquer operação BLE. */
  assertReady() {
    if (!isWebBluetoothSupported()) {
      throw new BleError('UNSUPPORTED',
        'Seu navegador não oferece Web Bluetooth. Utilize um navegador/dispositivo compatível (ex.: Chrome para Android).');
    }
    if (!isSecureContext()) {
      throw new BleError('INSECURE', 'Web Bluetooth exige HTTPS. Abra o aplicativo em um contexto seguro.');
    }
  }

  /**
   * Abre o seletor de dispositivos do navegador ("busca").
   * optionalServices: UUIDs autorizados para descoberta posterior.
   * Retorna o BluetoothDevice escolhido pelo usuário.
   */
  async requestDevice(optionalServices = []) {
    this.assertReady();
    this.logger('Solicitação de dispositivos ao navegador');
    try {
      const device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices
      });
      this.logger(`Dispositivo escolhido: ${device.name || '(sem nome)'} [${device.id}]`);
      return device;
    } catch (err) {
      throw friendlyError(err);
    }
  }

  /**
   * Tenta enriquecer o dispositivo com dados de anúncio (RSSI, Tx Power,
   * Manufacturer Data, Service Data). Recurso experimental: quando o
   * navegador não oferece, nada é inventado — apenas registramos.
   */
  async watchAdvertisements(device, onAdvertisement) {
    if (typeof device.watchAdvertisements !== 'function') {
      this.logger('watchAdvertisements não suportado pelo navegador (dados de anúncio indisponíveis)');
      return () => {};
    }
    const handler = (event) => {
      onAdvertisement({
        rssi: typeof event.rssi === 'number' ? event.rssi : null,
        txPower: typeof event.txPower === 'number' ? event.txPower : null,
        uuids: Array.isArray(event.uuids) ? event.uuids.slice() : null,
        manufacturerData: event.manufacturerData ? mapToPlain(event.manufacturerData) : null,
        serviceData: event.serviceData ? mapToPlain(event.serviceData) : null,
        at: new Date()
      });
    };
    device.addEventListener('advertisementreceived', handler);
    try {
      await device.watchAdvertisements();
      this.logger('Monitorando anúncios BLE (recursos experimentais do navegador)');
    } catch (err) {
      this.logger(`watchAdvertisements indisponível: ${err.message}`);
      device.removeEventListener('advertisementreceived', handler);
      return () => {};
    }
    return () => {
      device.removeEventListener('advertisementreceived', handler);
      if (typeof device.stopWatchingAdvertisements === 'function') {
        device.stopWatchingAdvertisements().catch(() => {});
      }
    };
  }

  /**
   * Lista dispositivos com permissão já concedida pelo usuário
   * (navigator.bluetooth.getDevices). Retorna null quando o navegador
   * não oferece a API — nada é inventado.
   */
  async getKnownDevices() {
    this.assertReady();
    if (typeof navigator.bluetooth.getDevices !== 'function') return null;
    try {
      const devices = await navigator.bluetooth.getDevices();
      this.logger(`Dispositivos conhecidos carregados: ${devices.length}`);
      return devices;
    } catch (err) {
      throw friendlyError(err);
    }
  }

  /**
   * Varredura passiva experimental (navigator.bluetooth.requestLEScan):
   * anúncios BLE em tempo real com RSSI/Tx Power/Manufacturer Data reais.
   * Retorna null quando o navegador não oferece, ou a função para encerrar.
   */
  async requestPassiveScan(onResult) {
    this.assertReady();
    if (typeof navigator.bluetooth.requestLEScan !== 'function') return null;
    const handler = (event) => {
      onResult({
        name: event.device?.name ?? null,
        deviceId: event.device?.id ?? null,
        device: event.device ?? null,
        rssi: typeof event.rssi === 'number' ? event.rssi : null,
        txPower: typeof event.txPower === 'number' ? event.txPower : null,
        uuids: Array.isArray(event.uuids) ? event.uuids.slice() : null,
        manufacturerData: event.manufacturerData ? mapToPlain(event.manufacturerData) : null,
        serviceData: event.serviceData ? mapToPlain(event.serviceData) : null,
        at: new Date()
      });
    };
    navigator.bluetooth.addEventListener('advertisementreceived', handler);
    let scan;
    try {
      scan = await navigator.bluetooth.requestLEScan({ acceptAllDevices: true });
    } catch (err) {
      navigator.bluetooth.removeEventListener('advertisementreceived', handler);
      throw friendlyError(err);
    }
    this.logger('Varredura passiva iniciada (requestLEScan, experimental)');
    return () => {
      try { scan.stop(); } catch { /* varredura já encerrada */ }
      navigator.bluetooth.removeEventListener('advertisementreceived', handler);
      this.logger('Varredura passiva encerrada');
    };
  }

  /**
   * Remove a permissão concedida a um dispositivo (device.forget),
   * quando o navegador oferece. Retorna false quando indisponível.
   */
  async forgetDevice(device) {
    if (!device || typeof device.forget !== 'function') return false;
    try {
      await device.forget();
      this.logger('Permissão do dispositivo removida (forget)');
      return true;
    } catch (err) {
      throw friendlyError(err);
    }
  }

  /** Conecta ao servidor GATT com timeout configurável (ms). */
  async connect(device, timeoutMs = 30000) {
    this.assertReady();
    if (!device?.gatt) {
      throw new BleError('NO_GATT', 'Servidor GATT não disponibilizado pelo dispositivo.');
    }
    this.logger('Solicitação GATT');
    try {
      const server = await withTimeout(device.gatt.connect(), timeoutMs,
        new BleError('TIMEOUT', 'Tempo limite de conexão excedido.'));
      this.logger('Conectado ao GATT');
      return server;
    } catch (err) {
      throw friendlyError(err);
    }
  }

  /** Desconecta do dispositivo (idempotente). */
  disconnect(device) {
    try {
      if (device?.gatt?.connected) {
        device.gatt.disconnect();
        this.logger('Desconexão solicitada pelo usuário');
      }
    } catch (err) {
      this.logger(`Erro ao desconectar: ${err.message}`);
    }
  }
}

/* ---------------- Utilitários ---------------- */

/** Promise com timeout. */
function withTimeout(promise, ms, timeoutError) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Converte Map de anúncios em objeto serializável {chave: hex}. */
function mapToPlain(map) {
  const out = {};
  for (const [key, value] of map.entries?.() || []) {
    out[String(key)] = value instanceof DataView
      ? Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
          .map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')
      : String(value);
  }
  return out;
}

/* ---------------- UUIDs ---------------- */

/**
 * Normaliza um UUID digitado pelo técnico para o formato aceito pela
 * Web Bluetooth. Não altera UUIDs recebidos do dispositivo — esta função
 * serve apenas para a lista de serviços autorizados conhecidos.
 */
export function normalizeOptionalServiceUuid(raw) {
  const value = String(raw).trim().toLowerCase();
  if (!value) return null;
  if (/^[0-9a-f]{4}$/.test(value)) {
    return `0000${value}-0000-1000-8000-00805f9b34fb`;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    return value;
  }
  return value; // nomes registrados (ex.: battery_service) seguem para o navegador validar
}
