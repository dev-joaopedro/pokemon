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
    // Qualquer falha em obter um resultado de visão utilizável — sem chave
    // configurada, sem rede, erro do servidor, recusa do modelo, rate limit —
    // degrada para o leitor local em vez de deixar o usuário sem alternativa.
    // A única exceção é o cancelamento explícito do próprio usuário (acima).
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

/* ═══════════════════════ Detecção automática (scanner ao vivo) ═══════════════════════
 *
 * Uma carta não tem chip nem código de barras — "escanear" uma carta física
 * só pode significar capturar uma imagem dela e analisá-la. O que dá a
 * sensação de "scanner" em vez de "foto" é não precisar apertar um botão: o
 * app acompanha o contorno da carta em tempo real (OpenCV.js) e só dispara
 * uma leitura de verdade (OCR local, com fallback de pHash) quando esse
 * contorno fica parado por alguns frames seguidos — sem isso, cada tremida
 * de mão geraria uma tentativa de leitura cara e inútil.
 *
 * Os limiares (AUTO_SCAN_THRESHOLDS) foram escolhidos por raciocínio, não
 * calibrados contra uma câmera real — este ambiente de desenvolvimento não
 * tem acesso a uma câmera física. Ajuste-os se, em uso real, o app disparar
 * leituras cedo demais ou tarde demais.
 */

/** Frame reduzido em tons de cinza — usado como verificação barata de nitidez. */
export function grabTinyGray(source, size = 40) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  const gray = new Float32Array(size * size);
  for (let i = 0; i < gray.length; i++) {
    const o = i * 4;
    gray[i] = data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;
  }
  return gray;
}

/** Energia de borda aproximada — baixo valor indica imagem fora de foco. */
export function frameSharpness(gray, size = 40) {
  let sum = 0;
  let n = 0;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const i = y * size + x;
      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[i + size] - gray[i - size];
      sum += gx * gx + gy * gy;
      n++;
    }
  }
  return n ? sum / n : 0;
}

export const AUTO_SCAN_THRESHOLDS = {
  /** Intervalo entre tentativas de detecção de contorno (pedido: 300-500ms). */
  checkIntervalMs: 400,
  /** Maior lado do frame reduzido usado na detecção de contorno (custo de OpenCV). */
  detectMaxDim: 320,
  /** Contorno precisa ocupar ao menos essa fração da área do frame reduzido p/ ser considerado a carta. */
  minQuadAreaFraction: 0.15,
  /** Detecções consecutivas "paradas" exigidas antes de identificar a carta. */
  stableFramesNeeded: 4,
  /** Deslocamento máx. do centro do contorno (fração da maior dimensão do frame) entre checagens p/ considerar "parado". */
  centroidEpsFraction: 0.025,
  /** Variação máx. de área do contorno entre checagens p/ considerar "parado". */
  areaRatioEpsFraction: 0.12,
  /** Tamanho do recorte endireitado (warp de perspectiva) usado para OCR/pHash. */
  warpWidth: 300,
  warpHeight: 420,
  /** Nitidez mínima do recorte já endireitado, abaixo disso não vale a pena tentar ler. */
  sharpnessMin: 450,
  /** Tempo mínimo entre duas identificações completas (OCR local + pHash). */
  attemptCooldownMs: 1800,
  /** Tentativas reais seguidas sem sucesso antes de pausar e pedir ação manual. */
  maxConsecutiveFails: 6,
  /** Distância de Hamming máxima (de 64 bits) para aceitar um candidato de pHash. */
  phashMaxDistance: 10,
};

/* ═══════════════════════ OpenCV.js: contorno + warp de perspectiva ═══════════════════════
 *
 * Carregado sob demanda (só quando o scanner abre), como o Tesseract.js —
 * são ~10MB de WASM, não faz sentido puxar isso no carregamento inicial do
 * app. Build oficial do próprio projeto OpenCV (docs.opencv.org), a mesma
 * usada nos tutoriais de opencv.js.
 */

let opencvLoading = null;

export function loadOpenCv(onProgress) {
  if (window.cv?.Mat) return Promise.resolve();
  if (opencvLoading) return opencvLoading;

  onProgress?.('Carregando detector de contorno (primeira vez)...');
  opencvLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://docs.opencv.org/4.9.0/opencv.js';
    s.onerror = () => {
      opencvLoading = null;
      reject(new AppError('NETWORK', 'Falha ao carregar o detector de contorno.'));
    };
    s.onload = () => {
      if (window.cv?.Mat) {
        resolve();
      } else if (window.cv) {
        window.cv['onRuntimeInitialized'] = resolve;
      } else {
        opencvLoading = null;
        reject(new AppError('NETWORK', 'Detector de contorno indisponível.'));
      }
    };
    document.head.appendChild(s);
  });
  return opencvLoading;
}

