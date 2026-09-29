/**
 * demo.js — MODO DEMONSTRAÇÃO (separado da camada real).
 *
 * REGRAS:
 * - Todo dado de demonstração é constante e marcado como DEMO na interface.
 * - Dados DEMO nunca são misturados com dispositivos reais: quando o modo
 *   demonstração está ativo, a busca retorna apenas dispositivos DEMO; quando
 *   desativado, todos os registros DEMO são removidos da sessão.
 * - Os UUIDs usados são UUIDs padrão do Bluetooth SIG (Battery, Device
 *   Information) ou UUIDs de teste claramente fictícios. Nenhum valor é
 *   apresentado como dispositivo real.
 */

const BASE = '-0000-1000-8000-00805f9b34fb';
export const DEMO_UUIDS = {
  batteryService: `0000180f${BASE}`,
  batteryLevel: `00002a19${BASE}`,
  deviceInfo: `0000180a${BASE}`,
  manufacturerName: `00002a29${BASE}`,
  modelNumber: `00002a24${BASE}`,
  // UUID de teste, fictício, apenas para a ferramenta genérica de diagnóstico:
  testService: `0000de50${BASE}`,
  testCharacteristic: `0000de51${BASE}`
};

/**
 * Característica DEMO. Estende EventTarget para que listeners e
 * notificações funcionem como na Web Bluetooth API real.
 */
class DemoCharacteristic extends EventTarget {
  constructor({ uuid, service, properties, readValue }) {
    super();
    this.uuid = uuid;
    this.service = service;
    this.properties = properties; // {read, write, writeWithoutResponse, notify, indicate}
    this._readValue = readValue;  // função () => DataView
    this._lastWritten = null;
    this._timer = null;
  }

  async readValue() {
    if (!this.properties.read) throw new Error('Read não suportado.');
    return this._readValue();
  }

  async startNotifications() {
    if (!this.properties.notify && !this.properties.indicate) {
      throw new Error('Notify não suportado.');
    }
    if (this._timer) return;
    // Simula eventos periódicos de notificação (1 por segundo).
    this._timer = setInterval(() => {
      this.dispatchEvent(new Event('characteristicvaluechanged'));
    }, 1000);
  }

  async stopNotifications() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async writeValue(bytes) {
    if (!this.properties.write) throw new Error('Write não suportado.');
    this._lastWritten = bytes.slice(0);
  }

  async writeValueWithoutResponse(bytes) {
    if (!this.properties.writeWithoutResponse) throw new Error('Write sem resposta não suportado.');
    this._lastWritten = bytes.slice(0);
  }

  /** DataView corrente (para o handler de notificação da camada gatt.js). */
  get value() {
    return this._readValue();
  }
}

function dataView(bytes) {
  return new DataView(new Uint8Array(bytes).buffer);
}

function strBytes(text) {
  return Array.from(new TextEncoder().encode(text));
}

/** Serviço DEMO com a mesma interface mínima do GATT real. */
class DemoService {
  constructor(uuid, characteristics) {
    this.uuid = uuid;
    this._chars = characteristics;
    this._chars.forEach((c) => { c.service = this; });
  }
  async getCharacteristics() { return this._chars.slice(); }
}

/** Servidor GATT DEMO. */
class DemoServer {
  constructor(services) { this._services = services; }
  async getPrimaryServices() { return this._services.slice(); }
}

/* ---------------- Dispositivos DEMO (constantes) ---------------- */

function batteryChar(service) {
  let level = 90;
  const ch = new DemoCharacteristic({
    uuid: DEMO_UUIDS.batteryLevel,
    service,
    properties: { read: true, notify: true },
    readValue: () => {
      // Valor fictício previsível (ciclo DEMO 90–100%).
      level = level >= 100 ? 90 : level + 1;
      return dataView([level]);
    }
  });
  return ch;
}

function deviceInfoService() {
  const manufacturer = new DemoCharacteristic({
    uuid: DEMO_UUIDS.manufacturerName, service: null,
    properties: { read: true },
    readValue: () => dataView(strBytes('DEMO Labs'))
  });
  const model = new DemoCharacteristic({
    uuid: DEMO_UUIDS.modelNumber, service: null,
    properties: { read: true },
    readValue: () => dataView(strBytes('DM-100 (DEMO)'))
  });
  return new DemoService(DEMO_UUIDS.deviceInfo, [manufacturer, model]);
}

function testService() {
  const service = new DemoService(DEMO_UUIDS.testService, []);
  const ch = new DemoCharacteristic({
    uuid: DEMO_UUIDS.testCharacteristic, service,
    properties: { read: true, write: true, writeWithoutResponse: true, notify: true },
    readValue: () => dataView(ch._lastWritten ?? strBytes('DEMO'))
  });
  ch._readValue = () => dataView(ch._lastWritten ?? [0x44, 0x45, 0x4D, 0x4F]); // "DEMO"
  service._chars.push(ch);
  return service;
}

function buildDemoServer() {
  const batteryService = new DemoService(DEMO_UUIDS.batteryService, []);
  const battery = batteryChar(batteryService);
  batteryService._chars.push(battery);
  return new DemoServer([batteryService, deviceInfoService(), testService()]);
}

/** Inventário DEMO fixo (valores constantes, identificados como DEMO). */
export function demoDevices() {
  return [
    {
      key: 'demo-1',
      name: 'DEMO-Sensor-01',
      id: 'demo-device-001',
      rssi: -48,
      txPower: -12,
      manufacturerData: { '65535': '44 45 4D 4F' }, // "DEMO"
      serviceData: {},
      advertisedServices: [DEMO_UUIDS.batteryService],
      discoveredAt: new Date().toISOString(),
      isDemo: true
    },
    {
      key: 'demo-2',
      name: 'DEMO-Sensor-02',
      id: 'demo-device-002',
      rssi: -82,
      txPower: null,
      manufacturerData: null,
      serviceData: null,
      advertisedServices: [],
      discoveredAt: new Date().toISOString(),
      isDemo: true
    }
  ];
}

/** Conecta a um dispositivo DEMO. Retorna um servidor com interface GATT. */
export function connectDemo(deviceRecord) {
  if (!deviceRecord?.isDemo) throw new Error('Não é um dispositivo DEMO.');
  const server = buildDemoServer();
  return Promise.resolve(server);
}
