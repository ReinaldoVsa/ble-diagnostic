/**
 * tests/auth.test.mjs — Testes unitários do bloqueio local por PIN (auth.js)
 *
 * Execução:  node --test tests/
 * Sem dependências externas: usa o runner nativo do Node (node:test) e a
 * Web Crypto embutida (globalThis.crypto). O localStorage é simulado em
 * memória — nada é gravado no disco.
 *
 * Escopo de honra: estes testes validam o fluxo do bloqueio LOCAL.
 * Nenhuma funcionalidade de autenticação de servidor é sugerida ou simulada.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/* ---- Simulação de localStorage (em memória) ---- */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};

/* ---- Módulo sob teste (importado DEPOIS do stub de localStorage) ---- */
const Auth = await import('../assets/js/auth.js');

const KEY = 'ble-diag-auth';

/** Lê e interpreta o registro bruto salvo no storage. */
function rawRecord() {
  const raw = store.get(KEY);
  return raw ? JSON.parse(raw) : null;
}

beforeEach(() => {
  store.clear();
});

/* ================= Plataforma ================= */

test('isSupported: Web Crypto disponível no contexto de teste', () => {
  assert.equal(Auth.isSupported(), true);
});

/* ================= Estado inicial ================= */

test('hasPin: false sem PIN definido', () => {
  assert.equal(Auth.hasPin(), false);
});

test('verifyPin: false quando não há PIN definido (não lança)', async () => {
  assert.equal(await Auth.verifyPin('1234'), false);
});

/* ================= Validação do PIN ================= */

test('setupPin: rejeita PIN curto (menos de 4 dígitos)', async () => {
  await assert.rejects(() => Auth.setupPin('123'), /4 a 8 dígitos/);
});

test('setupPin: rejeita PIN longo (mais de 8 dígitos)', async () => {
  await assert.rejects(() => Auth.setupPin('123456789'), /4 a 8 dígitos/);
});

test('setupPin: rejeita caracteres não numéricos', async () => {
  await assert.rejects(() => Auth.setupPin('12a4'), /4 a 8 dígitos/);
  await assert.rejects(() => Auth.setupPin('abcd'), /4 a 8 dígitos/);
  await assert.rejects(() => Auth.setupPin('12 4'), /4 a 8 dígitos/);
});

/* ================= Definição e verificação ================= */

test('setupPin: aceita PIN válido de 4 e de 8 dígitos', async () => {
  await Auth.setupPin('1234');
  assert.equal(Auth.hasPin(), true);
  Auth.removePin();
  await Auth.setupPin('12345678');
  assert.equal(Auth.hasPin(), true);
});

test('setupPin: registro salvo é hash PBKDF2 com salt e iterações — nunca o PIN', async () => {
  await Auth.setupPin('1234');
  const raw = store.get(KEY);
  const rec = rawRecord();

  // O PIN em texto puro jamais aparece no storage.
  assert.ok(!raw.includes('1234'), 'PIN vazou em texto puro para o localStorage');

  // Estrutura honesta do registro.
  assert.equal(rec.v, 1);
  assert.equal(rec.iterations, 150000);
  assert.match(rec.salt, /^[0-9a-f]{32}$/); // 16 bytes em hex
  assert.match(rec.hash, /^[0-9a-f]{64}$/);  // SHA-256 em hex
  assert.ok(typeof rec.createdAt === 'string');
});

test('verifyPin: aceita o PIN correto e rejeita o incorreto', async () => {
  await Auth.setupPin('1234');
  assert.equal(await Auth.verifyPin('1234'), true);
  assert.equal(await Auth.verifyPin('1235'), false);
  assert.equal(await Auth.verifyPin('0000'), false);
  assert.equal(await Auth.verifyPin(''), false);
});

test('setupPin: substituir o PIN invalida o anterior', async () => {
  await Auth.setupPin('1234');
  assert.equal(await Auth.verifyPin('1234'), true);
  await Auth.setupPin('5678');
  assert.equal(await Auth.verifyPin('1234'), false);
  assert.equal(await Auth.verifyPin('5678'), true);
});

test('salt aleatório: dois registros do mesmo PIN têm hashes distintos', async () => {
  await Auth.setupPin('1234');
  const first = rawRecord();
  await Auth.setupPin('1234');
  const second = rawRecord();

  assert.notEqual(first.salt, second.salt, 'salt repetido entre registros');
  assert.notEqual(first.hash, second.hash, 'hash idêntico para o mesmo PIN');
  // Ambos os registros continuam verificando o mesmo PIN.
  assert.equal(await Auth.verifyPin('1234'), true);
});

test('PBKDF2: derivação usa custo real (não atalho de hash simples)', async () => {
  await Auth.setupPin('1234');
  const rec = rawRecord();

  // SHA-256("1234") direto ≠ hash derivado com PBKDF2+salt.
  const enc = new TextEncoder();
  const naive = await crypto.subtle.digest('SHA-256', enc.encode('1234'));
  const naiveHex = Array.from(new Uint8Array(naive))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  assert.notEqual(rec.hash, naiveHex, 'hash equivale a SHA-256 sem salt/custo');
});

/* ================= Remoção ================= */

test('removePin: remove o registro e o app volta a abrir sem bloqueio', async () => {
  await Auth.setupPin('1234');
  assert.equal(Auth.removePin(), true);
  assert.equal(Auth.hasPin(), false);
  assert.equal(store.has(KEY), false);
  assert.equal(await Auth.verifyPin('1234'), false);
});

test('removePin: sem PIN definido permanece consistente (idempotente)', () => {
  assert.equal(Auth.removePin(), true);
  assert.equal(Auth.hasPin(), false);
});

/* ================= Robustez (dados corrompidos/adulterados) ================= */

test('registro corrompido: JSON inválido não quebra o módulo', async () => {
  store.set(KEY, '{isto não é json');
  assert.equal(Auth.hasPin(), false);
  assert.equal(await Auth.verifyPin('1234'), false);
});

test('registro incompleto: sem hash/salt é tratado como ausente', async () => {
  store.set(KEY, JSON.stringify({ v: 1, salt: 'ab' }));
  assert.equal(Auth.hasPin(), false);
});

test('adulteração: hash alterado no storage não aceita nenhum PIN', async () => {
  await Auth.setupPin('1234');
  const rec = rawRecord();
  rec.hash = '0'.repeat(64);
  store.set(KEY, JSON.stringify(rec));
  assert.equal(await Auth.verifyPin('1234'), false);
});

test('adulteração: iterações reduzidas no storage continuam verificando (derivação segue o registro)', async () => {
  // A validação deriva com os parâmetros do registro; adulterar iterações
  // reduz custo, mas não faz PIN algum "passar" sem ser o correto.
  await Auth.setupPin('1234');
  const rec = rawRecord();
  rec.iterations = 1;
  store.set(KEY, JSON.stringify(rec));
  assert.equal(await Auth.verifyPin('1235'), false);
});

/* ================= Tempo constante (comparação) ================= */

test('verifyPin: não lança exceção para tipos inesperados de entrada', async () => {
  await Auth.setupPin('1234');
  assert.equal(await Auth.verifyPin('12 4'), false);
  assert.equal(await Auth.verifyPin(undefined), false);
  assert.equal(await Auth.verifyPin(null), false);
});
