/**
 * Web Worker: cálculo de pHash e comparação contra o banco de cartas, fora
 * da thread de UI — é o requisito de não travar a tela durante o scan
 * contínuo (o cálculo de DCT + comparação contra centenas/milhares de
 * hashes é barato individualmente, mas rodar isso a cada ~1-2s na thread
 * principal ainda compete com a renderização do overlay da câmera).
 *
 * Duas fontes de hashes são combinadas:
 *  1. `deploy/data/card-hashes.json` — banco pré-computado offline por
 *     `tools/build-phash-db.mjs` a partir das imagens oficiais da TCGdex.
 *     Começa como `[]` neste repositório até alguém rodar o script (ver
 *     README) — não inventamos hashes aqui.
 *  2. Um cache em IndexedDB, alimentado em tempo real pelo próprio app: toda
 *     vez que uma carta é exibida na tela de detalhe, `app.js` manda
 *     aprender o hash da imagem oficial daquela carta (nunca da foto tirada
 *     pela câmera). Isso faz o banco crescer organicamente com o uso real,
 *     sem depender só do script offline.
 */

import { computePHash, findClosest } from './phash.js';

const DB_URL = new URL('../data/card-hashes.json', import.meta.url);
const IDB_NAME = 'pkmn_phash_cache';
const IDB_STORE = 'cards';

let dbLoadPromise = null;
function loadPrecomputedDb() {
  if (!dbLoadPromise) {
    dbLoadPromise = fetch(DB_URL)
      .then((res) => (res.ok ? res.json() : []))
      .then((list) => (Array.isArray(list) ? list : []))
      .catch(() => []);
  }
  return dbLoadPromise;
}

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readCacheEntries() {
  try {
    const db = await openIdb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return []; // IndexedDB indisponível (ex.: navegação privada) — segue só com o banco offline.
  }
}

async function writeCacheEntry(entry) {
  try {
    const db = await openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* best-effort: não aprender agora não deve quebrar o scan. */
  }
}

self.onmessage = async (ev) => {
  const { type, requestId, gray } = ev.data || {};
  if (!type) return;

  if (type === 'match') {
    try {
      const hash = computePHash(gray);
      const [precomputed, cached] = await Promise.all([loadPrecomputedDb(), readCacheEntries()]);
      const matches = findClosest(hash, [...precomputed, ...cached], {
        maxDistance: ev.data.maxDistance ?? 12,
        limit: ev.data.limit ?? 5,
      });
      self.postMessage({ type: 'match-result', requestId, hash, matches });
    } catch (err) {
      self.postMessage({ type: 'match-result', requestId, hash: null, matches: [], error: String(err) });
    }
    return;
  }

  if (type === 'learn') {
    try {
      const hash = computePHash(gray);
      const { card } = ev.data;
      await writeCacheEntry({ id: card.id, hash, name: card.name || '', number: card.number || '', setId: card.setId || '' });
      self.postMessage({ type: 'learn-result', requestId, ok: true });
    } catch (err) {
      self.postMessage({ type: 'learn-result', requestId, ok: false, error: String(err) });
    }
  }
};
