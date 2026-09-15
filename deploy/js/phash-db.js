/**
 * Wrapper da thread principal para o Web Worker de pHash (`phash-worker.js`).
 * Mantém um único worker vivo enquanto o app está aberto e correlaciona
 * respostas por `requestId` — a UI só chama `matchCardImage()`/`learnCard()`
 * e recebe uma Promise, sem lidar com `postMessage` diretamente.
 */

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./phash-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const { requestId } = ev.data || {};
      const resolve = pending.get(requestId);
      if (resolve) {
        pending.delete(requestId);
        resolve(ev.data);
      }
    };
  }
  return worker;
}

function call(type, payload) {
  return new Promise((resolve) => {
    const requestId = ++seq;
    pending.set(requestId, resolve);
    getWorker().postMessage({ type, requestId, ...payload });
  });
}

/**
 * Compara o hash de `gray` (array 32x32 de tons de cinza) contra o banco
 * pré-computado + o cache aprendido. Devolve os candidatos mais próximos,
 * ordenados por distância de Hamming (menor = mais parecido).
 */
export async function matchCardImage(gray, opts = {}) {
  const res = await call('match', { gray: Array.from(gray), ...opts });
  return res.matches || [];
}

/** Ensina o worker o hash da imagem oficial de uma carta já confirmada. */
export function learnCard(gray, card) {
  return call('learn', { gray: Array.from(gray), card });
}