/** Ordena 4 pontos quaisquer como [topo-esq, topo-dir, baixo-dir, baixo-esq]. */
export function orderQuadPoints(pts) {
  const bySum = [...pts].sort((a, b) => a.x + a.y - (b.x + b.y));
  const tl = bySum[0];
  const br = bySum[3];
  const byDiff = [...pts].sort((a, b) => a.x - a.y - (b.x - b.y));
  const bl = byDiff[0];
  const tr = byDiff[3];
  return [tl, tr, br, bl];
}

/**
 * Detecta o maior contorno quadrilátero convexo num canvas (bordas via Canny
 * + approxPolyDP). Devolve `{ points, areaFraction }` no sistema de
 * coordenadas do próprio canvas, ou `null` se nenhum quadrilátero plausível
 * foi encontrado.
 */
export function detectCardQuad(cv, canvas) {
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const dilated = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, 50, 150);
    cv.dilate(edges, dilated, kernel);
    cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const frameArea = canvas.width * canvas.height;
    let best = null;
    let bestArea = 0;

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const area = Math.abs(cv.contourArea(approx));
        if (area > bestArea && area / frameArea > 0.05) {
          bestArea = area;
          const pts = [];
          for (let p = 0; p < 4; p++) {
            pts.push({ x: approx.data32S[p * 2], y: approx.data32S[p * 2 + 1] });
          }
          best = pts;
        }
      }
      approx.delete();
      cnt.delete();
    }

    return best ? { points: orderQuadPoints(best), areaFraction: bestArea / frameArea } : null;
  } finally {
    src.delete();
    gray.delete();
    blurred.delete();
    edges.delete();
    dilated.delete();
    contours.delete();
    hierarchy.delete();
    kernel.delete();
  }
}

/** Reposiciona os 4 pontos de um quad de um sistema de coordenadas para outro (mesma proporção). */
export function scaleQuadPoints(points, sx, sy) {
  return points.map((p) => ({ x: p.x * sx, y: p.y * sy }));
}

function quadCentroid(points) {
  const x = points.reduce((s, p) => s + p.x, 0) / points.length;
  const y = points.reduce((s, p) => s + p.y, 0) / points.length;
  return { x, y };
}

/** Dois quads consecutivos estão "parados" o bastante para valer a pena identificar a carta? */
export function quadsAreStable(prev, curr, frameMaxDim, { centroidEpsFraction, areaRatioEpsFraction }) {
  if (!prev || !curr) return false;
  const a = quadCentroid(prev.points);
  const b = quadCentroid(curr.points);
  const centroidDist = Math.hypot(a.x - b.x, a.y - b.y);
  if (centroidDist / frameMaxDim > centroidEpsFraction) return false;
  const ratio = prev.areaFraction > 0 ? curr.areaFraction / prev.areaFraction : 0;
  return ratio > 1 - areaRatioEpsFraction && ratio < 1 + areaRatioEpsFraction;
}

/** Aplica o warp de perspectiva: endireita o quadrilátero detectado num retângulo outW x outH. */
export function warpCardPerspective(cv, sourceCanvas, quadPoints, outW, outH) {
  const src = cv.imread(sourceCanvas);
  const dst = new cv.Mat();
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, quadPoints.flatMap((p) => [p.x, p.y]));
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW, 0, outW, outH, 0, outH]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);

  try {
    cv.warpPerspective(src, dst, M, new cv.Size(outW, outH));
    const outCanvas = document.createElement('canvas');
    outCanvas.width = outW;
    outCanvas.height = outH;
    cv.imshow(outCanvas, dst);
    return outCanvas;
  } finally {
    src.delete();
    dst.delete();
    srcTri.delete();
    dstTri.delete();
    M.delete();
  }
}

/** Reduz um canvas/imagem/vídeo a uma grade 32x32 em tons de cinza — entrada do pHash. */
export function grayscale32(source) {
  const size = 32;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  const out = new Float64Array(size * size);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    out[i] = data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;
  }
  return out;
}

/** Carrega uma imagem por URL (com CORS anônimo — necessário p/ ler pixels de imagens da TCGdex). */
export function loadImageUrl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new AppError('NETWORK', 'Falha ao carregar imagem da carta.'));
    img.src = url;
  });
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
