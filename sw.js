/* =========================================================================
 * sw.js — Service Worker do BLE Diagnostic Scanner
 * Cache-first para a interface, funcionamento offline controlado e
 * versionamento explícito. BLE nunca roda no SW (depende do navegador).
 * ========================================================================= */

const CACHE_VERSION = 'ble-diagnostic-v1.2.0';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/css/styles.css',
  './assets/js/app.js',
  './assets/js/ble.js',
  './assets/js/gatt.js',
  './assets/js/storage.js',
  './assets/js/export.js',
  './assets/js/ui.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/maskable-512.png'
];

/* Instalação: pré-cacheia o app shell da versão atual. */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

/* Ativação: remove caches de versões antigas (atualização controlada). */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* Busca: cache-first apenas para recursos do próprio app.
 * Qualquer outra requisição (não usada por este app) vai à rede.
 * Navegações offline caem no index.html para que o histórico local
 * permaneça consultável; as funções BLE informam a dependência do
 * navegador quando indisponíveis. */
self.addEventListener('fetch', (event) => {
  const req = event.request;

  if (req.method !== 'GET') return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match('./index.html').then((r) => r || Response.error())
      )
    );
    return;
  }

  if (new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((resp) => {
      const copy = resp.clone();
      caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
      return resp;
    }).catch(() => cached || Response.error()))
  );
});

/* Permite que a página pergunte por atualizações do SW. */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
