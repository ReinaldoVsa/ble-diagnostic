/**
 * gatt.js — Camada GATT.
 * Responsável por: descoberta de serviços e características, leitura (READ),
 * assinatura de notificações (NOTIFY/INDICATE) e formatação de dados.
 *
 * REGRAS DE SEGURANÇA:
 * - UUIDs recebidos do dispositivo são exibidos sem alteração.
 * - WRITE existe apenas como ferramenta genérica de diagnóstico, desabilitada
 *   por padrão, sem qualquer comando específico para ATM ou operações
 *   financeiras. Payloads são definidos manualmente pelo técnico autorizado
 *   em hexadecimal, sem comandos pré-definidos.
 */

import { friendlyError } from './ble.js';

/** Descobre todos os serviços primários (e o secundário, quando exposto). */
export async function discoverServices(server) {
  if (!server) throw new Error('Servidor GATT não conectado.');
  const services = await server.getPrimaryServices();
  const result = [];
  for (const service of services) {
    const entry = {
      uuid: service.uuid,          // UUID exatamente como recebido do dispositivo
      type: 'Primary',
      characteristics: []
    };
    try {
      entry.characteristics = await getCharacteristics(service);
    } catch (err) {
      entry.characteristicError = friendlyError(err).message;
    }
    result.push(entry);
  }
  return result;
}

/** Lista as características de um serviço com suas propriedades reais. */
export async function getCharacteristics(service) {
  const chars = await service.getCharacteristics();
  return chars.map((ch) => describeCharacteristic(ch));
}

/** Descreve uma característica a partir das propriedades informadas pelo dispositivo. */
export function describeCharacteristic(ch) {
  const p = ch.properties || {};
  return {
    uuid: ch.uuid,                    // UUID exatamente como recebido
    serviceUuid: ch.service?.uuid ?? null,
    object: ch,                        // referência para read/notify/write
    read: p.read === true,
    write: p.write === true,
    writeWithoutResponse: p.writeWithoutResponse === true,
    notify: p.notify === true,
    indicate: p.indicate === true
  };
}

/**
 * Lê o valor de uma característica (somente quando READ estiver disponível).
 * Retorna { dataView, hex, utf8, utf8Valid, byteCount }.
 */
export async function readCharacteristic(ch) {
  if (!ch.properties?.read) {
    throw new Error('Read não permitido para esta característica.');
  }
  const dataView = await ch.readValue();
  return formatValue(dataView);
}

/**
 * Ativa notificações de uma característica (somente quando NOTIFY/INDICATE
 * estiver disponível). O handler recebe o valor formatado a cada evento.
 */
export async function startNotifications(ch, handler) {
  if (!(ch.properties?.notify || ch.properties?.indicate)) {
    throw new Error('Notify não permitido para esta característica.');
  }
  await ch.startNotifications();
  const listener = (event) => handler(formatValue(event.target.value));
  ch.addEventListener('characteristicvaluechanged', listener);
  return async () => {
    try {
      await ch.stopNotifications();
    } finally {
      ch.removeEventListener('characteristicvaluechanged', listener);
    }
  };
}

/**
 * Escrita genérica de diagnóstico (ferramenta de teste, desabilitada por
 * padrão na UI). Não existe payload pré-definido: o técnico autorizado
 * digita o conteúdo hexadecimal manualmente.
 */
export async function writeDiagnostic(ch, hexString, { withoutResponse = false } = {}) {
  const bytes = parseHex(hexString);
  if (!bytes.length) throw new Error('Informe um payload hexadecimal válido (ex.: 01 A4 FF).');
  if (withoutResponse && ch.properties?.writeWithoutResponse) {
    await ch.writeValueWithoutResponse(new Uint8Array(bytes));
  } else if (ch.properties?.write) {
    await ch.writeValue(new Uint8Array(bytes));
  } else {
    throw new Error('Write não permitido para esta característica.');
  }
  return bytes.length;
}

/* ---------------- Formatação de dados ---------------- */

/**
 * Converte um DataView em representações para exibição:
 * hex (bytes separados), UTF-8 (quando válido) e contagem de bytes.
 */
export function formatValue(dataView) {
  const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  let utf8 = null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Exibível apenas se for texto imprimível (evita lixo visual).
    if (/^[\t\n\r\x20-\x7E\u00A0-\uFFFF]*$/.test(text)) utf8 = text;
  } catch {
    utf8 = null; // sequência não é UTF-8 válida
  }
  return { dataView, hex, utf8, byteCount: bytes.length };
}

/** Converte string hexadecimal (com ou sem espaços) em array de bytes. */
export function parseHex(hexString) {
  const clean = String(hexString).replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
  if (clean.length === 0 || clean.length % 2 !== 0) return [];
  const bytes = [];
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return bytes;
}

/* ---------------- Descritores (dados avançados) ---------------- */

/**
 * Lista descritores GATT de uma característica.
 * Retorna null quando o navegador não oferece a API.
 */
export async function getDescriptors(ch) {
  if (typeof ch.getDescriptors !== 'function') return null;
  const descriptors = await ch.getDescriptors();
  return descriptors.map((d) => ({ uuid: d.uuid, object: d }));
}

/** Lê um descritor (somente quando permitido pelo dispositivo). */
export async function readDescriptor(descriptor) {
  const dataView = await descriptor.readValue();
  return formatValue(dataView);
}
