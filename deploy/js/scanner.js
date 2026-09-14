/**
 * Câmera + identificação da carta.
 *
 * Caminho principal: a foto vai para a Netlify Function `identify-card`, que
 * usa visão do Claude para transcrever nome/número/set/idioma/variante — texto
 * impresso real, não um palpite sobre "qual Pokémon é esse desenho".
 *
 * Se a função não estiver configurada (sem ANTHROPIC_API_KEY) ou falhar por
 * rede, caímos para OCR local (Tesseract.js) lendo só nome (topo) e número
 * (rodapé) — mais limitado, mas funciona sem backend.
 */

import { AppError, toDataUrl } from './util.js';

const IDENTIFY_ENDPOINT = '/api/identify-card';

export async function identifyViaVision(canvas, { signal } = {}) {
  const dataUrl = toDataUrl(canvas, 1400, 0.85);

  let res;
  try {
    res = await fetch(IDENTIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataUrl }),
      signal,
    });
  } catch {
    throw new AppError('NETWORK', 'Sem conexão com o serviço de leitura.');
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new AppError('UPSTREAM', 'Resposta inválida do serviço de leitura.');
  }

  if (!res.ok || !body.ok) {
    throw new AppError(body.code || `HTTP_${res.status}`, body.error || 'Falha na identificação.');
  }

  return normalizeVisionCard(body.card);
}

function normalizeVisionCard(card) {
  return {
    name: card.name || '',
    number: card.number || '',
    setTotal: card.setTotal || '',
    setName: card.setName || '',
    setCode: card.setCode || '',
    language: card.language && card.language !== 'unknown' ? card.language : '',
    rarityText: card.rarityText || '',
    variantHints: Array.isArray(card.variantHints) ? card.variantHints : [],
    illustrator: card.illustrator || '',
    year: card.year || '',
    hp: card.hp || '',
    confidence: typeof card.confidence === 'number' ? card.confidence : 0,
    readable: card.readable !== false,
    problem: card.problem && card.problem !== 'none' ? card.problem : '',
    source: 'vision',
  };
}

export const PROBLEM_MESSAGES = {
  blurry: 'A foto ficou desfocada. Segure firme e tente de novo.',
  no_card: 'Não encontramos uma carta na imagem.',
  too_dark: 'A imagem está muito escura. Busque mais luz.',
  cropped: 'A carta saiu do enquadramento. Centralize na guia.',
  glare: 'Há reflexo forte sobre a carta. Incline um pouco e tente de novo.',
};

/* ═══════════════════════ Fallback local: Tesseract.js ═══════════════════════ */

let tesseractLoading = null;

function loadTesseract(onProgress) {
  if (window.Tesseract) return Promise.resolve();
  if (tesseractLoading) return tesseractLoading;

  onProgress?.('Carregando leitor local (primeira vez)...');
  tesseractLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@6/dist/tesseract.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new AppError('NETWORK', 'Falha ao carregar o leitor local.'));
    document.head.appendChild(s);
  });
  return tesseractLoading;
}

function cropRect(src, xPct, yPct, wPct, hPct, scale) {
  const sw = src.width, sh = src.height;
  const sx = Math.floor(sw * xPct), sy = Math.floor(sh * yPct);
  const sW = Math.floor(sw * wPct), sH = Math.floor(sh * hPct);
  const c = document.createElement('canvas');
  c.width = Math.round(sW * scale);
  c.height = Math.round(sH * scale);
  c.getContext('2d').drawImage(src, sx, sy, sW, sH, 0, 0, c.width, c.height);
  return c;
}

function enhanceContrast(src) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d');
  ctx.filter = 'contrast(2.5) saturate(0) brightness(1.05)';
  ctx.drawImage(src, 0, 0);
  return c;
}

function fixDigits(s) {
  return s.replace(/[OoQD]/g, '0').replace(/[IilLT|!]/g, '1')
    .replace(/Z/g, '2').replace(/[Ss]/g, '5').replace(/[Gg]/g, '6').replace(/B/g, '8');
}

/** Um único worker reaproveitado entre as chamadas — cada worker novo baixa o modelo de novo. */
let workerPromise = null;
async function getWorker() {
  if (!workerPromise) {
    workerPromise = window.Tesseract.createWorker('eng').catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

async function ocrWith(worker, canvas, whitelist, psm) {
  await worker.setParameters({
    tessedit_pageseg_mode: String(psm),
    tessedit_char_whitelist: whitelist || '',
  });
  const { data } = await worker.recognize(canvas);
  return (data.text || '').trim();
}

export async function identifyViaOcr(canvas, { onProgress } = {}) {
  await loadTesseract(onProgress);
  const worker = await getWorker();

  onProgress?.('Lendo nome...');
  const nameLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz2- ';
  const nameCrop = cropRect(canvas, 0, 0, 1, 0.18, 4);
  let nameRaw = await ocrWith(worker, enhanceContrast(nameCrop), nameLetters, 7);
  if (!nameRaw || nameRaw.replace(/\s/g, '').length < 3) {
    nameRaw = await ocrWith(worker, nameCrop, nameLetters, 6);
  }
  let name = '';
  for (const token of nameRaw.split(/\s+/)) {
    const clean = token.replace(/[^A-Za-z2]/g, '');
    if (clean.length >= 3) { name = clean; break; }
  }

  onProgress?.('Lendo número...');
  const numLetters = '0123456789/';
  const numCrop = cropRect(canvas, 0, 0.85, 1, 0.15, 4);
  let numRaw = fixDigits((await ocrWith(worker, enhanceContrast(numCrop), numLetters, 7)).replace(/\s+/g, ''));
  if (!numRaw.match(/\d/)) {
    numRaw = fixDigits((await ocrWith(worker, numCrop, numLetters, 6)).replace(/\s+/g, ''));
  }
  const numMatch = numRaw.match(/(\d{1,4})\/(\d{1,4})/) || numRaw.match(/(\d{1,4})/);
  const number = numMatch ? numMatch[1] : '';
  const setTotal = numMatch && numMatch[2] ? numMatch[2] : '';

  if (!name && !number) {
    throw new AppError('NOT_READABLE', 'Não foi possível identificar a carta. Tente enquadrar melhor.');
  }

  return {
    name,
    number,
    setTotal,
    setName: '',
    setCode: '',
    language: '',
    rarityText: '',
    variantHints: [],
    illustrator: '',
    year: '',
    hp: '',
    confidence: name && number ? 0.5 : 0.3,
    readable: true,
    problem: '',
    source: 'ocr',
  };
}

/** Tenta visão primeiro; se indisponível (sem chave configurada), cai para OCR local. */
export async function identifyCard(canvas, { onProgress, signal } = {}) {
  onProgress?.('Identificando carta...');
  try {
    return await identifyViaVision(canvas, { signal });
  } catch (err) {
    if (err.code === 'ABORTED') throw err;
    if (err.code !== 'NO_API_KEY' && err.code !== 'NETWORK') throw err;
    // Sem função configurada ou sem rede até o backend: tenta o leitor local.
    return await identifyViaOcr(canvas, { onProgress });
  }
}

/* ═══════════════════════ Câmera ═══════════════════════ */

export async function startCamera(videoEl) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  });
  videoEl.srcObject = stream;
  return stream;
}

export function stopCamera(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

export function captureFrame(videoEl) {
  const canvas = document.createElement('canvas');
  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;
  canvas.getContext('2d').drawImage(videoEl, 0, 0);
  return canvas;
}

export function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new AppError('BAD_IMAGE', 'Não foi possível abrir essa imagem.'));
    };
    img.src = url;
  });
}
