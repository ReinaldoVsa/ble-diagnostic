/**
 * export.js — Exportação de diagnósticos.
 * Responsável por: montar o relatório JSON (sem valores inventados; campos
 * indisponíveis são null), gerar relatório legível e baixar arquivos.
 */

import { localTimestamp } from './ui.js';

/** Faz o download de um conteúdo como arquivo local. */
export function download(filename, content, mimeType = 'application/json') {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Monta o relatório JSON do diagnóstico atual.
 * state: estado da sessão (veja app.js). form: campos preenchidos pelo técnico.
 * Regra: informação não disponível => null. Nada é inventado.
 */
export function buildJsonReport(state, form = {}) {
  const dv = state.selected || {};

  // Dados de anúncio: apenas o que o navegador realmente forneceu.
  const advertisement = {};
  if (typeof dv.rssi === 'number') advertisement.rssi = dv.rssi;
  if (typeof dv.txPower === 'number') advertisement.txPower = dv.txPower;
  if (dv.manufacturerData) advertisement.manufacturerData = dv.manufacturerData;
  if (dv.serviceData) advertisement.serviceData = dv.serviceData;
  if (Array.isArray(dv.advertisedServices) && dv.advertisedServices.length) {
    advertisement.advertisedServices = dv.advertisedServices;
  }

  const services = (state.services || []).map((s) => ({
    uuid: s.uuid,
    type: s.type,
    characteristics: (s.characteristics || []).map((c) => ({
      uuid: c.uuid,
      serviceUuid: c.serviceUuid,
      properties: {
        read: c.read === true,
        write: c.write === true,
        writeWithoutResponse: c.writeWithoutResponse === true,
        notify: c.notify === true,
        indicate: c.indicate === true
      }
    }))
  }));

  const characteristicsCount = services.reduce(
    (acc, s) => acc + s.characteristics.length, 0);

  return {
    application: 'BLE Diagnostic Scanner',
    timestamp: new Date().toISOString(),
    device: {
      name: dv.name ?? null,
      id: dv.id ?? null,
      rssi: typeof dv.rssi === 'number' ? dv.rssi : null,
      isDemo: dv.isDemo === true || undefined
    },
    advertisement,
    gatt: { services },
    diagnostic: {
      isDemo: dv.isDemo === true,
      result: computeResult(state),
      checklist: state.checklist || {},
      connectionError: state.connectionError || null,
      servicesCount: services.length,
      characteristicsCount,
      // Campos preenchidos manualmente pelo técnico autorizado:
      technician: clean(form.technician),
      internalId: clean(form.internalId),
      location: clean(form.location),
      assetNumber: clean(form.assetNumber),
      manufacturer: clean(form.manufacturer),
      model: clean(form.model),
      serialNumber: clean(form.serialNumber),
      notes: clean(form.notes)
    }
  };
}

/** Resultado resumido do diagnóstico, derivado apenas do que ocorreu. */
function computeResult(state) {
  if (state.connectionError) return 'Falha de conexão';
  if (state.connected && (state.services?.length ?? 0) > 0) return 'Concluído';
  if (state.connected) return 'Conectado (serviços não descobertos)';
  if (state.selected) return 'Dispositivo detectado';
  return 'Sem dispositivo';
}

/** Relatório legível (texto) para impressão/arquivamento. */
export function buildTextReport(report) {
  const L = [];
  const d = report.diagnostic || {};
  L.push('========================================');
  L.push('  BLE DIAGNOSTIC SCANNER — RELATÓRIO');
  L.push('========================================');
  L.push(`Data/hora da exportação: ${localTimestamp()}`);
  if (d.isDemo) L.push('*** MODO DEMONSTRAÇÃO — DADOS FICTÍCIOS (DEMO) ***');
  L.push('');
  L.push('--- DISPOSITIVO ---');
  L.push(`Nome: ${report.device.name ?? 'Não disponibilizado pelo sistema'}`);
  L.push(`ID: ${report.device.id ?? 'Não disponibilizado pelo sistema'}`);
  L.push(`RSSI: ${report.device.rssi !== null ? `${report.device.rssi} dBm` : 'Não disponibilizado pelo sistema'}`);
  L.push('');
  L.push('--- ANÚNCIO ---');
  const advKeys = Object.keys(report.advertisement || {});
  if (!advKeys.length) {
    L.push('Nenhum dado de anúncio disponibilizado pelo sistema.');
  } else {
    for (const [k, v] of Object.entries(report.advertisement)) {
      L.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
  }
  L.push('');
  L.push('--- GATT ---');
  const svcs = report.gatt?.services || [];
  if (!svcs.length) {
    L.push('Nenhum serviço descoberto.');
  } else {
    svcs.forEach((s) => {
      L.push(`Service ${s.type}: ${s.uuid}`);
      s.characteristics.forEach((c) => {
        const props = Object.entries(c.properties)
          .filter(([, on]) => on).map(([name]) => name.toUpperCase());
        L.push(`  Characteristic ${c.uuid} [${props.join(', ') || 'sem propriedades'}]`);
      });
    });
  }
  L.push('');
  L.push('--- DIAGNÓSTICO ---');
  L.push(`Resultado: ${d.result ?? 'indefinido'}`);
  L.push(`Serviços: ${d.servicesCount ?? 0} | Características: ${d.characteristicsCount ?? 0}`);
  if (d.connectionError) L.push(`Erro de conexão: ${d.connectionError}`);
  L.push('');
  L.push('--- REGISTRO DO TÉCNICO (preenchimento manual) ---');
  L.push(`Técnico responsável: ${d.technician ?? '—'}`);
  L.push(`Identificação interna: ${d.internalId ?? '—'}`);
  L.push(`Local/unidade: ${d.location ?? '—'}`);
  L.push(`Número patrimonial: ${d.assetNumber ?? '—'}`);
  L.push(`Fabricante: ${d.manufacturer ?? '—'}`);
  L.push(`Modelo: ${d.model ?? '—'}`);
  L.push(`Número de série: ${d.serialNumber ?? '—'}`);
  L.push(`Observações: ${d.notes ?? '—'}`);
  L.push('');
  L.push('Uso exclusivo em dispositivos BLE autorizados.');
  return L.join('\n');
}

/** Sanitiza campo textual do formulário: null quando vazio. */
function clean(value) {
  const v = String(value ?? '').trim();
  return v ? v.slice(0, 2000) : null;
}
