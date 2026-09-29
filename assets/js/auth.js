/**
 * auth.js — Bloqueio local de acesso por PIN.
 *
 * HONESTIDADE TÉCNICA (leia antes de alterar):
 * Isto NÃO é autenticação de servidor. A PWA roda em hospedagem estática
 * (GitHub Pages), sem backend; qualquer "login" validado apenas no navegador
 * é trivialmente contornável. O que este módulo oferece é um bloqueio local
 * de acesso ao abrir o aplicativo no dispositivo:
 *
 * - O PIN NUNCA é gravado em texto puro: é derivado com PBKDF2-SHA256,
 *   salt aleatório e 150.000 iterações (Web Crypto — requer HTTPS).
 * - Apenas o { salt, hash, iterações } é salvo no localStorage.
 * - O PIN incorreto não é salvo nem registrado em log.
 *
 * O que este bloqueio NÃO é:
 * - Não criptografa o histórico (IndexedDB permanece legível no aparelho);
 * - Não protege contra alguém com acesso técnico ao dispositivo;
 * - Não substitui autenticação real (backend/Android nativo com OAuth/OIDC).
 *
 * Requisitos de plataforma: crypto.subtle (contexto seguro).
 * Indisponível => o módulo informa, sem simular.
 */

const STORAGE_KEY = 'ble-diag-auth';
const PBKDF2_ITERATIONS = 150000;

/** Web Crypto está disponível neste contexto? (requer HTTPS) */
export function isSupported() {
  return typeof crypto !== 'undefined' &&
    !!crypto.subtle &&
    typeof crypto.subtle.importKey === 'function' &&
    typeof crypto.subtle.deriveBits === 'function';
}

function readRecord() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    return rec && rec.salt && rec.hash ? rec : null;
  } catch {
    return null;
  }
}

/** Existe um PIN de acesso definido neste dispositivo? */
export function hasPin() {
  return readRecord() !== null;
}

/** Salt aleatório (hex), sem depender de randomUUID. */
function randomSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Deriva o hash do PIN: PBKDF2-SHA256, 150.000 iterações. */
async function derive(pin, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS },
    key,
    256
  );
}

/**
 * Define (ou substitui) o PIN de acesso local.
 * Regras: 4 a 8 dígitos numéricos.
 */
export async function setupPin(pin) {
  if (!isSupported()) {
    throw new Error('Crypto API não disponível neste contexto (requer HTTPS) — bloqueio por PIN indisponível.');
  }
  if (!/^\d{4,8}$/.test(pin)) {
    throw new Error('O PIN deve ter de 4 a 8 dígitos numéricos.');
  }
  const salt = randomSalt();
  const hash = toHex(await derive(pin, salt));
  const record = {
    v: 1,
    salt,
    hash,
    iterations: PBKDF2_ITERATIONS,
    createdAt: new Date().toISOString()
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  return true;
}

/**
 * Verifica um PIN informado. Nunca lança para PIN incorreto (retorna false);
 * erros de plataforma (ex.: Crypto indisponível) são lançados com mensagem amigável.
 */
export async function verifyPin(pin) {
  const rec = readRecord();
  if (!rec) return false;
  if (!isSupported()) {
    throw new Error('Crypto API não disponível neste contexto — abra por HTTPS para verificar o PIN.');
  }
  const hash = toHex(await derive(String(pin), rec.salt));
  if (hash.length !== rec.hash.length) return false;
  // Comparação em tempo constante para não vazar o tamanho do prefixo comum.
  let diff = 0;
  for (let i = 0; i < hash.length; i++) {
    diff |= hash.charCodeAt(i) ^ rec.hash.charCodeAt(i);
  }
  return diff === 0;
}

/** Remove o PIN de acesso deste dispositivo (o app abre sem bloqueio). */
export function removePin() {
  localStorage.removeItem(STORAGE_KEY);
  return !hasPin();
}
