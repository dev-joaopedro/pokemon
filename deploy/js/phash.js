/**
 * pHash (perceptual hash) baseado em DCT — módulo puro, sem dependência de
 * DOM nem de Node, para poder ser importado tanto pelo navegador (scanner
 * ao vivo e Web Worker) quanto pelo script offline `tools/build-phash-db.mjs`
 * que gera o banco pré-computado. Usar o mesmo código nos dois lugares
 * garante que um hash calculado offline é diretamente comparável a um hash
 * calculado ao vivo no celular.
 *
 * Algoritmo (o mesmo da biblioteca de referência `imagehash.phash` em
 * Python/ImageMagick): imagem 32×32 em tons de cinza -> DCT 2D -> os 8×8
 * coeficientes de frequência mais baixa -> 1 bit por coeficiente, comparado
 * à mediana desse bloco.
 */

const HASH_SIZE = 8; // hash final tem HASH_SIZE*HASH_SIZE = 64 bits
export const PHASH_IMG_SIZE = 32; // entrada esperada: PHASH_IMG_SIZE x PHASH_IMG_SIZE em tons de cinza

function dct1d(vec) {
  const N = vec.length;
  const out = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    let sum = 0;
    for (let n = 0; n < N; n++) {
      sum += vec[n] * Math.cos((Math.PI / N) * (n + 0.5) * k);
    }
    out[k] = sum;
  }
  return out;
}

function dct2d(gray, size) {
  const rows = new Float64Array(size * size);
  for (let y = 0; y < size; y++) {
    const row = dct1d(gray.slice(y * size, y * size + size));
    rows.set(row, y * size);
  }
  const out = new Float64Array(size * size);
  const col = new Float64Array(size);
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) col[y] = rows[y * size + x];
    const dctCol = dct1d(col);
    for (let y = 0; y < size; y++) out[y * size + x] = dctCol[y];
  }
  return out;
}

/**
 * Calcula o pHash de uma imagem já em tons de cinza PHASH_IMG_SIZE x
 * PHASH_IMG_SIZE (row-major, valores 0-255). Devolve uma string hex de 16
 * caracteres (64 bits).
 */
export function computePHash(gray) {
  if (gray.length !== PHASH_IMG_SIZE * PHASH_IMG_SIZE) {
    throw new Error(`computePHash espera uma imagem ${PHASH_IMG_SIZE}x${PHASH_IMG_SIZE} em tons de cinza (recebeu ${gray.length} valores).`);
  }

  const dct = dct2d(gray, PHASH_IMG_SIZE);
  const low = [];
  for (let y = 0; y < HASH_SIZE; y++) {
    for (let x = 0; x < HASH_SIZE; x++) low.push(dct[y * PHASH_IMG_SIZE + x]);
  }

  const sorted = [...low].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  const median = sorted.length % 2 ? sorted[mid - 0.5] : (sorted[mid - 1] + sorted[mid]) / 2;

  let bits = 0n;
  for (let i = 0; i < low.length; i++) {
    bits <<= 1n;
    if (low[i] > median) bits |= 1n;
  }
  return bits.toString(16).padStart(16, '0');
}

/** Distância de Hamming entre dois hashes hex de 64 bits. */
export function hammingDistance(hexA, hexB) {
  let x = BigInt('0x' + hexA) ^ BigInt('0x' + hexB);
  let count = 0;
  while (x) {
    x &= x - 1n;
    count++;
  }
  return count;
}

/**
 * Dado um hash e uma lista de candidatos `{ id, hash, ... }`, devolve os mais
 * próximos (menor distância de Hamming primeiro), até `maxDistance` bits de
 * diferença (de 64 possíveis).
 */
export function findClosest(hash, entries, { maxDistance = 12, limit = 5 } = {}) {
  const scored = [];
  for (const entry of entries) {
    if (!entry?.hash) continue;
    const distance = hammingDistance(hash, entry.hash);
    if (distance <= maxDistance) scored.push({ ...entry, distance });
  }
  scored.sort((a, b) => a.distance - b.distance);
  return scored.slice(0, limit);
}
