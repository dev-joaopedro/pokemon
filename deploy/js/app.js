import { $, $$, escHtml, debounce, friendlyError, formatDate } from './util.js';
import {
  LANGUAGES, DEFAULT_LANG, getCard, getCardEnriched, getCardYear, searchByName, searchByNumber,
  resolveReading, cardImage, setIdFromCardId,
} from './tcgdex.js';
import { CURRENCIES, DEFAULT_CURRENCY, getCardPrice, listPricedVariants, formatMoney, priceHistoryFromCardmarket } from './pricing.js';
import * as Collection from './collection.js';
import { getCardInLanguage } from './translate.js';
import {
  identifyCard, identifyViaOcr, startCamera, stopCamera, captureFrame, loadImageFile, loadImageUrl,
  PROBLEM_MESSAGES, grabTinyGray, frameSharpness, AUTO_SCAN_THRESHOLDS,
  loadOpenCv, detectCardQuad, warpCardPerspective, scaleQuadPoints, quadsAreStable, grayscale32,
} from './scanner.js';
import { matchCardImage, learnCard } from './phash-db.js';

/* ═══════════════════════════ Estado global ═══════════════════════════ */

const state = {
  view: 'dashboard',
  lang: localStorage.getItem('pkmn_lang') || DEFAULT_LANG,
  currency: localStorage.getItem('pkmn_currency') || DEFAULT_CURRENCY,
  candidates: [],
  currentCard: null,
  currentReading: null,
  camStream: null,
  searchAbort: null,
};

function setLang(lang) {
  state.lang = lang;
  localStorage.setItem('pkmn_lang', lang);
}
function setCurrency(ccy) {
  state.currency = ccy;
  localStorage.setItem('pkmn_currency', ccy);
}

/* ═══════════════════════════ Navegação ═══════════════════════════ */

function showView(name) {
  state.view = name;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  if (name === 'dashboard') renderDashboard();
  if (name === 'collection') renderCollection();
  if (name === 'search') renderSearch();
}

$$('.nav-item[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

/* ═══════════════════════════ Topbar: moeda + idioma ═══════════════════════════ */

function renderTopbarSelectors() {
  const ccySel = $('#currency-select');
  ccySel.innerHTML = CURRENCIES.map(
    (c) => `<option value="${c.code}" ${c.code === state.currency ? 'selected' : ''}>${c.code} — ${escHtml(c.symbol)}</option>`,
  ).join('');
  ccySel.addEventListener('change', () => {
    setCurrency(ccySel.value);
    if (state.view === 'dashboard') renderDashboard();
    if (state.view === 'collection') renderCollection();
    if (state.view === 'detail' && state.currentCard) renderPriceBlock();
  });

  const langSel = $('#lang-select');
  langSel.innerHTML = LANGUAGES.map(
    (l) => `<option value="${l.code}" ${l.code === state.lang ? 'selected' : ''}>${l.flag} ${escHtml(l.label)}</option>`,
  ).join('');
  langSel.addEventListener('change', () => {
    setLang(langSel.value);
    if (state.view === 'detail' && state.currentCard) loadCardDetail(state.currentCard.id, { reading: state.currentReading });
  });
}

/* ═══════════════════════════ Toast ═══════════════════════════ */

let toastTimer = null;
function toast(msg, kind = 'ok') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ═══════════════════════════ Dashboard ═══════════════════════════ */

function renderDashboard() {
  const items = Collection.listItems();
  const stats = Collection.getStats(items);

  $('#dash-total-value').textContent = formatMoney(stats.totalValue, state.currency) ?? '—';
  $('#dash-total-cards').textContent = stats.totalCards;
  $('#dash-distinct-cards').textContent = stats.distinctCards;
  $('#dash-most-valuable').textContent = stats.mostValuable
    ? `${stats.mostValuable.name} — ${formatMoney(stats.mostValuableValue, state.currency) ?? '—'}`
    : 'Nenhuma carta ainda';

  const recent = [...items].sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt)).slice(0, 6);
  const recentEl = $('#dash-recent');
  if (!recent.length) {
    recentEl.innerHTML = `<p class="empty-hint">Sua coleção está vazia. Escaneie sua primeira carta! 🎴</p>`;
  } else {
    recentEl.innerHTML = recent.map(itemCardHtml).join('');
    $$('#dash-recent .item-card').forEach((el) => {
      el.addEventListener('click', () => openItemDetail(el.dataset.id));
    });
  }
}

function itemCardHtml(item) {
  return `
    <div class="item-card" data-id="${escHtml(item.id)}">
      <img src="${escHtml(item.imageUrl || '')}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"/>
      <div class="item-card-info">
        <div class="item-card-name">${escHtml(item.name)}</div>
        <div class="item-card-meta">${escHtml(item.setName || '')} · #${escHtml(item.number || '?')}</div>
        <div class="item-card-meta muted">${escHtml(Collection.CONDITIONS.find((c) => c.code === item.condition)?.label || item.condition)} · ×${item.quantity}</div>
      </div>
      <div class="item-card-value">${formatMoney(Collection.itemTotal(item), item.currency || state.currency) ?? '—'}</div>
    </div>`;
}

async function openItemDetail(itemId) {
  const item = Collection.getItem(itemId);
  if (!item) return;
  await loadCardDetail(item.cardId, { fromCollectionItem: item });
  showView('detail');
}

$('#btn-scan-dashboard').addEventListener('click', openScanner);
$('#btn-scan-fab').addEventListener('click', openScanner);
$('#btn-search-shortcut').addEventListener('click', () => showView('search'));

/* ═══════════════════════════ Busca manual ═══════════════════════════ */

function renderSearch() {
  $('#search-results').innerHTML = '';
  $('#search-status').textContent = '';
}

const searchInput = $('#search-input');
const runManualSearch = debounce(async () => {
  const raw = searchInput.value.trim();
  const statusEl = $('#search-status');
  const resultsEl = $('#search-results');

  state.searchAbort?.abort();
  if (!raw) { statusEl.textContent = ''; resultsEl.innerHTML = ''; return; }

  const ctrl = new AbortController();
  state.searchAbort = ctrl;

  statusEl.textContent = 'Buscando...';
  resultsEl.innerHTML = skeletonRows(4);

  const looksLikeNumber = /^[A-Za-z]{0,4}\d+[A-Za-z]?(\s*\/\s*\d+)?$/.test(raw);

  try {
    const found = looksLikeNumber
      ? await searchByNumber(raw, state.lang, { signal: ctrl.signal })
      : await searchByName(raw, state.lang, { signal: ctrl.signal });

    if (ctrl.signal.aborted) return;

    if (!found.length) {
      statusEl.textContent = 'Nenhuma carta encontrada.';
      resultsEl.innerHTML = '';
      return;
    }
    statusEl.textContent = `${found.length} carta(s) encontrada(s):`;
    resultsEl.innerHTML = found.slice(0, 40).map(candidateHtml).join('');
    $$('#search-results .candidate').forEach((el) => {
      el.addEventListener('click', async () => {
        await loadCardDetail(el.dataset.id);
        showView('detail');
      });
    });
  } catch (err) {
    if (err.code === 'ABORTED') return;
    statusEl.textContent = friendlyError(err);
    resultsEl.innerHTML = '';
  }
}, 450);

searchInput.addEventListener('input', runManualSearch);

function skeletonRows(n) {
  return Array.from({ length: n }, () => `<div class="skeleton-row"><div class="skeleton-thumb"></div><div class="skeleton-lines"><div class="skeleton-line w70"></div><div class="skeleton-line w40"></div></div></div>`).join('');
}

function candidateHtml(card) {
  const setName = card.set?.name || setIdFromCardId(card.id);
  return `
    <div class="candidate" data-id="${escHtml(card.id)}">
      <img src="${escHtml(cardImage(card, 'low'))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"/>
      <div class="candidate-info">
        <div class="candidate-name">${escHtml(card.name || '')}</div>
        <div class="candidate-set">${escHtml(setName)} — #${escHtml(String(card.localId ?? ''))}</div>
      </div>
    </div>`;
}

/* ═══════════════════════════ Scanner (câmera) ═══════════════════════════ */

const scanModal = $('#scan-modal');
const camVideo = $('#camera-video');
const contourCanvas = $('#contour-canvas');
const ocrOverlay = $('#ocr-overlay');
const ocrMsg = $('#ocr-msg');
const noCamNotice = $('#no-camera-notice');
const scanOverlay = $('#scan-overlay');
const captureBtn = $('#capture-btn');
const fileInput = $('#file-input');
const autoStatusEl = $('#auto-status');
const scanHintEl = $('#scan-hint');
const toggleAutoBtn = $('#toggle-auto');

let autoScanEnabled = true; // preferência do usuário nesta sessão (chip "Auto")
let autoScanTimer = null;
let autoScanBusy = false; // uma leitura real (OCR/pHash) está em andamento
let autoScanFails = 0;
let autoScanLastAttemptAt = 0;
let autoScanPausedForManual = false; // pausado após muitas falhas seguidas

let cvReady = false;
let cvLoadFailed = false;
let lastQuadDetection = null; // { points, areaFraction }, coordenadas do canvas de detecção
let stableStreak = 0;
let detectCanvasEl = null;
let lastWarpedCanvas = null; // reaproveitado pelo botão "Capturar" se muito recente
let lastWarpedAt = 0;

async function openScanner() {
  scanModal.classList.add('open');
  ocrOverlay.classList.remove('show');
  noCamNotice.classList.remove('show');
  scanOverlay.style.display = '';
  captureBtn.style.display = '';
  camVideo.style.display = '';
  toggleAutoBtn.style.display = '';
  $('#scan-title').textContent = '📷 Escanear carta';
  scanHintEl.innerHTML = 'Aponte a câmera para a carta<br>a detecção é automática';
  autoStatusEl.textContent = '';
  resetAutoScanState();
  clearContourOverlay();

  loadOpenCv((msg) => { if (!cvReady) autoStatusEl.textContent = msg; })
    .then(() => { cvReady = true; })
    .catch(() => {
      cvLoadFailed = true;
      autoStatusEl.textContent = '⚠️ Detecção automática indisponível nesta rede. Use "Capturar".';
    });

  try {
    state.camStream = await startCamera(camVideo);
    if (autoScanEnabled) startAutoScan();
  } catch {
    camVideo.style.display = 'none';
    scanOverlay.style.display = 'none';
    captureBtn.style.display = 'none';
    toggleAutoBtn.style.display = 'none';
    noCamNotice.classList.add('show');
    $('#scan-title').textContent = '📁 Escolha uma foto da carta';
  }
}

function closeScanner() {
  scanModal.classList.remove('open');
  stopAutoScan();
  if (state.camStream) { stopCamera(state.camStream); state.camStream = null; }
  camVideo.srcObject = null;
  ocrOverlay.classList.remove('show');
  clearContourOverlay();
}

$('#close-scan').addEventListener('click', closeScanner);

captureBtn.addEventListener('click', () => {
  if (!camVideo.videoWidth) return;
  // Se um recorte já endireitado (warp) de menos de 1.5s atrás está disponível,
  // usa ele — é um enquadramento melhor que o frame cru para OCR/visão.
  const fresh = lastWarpedCanvas && Date.now() - lastWarpedAt < 1500;
  handleCapturedCanvas(fresh ? lastWarpedCanvas : captureFrame(camVideo), { silent: false });
});

toggleAutoBtn.addEventListener('click', () => {
  // Depois de muitas falhas seguidas o loop se pausa sozinho mas
  // autoScanEnabled continua true (a preferência do usuário não mudou) — sem
  // este caso especial, tocar no botão para "tentar de novo" (como o texto de
  // dica instrui) seria interpretado como "desligar", que é o oposto do que
  // o usuário pediu.
  if (autoScanPausedForManual) {
    resetAutoScanState();
    autoScanEnabled = true;
    updateAutoToggleUI();
    startAutoScan();
    return;
  }

  autoScanEnabled = !autoScanEnabled;
  updateAutoToggleUI();
  if (autoScanEnabled) {
    resetAutoScanState();
    startAutoScan();
  } else {
    stopAutoScan();
    autoStatusEl.textContent = '';
  }
});

function updateAutoToggleUI() {
  toggleAutoBtn.classList.toggle('active', autoScanEnabled);
  toggleAutoBtn.textContent = autoScanEnabled ? '🔄 Auto' : '⏸ Manual';
}
updateAutoToggleUI();

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  fileInput.value = '';
  if (!file) return;
  if (file.size > 15 * 1024 * 1024) {
    toast('Imagem muito grande (máx. 15 MB).', 'error');
    return;
  }
  try {
    handleCapturedCanvas(await loadImageFile(file), { silent: false });
  } catch (err) {
    toast(friendlyError(err), 'error');
  }
});

/* ── Loop de detecção automática ──────────────────────────────────────────
 * A cada AUTO_SCAN_THRESHOLDS.checkIntervalMs, roda a detecção de contorno
 * (OpenCV.js) sobre um frame reduzido e desenha o quadrilátero encontrado no
 * overlay em tempo real. Só dispara uma leitura de verdade (OCR local, com
 * fallback de pHash) quando esse contorno fica parado por algumas
 * verificações seguidas. Isso é o que faz a experiência parecer um scanner
 * de código de barras em vez de "tirar foto e esperar".
 */
function resetAutoScanState() {
  lastQuadDetection = null;
  stableStreak = 0;
  autoScanFails = 0;
  autoScanLastAttemptAt = 0;
  autoScanPausedForManual = false;
  lastWarpedCanvas = null;
  lastWarpedAt = 0;
}

function startAutoScan() {
  stopAutoScan();
  autoStatusEl.textContent = '🔍 Procurando carta...';
  autoScanTimer = setInterval(autoScanTick, AUTO_SCAN_THRESHOLDS.checkIntervalMs);
}

function stopAutoScan() {
  if (autoScanTimer) { clearInterval(autoScanTimer); autoScanTimer = null; }
}

function getDetectCanvas() {
  if (!detectCanvasEl) detectCanvasEl = document.createElement('canvas');
  return detectCanvasEl;
}

function drawVideoToCanvas(video, canvas, maxDim) {
  const scale = maxDim / Math.max(video.videoWidth, video.videoHeight);
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
}

function clearContourOverlay() {
  if (!contourCanvas) return;
  contourCanvas.getContext('2d').clearRect(0, 0, contourCanvas.width, contourCanvas.height);
}

/** Mapeia o retângulo do vídeo (resolução intrínseca) para a caixa exibida, respeitando object-fit:cover. */
function videoDisplayRect() {
  const vw = camVideo.videoWidth, vh = camVideo.videoHeight;
  const cw = camVideo.clientWidth, ch = camVideo.clientHeight;
  if (!vw || !vh || !cw || !ch) return null;
  const videoRatio = vw / vh, boxRatio = cw / ch;
  let drawW, drawH, offX, offY;
  if (videoRatio > boxRatio) {
    drawH = ch; drawW = ch * videoRatio; offX = (cw - drawW) / 2; offY = 0;
  } else {
    drawW = cw; drawH = cw / videoRatio; offX = 0; offY = (ch - drawH) / 2;
  }
  return { vw, vh, drawW, drawH, offX, offY };
}

function drawContourOverlay(quad, detectCanvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = camVideo.clientWidth, h = camVideo.clientHeight;
  if (contourCanvas.width !== Math.round(w * dpr) || contourCanvas.height !== Math.round(h * dpr)) {
    contourCanvas.width = Math.round(w * dpr);
    contourCanvas.height = Math.round(h * dpr);
  }
  const ctx = contourCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!quad) return;

  const rect = videoDisplayRect();
  if (!rect) return;

  const pts = quad.points.map((p) => ({
    x: rect.offX + (p.x / detectCanvas.width) * rect.drawW,
    y: rect.offY + (p.y / detectCanvas.height) * rect.drawH,
  }));

  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.lineWidth = 3;
  ctx.strokeStyle = stableStreak >= AUTO_SCAN_THRESHOLDS.stableFramesNeeded ? '#4ade80' : '#f7c948';
  ctx.stroke();
}

function autoScanTick() {
  if (autoScanBusy || autoScanPausedForManual || !camVideo.videoWidth) return;

  if (!cvReady) {
    autoStatusEl.textContent = cvLoadFailed
      ? '⚠️ Detecção automática indisponível. Use "Capturar".'
      : '⏳ Carregando detector de contorno...';
    return;
  }

  const detectCanvas = getDetectCanvas();
  drawVideoToCanvas(camVideo, detectCanvas, AUTO_SCAN_THRESHOLDS.detectMaxDim);

  let quad = null;
  try {
    quad = detectCardQuad(window.cv, detectCanvas);
  } catch {
    quad = null;
  }

  if (!quad || quad.areaFraction < AUTO_SCAN_THRESHOLDS.minQuadAreaFraction) {
    lastQuadDetection = null;
    stableStreak = 0;
    drawContourOverlay(null, detectCanvas);
    autoStatusEl.textContent = '🔍 Procurando carta...';
    return;
  }

  const stable = quadsAreStable(
    lastQuadDetection, quad, Math.max(detectCanvas.width, detectCanvas.height), AUTO_SCAN_THRESHOLDS,
  );
  stableStreak = stable ? stableStreak + 1 : 1;
  lastQuadDetection = quad;

  drawContourOverlay(quad, detectCanvas);
  autoStatusEl.textContent = stableStreak >= AUTO_SCAN_THRESHOLDS.stableFramesNeeded
    ? '✨ Lendo...'
    : '📌 Mantendo o foco...';

  const cooldownElapsed = Date.now() - autoScanLastAttemptAt > AUTO_SCAN_THRESHOLDS.attemptCooldownMs;
  if (stableStreak >= AUTO_SCAN_THRESHOLDS.stableFramesNeeded && cooldownElapsed) {
    stableStreak = 0;
    autoScanLastAttemptAt = Date.now();
    runAutoIdentify(quad, detectCanvas);
  }
}

/**
 * Dispara quando o contorno da carta fica estável: endireita a carta (warp
 * de perspectiva) a partir do frame em resolução plena, tenta OCR local
 * sobre esse recorte (fast path) e, se não der certo, cai para pHash contra
 * o banco de imagens conhecidas (fallback). Nunca chama a visão paga (Claude)
 * automaticamente — isso só acontece no botão manual "Capturar", uma ação
 * deliberada do usuário.
 */
async function runAutoIdentify(quad, detectCanvas) {
  autoScanBusy = true;
  try {
    const fullFrame = captureFrame(camVideo);
    const sx = fullFrame.width / detectCanvas.width;
    const sy = fullFrame.height / detectCanvas.height;
    const fullQuad = scaleQuadPoints(quad.points, sx, sy);

    let warped;
    try {
      warped = warpCardPerspective(
        window.cv, fullFrame, fullQuad, AUTO_SCAN_THRESHOLDS.warpWidth, AUTO_SCAN_THRESHOLDS.warpHeight,
      );
    } catch {
      registerAutoScanFailure();
      return;
    }
    lastWarpedCanvas = warped;
    lastWarpedAt = Date.now();

    const sharp = frameSharpness(grabTinyGray(warped, 40));
    if (sharp < AUTO_SCAN_THRESHOLDS.sharpnessMin) {
      autoStatusEl.textContent = '🔍 Aproxime e segure firme...';
      registerAutoScanFailure();
      return;
    }

    autoStatusEl.textContent = '🔤 Lendo código da carta...';
    let reading = null;
    try {
      reading = await identifyViaOcr(warped, { onProgress: (m) => { autoStatusEl.textContent = m; } });
    } catch {
      reading = null;
    }

    if (reading && (reading.name || reading.number)) {
      stopAutoScan();
      closeScanner();
      await handleReading(reading);
      return;
    }

    autoStatusEl.textContent = '🧬 Comparando imagem com o banco de cartas...';
    const gray = grayscale32(warped);
    const matches = await matchCardImage(gray, { maxDistance: AUTO_SCAN_THRESHOLDS.phashMaxDistance, limit: 3 });
    const best = matches[0];

    if (best) {
      const card = await getCard(best.id, state.lang).catch(() => null);
      if (card) {
        stopAutoScan();
        closeScanner();
        await handleDirectMatch(card, {
          name: card.name || '',
          number: card.localId ? String(card.localId) : '',
          setTotal: '', setName: '', setCode: '', language: '', rarityText: '',
          variantHints: [], illustrator: '', year: '', hp: '',
          confidence: 0.55, readable: true, problem: '', source: 'phash',
        });
        return;
      }
    }

    registerAutoScanFailure();
  } finally {
    autoScanBusy = false;
  }
}

/** Mostra a tela de confirmação direto para uma carta já identificada por id (pHash) — sem busca por nome/número. */
async function handleDirectMatch(card, reading) {
  showView('confirm');
  state.candidates = [card];
  state.currentReading = reading;
  $('#confirm-read-summary').innerHTML =
    '<div class="read-summary">🧬 Encontramos uma carta parecida pela imagem — confira se é a sua:</div>';
  $('#confirm-status').textContent = '1 carta encontrada por correspondência de imagem:';
  $('#confirm-list').innerHTML = candidateHtml(card);
  $$('#confirm-list .candidate').forEach((el) => {
    el.addEventListener('click', async () => {
      await loadCardDetail(card.id, { reading });
      showView('detail');
    });
  });
}

/**
 * Alimenta o cache local de pHash (IndexedDB, dentro do worker) com o hash
 * da imagem OFICIAL da carta — nunca da foto tirada pela câmera. Roda em
 * segundo plano, sem bloquear a tela de detalhe, toda vez que uma carta é
 * exibida: é assim que o banco de correspondência por imagem cresce com o
 * uso real do app, sem depender só do script offline de pré-cálculo.
 */
async function learnCardHashInBackground(card) {
  try {
    const url = cardImage(card, 'low');
    if (!url) return;
    const img = await loadImageUrl(url);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    const gray = grayscale32(c);
    await learnCard(gray, { id: card.id, name: card.name || '', number: card.localId ? String(card.localId) : '', setId: card.set?.id || '' });
  } catch {
    /* aprendizado é best-effort — nunca deve afetar a experiência principal. */
  }
}

async function handleCapturedCanvas(canvas, { silent = false } = {}) {
  autoScanBusy = true;
  if (!silent) {
    ocrOverlay.classList.add('show');
    ocrMsg.textContent = 'Identificando carta...';
  }

  const timeoutGuard = setTimeout(() => {
    // Nunca deixamos o usuário preso numa tela de carregamento infinita.
    if (!silent) ocrMsg.textContent = 'Isso está demorando mais que o normal...';
  }, 12000);

  try {
    const reading = await identifyCard(canvas, {
      onProgress: (msg) => { if (!silent) ocrMsg.textContent = msg; },
    });
    clearTimeout(timeoutGuard);
    if (!silent) ocrOverlay.classList.remove('show');

    const usable = reading.name || reading.number;
    const hasProblem = reading.problem && PROBLEM_MESSAGES[reading.problem];

    if (!usable || hasProblem) {
      autoScanBusy = false;
      if (!silent) {
        toast(
          hasProblem ? PROBLEM_MESSAGES[reading.problem] : 'Não conseguimos ler a carta. Tente melhorar o enquadramento e a luz.',
          'error',
        );
      } else {
        registerAutoScanFailure();
      }
      return;
    }

    stopAutoScan();
    closeScanner();
    await handleReading(reading);
  } catch (err) {
    clearTimeout(timeoutGuard);
    autoScanBusy = false;
    if (!silent) {
      ocrOverlay.classList.remove('show');
      toast(friendlyError(err), 'error');
    } else {
      registerAutoScanFailure();
    }
    return;
  }
  autoScanBusy = false;
}

function registerAutoScanFailure() {
  autoScanFails++;
  if (autoScanFails < AUTO_SCAN_THRESHOLDS.maxConsecutiveFails) {
    autoStatusEl.textContent = '🔍 Procurando carta...';
    return;
  }
  // Muitas tentativas automáticas seguidas sem sucesso: pausa o loop em vez de
  // continuar gastando CPU/rede, e entrega o controle para o botão manual.
  autoScanPausedForManual = true;
  autoStatusEl.innerHTML = '😕 Não conseguimos ler automaticamente.<br>Ajuste a luz/foco e toque em <strong>Capturar</strong>, ou toque em 🔄 Auto para tentar de novo.';
}

async function handleReading(reading) {
  showView('confirm');
  const listEl = $('#confirm-list');
  const statusEl = $('#confirm-status');
  const readSummary = $('#confirm-read-summary');

  readSummary.innerHTML = readingSummaryHtml(reading);
  listEl.innerHTML = skeletonRows(3);
  statusEl.textContent = 'Procurando a carta correspondente...';

  const ctrl = new AbortController();
  try {
    const candidates = await resolveReading(reading, state.lang, {
      signal: ctrl.signal,
      onProgress: (m) => { statusEl.textContent = m; },
    });

    state.candidates = candidates;
    state.currentReading = reading;

    if (!candidates.length) {
      statusEl.textContent = '';
      listEl.innerHTML = `<p class="empty-hint">Não encontramos uma carta correspondente na base de dados.<br>Tente pesquisar manualmente.</p>`;
      return;
    }

    if (candidates.length === 1) {
      statusEl.textContent = '1 carta encontrada — confirme abaixo:';
    } else {
      statusEl.textContent = `Encontramos ${candidates.length} cartas. Qual corresponde à sua?`;
    }

    listEl.innerHTML = candidates.map(candidateHtml).join('');
    $$('#confirm-list .candidate').forEach((el, i) => {
      el.addEventListener('click', async () => {
        await loadCardDetail(candidates[i].id, { reading });
        showView('detail');
      });
    });

    if (candidates.length === 1 && reading.confidence >= 0.55) {
      await loadCardDetail(candidates[0].id, { reading });
      showView('detail');
    }
  } catch (err) {
    statusEl.textContent = friendlyError(err);
    listEl.innerHTML = '';
  }
}

function readingSummaryHtml(reading) {
  const bits = [];
  if (reading.name) bits.push(`<strong>${escHtml(reading.name)}</strong>`);
  if (reading.number) bits.push(`#${escHtml(reading.number)}${reading.setTotal ? '/' + escHtml(reading.setTotal) : ''}`);
  if (!bits.length) return '';
  const confPct = Math.round((reading.confidence || 0) * 100);
  return `<div class="read-summary">🔎 Lemos: ${bits.join(' · ')} <span class="conf">(confiança ${confPct}%)</span></div>`;
}

$('#confirm-cancel').addEventListener('click', () => showView('dashboard'));
$('#confirm-manual-search').addEventListener('click', () => showView('search'));

/* ═══════════════════════════ Detalhe da carta ═══════════════════════════ */

async function loadCardDetail(cardId, { reading = null, fromCollectionItem = null } = {}) {
  const panel = $('#detail-panel');
  panel.innerHTML = detailSkeletonHtml();
  showView('detail');

  try {
    const card = await getCardEnriched(cardId, state.lang);
    state.currentCard = card;
    state.currentReading = reading;
    renderDetail(card, { reading, fromCollectionItem });
    learnCardHashInBackground(card);

    // O ano de lançamento não vem no resumo de set embutido no card — busca
    // à parte e preenche assim que chegar, sem atrasar o resto da tela.
    if (!reading?.year) {
      getCardYear(card, state.lang).then((year) => {
        if (year && state.currentCard === card) {
          const cell = $('#detail-year');
          if (cell) cell.textContent = year;
        }
      });
    }
  } catch (err) {
    panel.innerHTML = `<p class="empty-hint">${escHtml(friendlyError(err))}</p>`;
  }
}

function detailSkeletonHtml() {
  return `<div class="skeleton-detail">
    <div class="skeleton-img"></div>
    <div class="skeleton-lines"><div class="skeleton-line w70"></div><div class="skeleton-line w40"></div><div class="skeleton-line w60"></div></div>
  </div>`;
}

function renderDetail(card, { reading, fromCollectionItem } = {}) {
  const cc = card.set?.cardCount;
  const total = cc ? (cc.official || cc.total) : null;
  const number = card.localId ? `${card.localId}${total ? '/' + total : ''}` : '—';
  const year = reading?.year || '—'; // completado à parte por getCardYear() quando ausente

  const variants = listPricedVariants(card);
  const defaultVariant = fromCollectionItem?.variant || guessVariantCode(card, reading) || variants[0]?.type || 'normal';

  $('#detail-panel').innerHTML = `
    <div class="detail-hero">
      <img id="detail-img" src="${escHtml(cardImage(card, 'high'))}" alt="${escHtml(card.name || '')}"/>
    </div>
    <div class="detail-info">
      <h2 id="detail-name">${escHtml(card.name || '')}</h2>
      <p id="detail-set" class="detail-set">${escHtml(card.set?.name || '')}</p>
      <table class="info-table">
        <tr><td class="label">Número</td><td class="value">${escHtml(number)}</td></tr>
        <tr><td class="label">Raridade</td><td class="value">${escHtml(card.rarity || '—')}</td></tr>
        <tr><td class="label">Idioma</td><td class="value">${escHtml(LANGUAGES.find((l) => l.code === state.lang)?.label || state.lang)}</td></tr>
        <tr><td class="label">Ano</td><td class="value" id="detail-year">${escHtml(year)}</td></tr>
        <tr><td class="label">Ilustrador</td><td class="value">${escHtml(card.illustrator || reading?.illustrator || '—')}</td></tr>
        <tr><td class="label">ID</td><td class="value mono">${escHtml(card.id)}</td></tr>
      </table>
    </div>

    <div class="section-card" id="price-card"></div>

    <div class="section-card" id="variant-card">
      <h3>Variante</h3>
      <div id="variant-chips" class="chip-row"></div>
    </div>

    <div class="section-card" id="add-card">
      <h3>Adicionar à coleção</h3>
      <div class="form-row">
        <label>Quantidade
          <div class="qty-stepper">
            <button type="button" id="qty-minus">−</button>
            <input type="number" id="qty-input" min="1" value="${fromCollectionItem?.quantity || 1}"/>
            <button type="button" id="qty-plus">+</button>
          </div>
        </label>
        <label>Condição
          <select id="condition-select">
            ${Collection.CONDITIONS.map((c) => `<option value="${c.code}" ${c.code === (fromCollectionItem?.condition || 'NM') ? 'selected' : ''}>${escHtml(c.label)}</option>`).join('')}
          </select>
        </label>
      </div>
      <button id="btn-add-collection" class="btn-primary">
        ${fromCollectionItem ? '💾 Salvar alterações' : '➕ Adicionar à coleção'}
      </button>
      ${fromCollectionItem ? `<button id="btn-remove-collection" class="btn-danger-ghost">🗑 Remover da coleção</button>` : ''}
    </div>

    <div class="section-card" id="translation-card">
      <h3>Tradução</h3>
      <div class="form-row">
        <label>Traduzir para
          <select id="translate-target">
            ${LANGUAGES.map((l) => `<option value="${l.code}">${l.flag} ${escHtml(l.label)}</option>`).join('')}
          </select>
        </label>
        <button id="btn-translate" class="btn-secondary">Traduzir</button>
      </div>
      <div id="translation-result"></div>
    </div>
  `;

  $('#detail-img').addEventListener('error', function onErr() {
    this.removeEventListener('error', onErr);
    this.src = cardImage(card, 'low');
  });

  renderVariantChips(card, variants, defaultVariant);
  renderPriceBlock();
  renderCardTextBlock(card, reading);

  $('#qty-minus').addEventListener('click', () => stepQty(-1));
  $('#qty-plus').addEventListener('click', () => stepQty(1));

  $('#btn-add-collection').addEventListener('click', () => saveToCollection(card, reading, fromCollectionItem));
  $('#btn-remove-collection')?.addEventListener('click', () => {
    if (!confirm('Remover esta carta da coleção?')) return;
    Collection.removeItem(fromCollectionItem.id);
    toast('Carta removida da coleção.');
    showView('collection');
  });

  const targetSel = $('#translate-target');
  targetSel.value = state.lang === 'en' ? 'pt' : 'en';
  $('#btn-translate').addEventListener('click', () => runTranslation(card, targetSel.value));
}

function stepQty(delta) {
  const input = $('#qty-input');
  const v = Math.max(1, (parseInt(input.value, 10) || 1) + delta);
  input.value = v;
}

// O leitor de visão devolve dicas no vocabulário do schema (reverse_holo,
// first_edition...); os tipos de variante da TCGdex usam outros nomes
// (reverse, firstEdition...). Sem este mapeamento, "reverse_holo" nunca
// bateria com a variante "reverse" que a carta realmente tem.
const VARIANT_HINT_TO_TCGDEX = {
  reverse_holo: 'reverse',
  holo: 'holo',
  normal: 'normal',
  first_edition: 'firstEdition',
  promo: 'wPromo',
};

function guessVariantCode(card, reading) {
  const hints = (reading?.variantHints || []).map((h) => VARIANT_HINT_TO_TCGDEX[h] || h);
  const available = (card.variants_detailed || []).map((v) => v.type);
  return hints.find((h) => available.includes(h)) || null;
}

let selectedVariantType = null;

function renderVariantChips(card, variants, defaultVariant) {
  selectedVariantType = defaultVariant;
  const chipsEl = $('#variant-chips');
  const flags = card.variants || {};
  const available = variants.length
    ? variants.map((v) => v.type)
    : Object.entries(flags).filter(([, v]) => v).map(([k]) => k);

  if (!available.length) {
    chipsEl.innerHTML = `<span class="muted">Sem variantes registradas para esta carta.</span>`;
    return;
  }

  chipsEl.innerHTML = available.map((t) => `
    <button type="button" class="chip ${t === selectedVariantType ? 'active' : ''}" data-variant="${escHtml(t)}">${escHtml(variantLabel(t))}</button>
  `).join('');

  $$('#variant-chips .chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedVariantType = btn.dataset.variant;
      $$('#variant-chips .chip').forEach((b) => b.classList.toggle('active', b === btn));
      renderPriceBlock();
    });
  });
}

function variantLabel(type) {
  const known = { normal: 'Normal', reverse: 'Reverse Holo', holo: 'Holo', firstEdition: '1ª Edição', wPromo: 'Promo' };
  return known[type] || type;
}

/** Guarda o último preço visto na tela — é o valor gravado se o usuário adicionar a carta. */
let lastKnownPrice = { value: null, source: null, updated: null };

async function renderPriceBlock() {
  const card = state.currentCard;
  if (!card) return;
  const el = $('#price-card');
  el.innerHTML = `<h3>Valor estimado</h3><p class="muted">Consultando preços...</p>`;
  lastKnownPrice = { value: null, source: null, updated: null };

  try {
    const price = await getCardPrice(card, { variantType: selectedVariantType, targetCurrency: state.currency });
    if (!price || !price.primary) {
      el.innerHTML = `<h3>Valor estimado</h3><p class="empty-hint">Preço não encontrado para esta carta/variante.</p>`;
      return;
    }

    const { primary, secondary } = price;
    const mainValue = primary.converted !== null
      ? formatMoney(primary.converted, state.currency)
      : `${formatMoney(primary.amount, primary.currency)} (câmbio indisponível)`;

    if (primary.converted != null) {
      lastKnownPrice = { value: primary.converted, source: primary.label, updated: primary.updated };
    }

    const history = priceHistoryFromCardmarket(card, price.variantType);

    el.innerHTML = `
      <h3>Valor estimado</h3>
      <div class="price-main">${mainValue}</div>
      ${secondary ? `<div class="price-secondary">≈ ${formatMoney(secondary.amount, secondary.currency)} <span class="muted">(${escHtml(secondary.label)})</span></div>` : ''}
      <div class="price-meta">
        <span>Fonte: ${escHtml(primary.label)}</span>
        <span>Atualizado em ${escHtml(formatDate(primary.updated))}</span>
      </div>
      ${history.length > 1 ? historyHtml(history) : ''}
    `;
  } catch {
    el.innerHTML = `<h3>Valor estimado</h3><p class="empty-hint">Não foi possível carregar o preço agora.</p>`;
  }
}

function historyHtml(points) {
  const max = Math.max(...points.map((p) => p.value), 0.01);
  const bars = points.map((p) => {
    const h = Math.max(6, Math.round((p.value / max) * 48));
    return `<div class="hist-bar-wrap"><div class="hist-bar" style="height:${h}px" title="${escHtml(p.label)}: ${formatMoney(p.value, p.currency)}"></div><span>${escHtml(p.label)}</span></div>`;
  }).join('');
  const first = points[0].value, last = points[points.length - 1].value;
  const pct = first > 0 ? (((last - first) / first) * 100).toFixed(1) : null;
  return `
    <div class="price-history">
      <div class="hist-chart">${bars}</div>
      ${pct !== null ? `<div class="hist-delta ${last >= first ? 'up' : 'down'}">${last >= first ? '▲' : '▼'} ${pct}% no período (Cardmarket)</div>` : ''}
    </div>`;
}

function renderCardTextBlock(card, reading) {
  const attacks = card.attacks || [];
  const abilities = card.abilities || [];
  const weaknesses = card.weaknesses || [];
  const resistances = card.resistances || [];

  const el = document.createElement('div');
  el.className = 'section-card';
  el.id = 'text-card';
  el.innerHTML = `
    <h3>Informações da carta</h3>
    ${card.hp ? `<p><strong>HP:</strong> ${escHtml(card.hp)}</p>` : ''}
    ${card.description ? `<p class="card-desc">${escHtml(card.description)}</p>` : ''}
    ${abilities.length ? `<h4>Habilidades</h4>${abilities.map((a) => `<p><strong>${escHtml(a.name)}</strong> — ${escHtml(a.effect || '')}</p>`).join('')}` : ''}
    ${attacks.length ? `<h4>Ataques</h4>${attacks.map((a) => `<p><strong>${escHtml(a.name)}</strong>${a.damage ? ` (${escHtml(String(a.damage))})` : ''} — ${escHtml(a.effect || '')}</p>`).join('')}` : ''}
    ${weaknesses.length ? `<p><strong>Fraqueza:</strong> ${weaknesses.map((w) => escHtml(`${w.type} ${w.value || ''}`)).join(', ')}</p>` : ''}
    ${resistances.length ? `<p><strong>Resistência:</strong> ${resistances.map((r) => escHtml(`${r.type} ${r.value || ''}`)).join(', ')}</p>` : ''}
    ${typeof card.retreat === 'number' ? `<p><strong>Recuo:</strong> ${card.retreat}</p>` : ''}
  `;

  const translationCard = $('#translation-card');
  translationCard.parentNode.insertBefore(el, translationCard);
}

async function runTranslation(card, targetLang) {
  const el = $('#translation-result');
  el.innerHTML = `<p class="muted">Traduzindo...</p>`;
  try {
    // TCGdex não marca o idioma no próprio objeto da carta — o idioma é o da
    // requisição que a trouxe, guardado em state.lang, não em card.lang.
    const { text, mode } = await getCardInLanguage(card.id, targetLang, state.lang === 'en' ? card : null);
    const original = extractOriginalText(card);

    el.innerHTML = `
      ${mode === 'machine' ? `<div class="badge-auto">⚠ Tradução automática — pode conter imprecisões</div>` : `<div class="badge-official">✓ Texto oficial no idioma selecionado</div>`}
      <div class="translate-grid">
        <div>
          <div class="translate-label">Texto original</div>
          ${textBlockHtml(original)}
        </div>
        <div>
          <div class="translate-label">Tradução</div>
          ${textBlockHtml(text)}
        </div>
      </div>
    `;
  } catch (err) {
    el.innerHTML = `<p class="empty-hint">${escHtml(friendlyError(err))}</p>`;
  }
}

function extractOriginalText(card) {
  return {
    name: card.name || '',
    description: card.description || '',
    attacks: (card.attacks || []).map((a) => ({ name: a.name, effect: a.effect, damage: a.damage })),
    abilities: (card.abilities || []).map((a) => ({ name: a.name, effect: a.effect })),
    weaknesses: (card.weaknesses || []).map((w) => `${w.type} ${w.value || ''}`.trim()),
    resistances: (card.resistances || []).map((w) => `${w.type} ${w.value || ''}`.trim()),
    retreat: typeof card.retreat === 'number' ? String(card.retreat) : '',
  };
}

function textBlockHtml(t) {
  return `
    <p class="tt-name">${escHtml(t.name)}</p>
    ${t.description ? `<p>${escHtml(t.description)}</p>` : ''}
    ${t.abilities?.length ? t.abilities.map((a) => `<p><strong>${escHtml(a.name)}</strong> — ${escHtml(a.effect || '')}</p>`).join('') : ''}
    ${t.attacks?.length ? t.attacks.map((a) => `<p><strong>${escHtml(a.name)}</strong>${a.damage ? ` (${escHtml(String(a.damage))})` : ''} — ${escHtml(a.effect || '')}</p>`).join('') : ''}
    ${t.weaknesses?.length ? `<p><strong>Fraqueza:</strong> ${t.weaknesses.map(escHtml).join(', ')}</p>` : ''}
    ${t.resistances?.length ? `<p><strong>Resistência:</strong> ${t.resistances.map(escHtml).join(', ')}</p>` : ''}
    ${t.retreat ? `<p><strong>Recuo:</strong> ${escHtml(t.retreat)}</p>` : ''}
  `;
}

function saveToCollection(card, reading, existingItem) {
  const quantity = Math.max(1, parseInt($('#qty-input').value, 10) || 1);
  const condition = $('#condition-select').value;
  const cc = card.set?.cardCount;
  const priceFields = {
    unitPrice: lastKnownPrice.value,
    currency: state.currency,
    priceSource: lastKnownPrice.source,
    priceUpdated: lastKnownPrice.updated,
  };

  if (existingItem) {
    // Edição de um item já existente: atualiza no lugar, nunca cria outro —
    // addItem() faria isso se a variante/condição tivesse mudado o critério de match.
    Collection.updateItem(existingItem.id, {
      quantity,
      condition,
      variant: selectedVariantType || existingItem.variant,
      ...priceFields,
    });
  } else {
    Collection.addItem({
      cardId: card.id,
      name: card.name || '',
      setName: card.set?.name || '',
      number: card.localId ? String(card.localId) : '',
      setTotal: cc ? String(cc.official || cc.total) : '',
      rarity: card.rarity || '',
      lang: state.lang,
      variant: selectedVariantType || 'normal',
      condition,
      quantity,
      imageUrl: cardImage(card, 'low'),
      ...priceFields,
    });
  }

  toast(existingItem ? 'Alterações salvas.' : `${card.name} adicionada à coleção! 🎉`);
  showView('collection');
}

$('#detail-back')?.addEventListener('click', () => showView('dashboard'));

/* ═══════════════════════════ Coleção ═══════════════════════════ */

let collectionSort = 'recent';
let collectionQuery = '';

function renderCollection() {
  const all = Collection.listItems();
  const stats = Collection.getStats(all);

  $('#coll-total-value').textContent = formatMoney(stats.totalValue, state.currency) ?? '—';
  $('#coll-total-cards').textContent = stats.totalCards;
  $('#coll-distinct-cards').textContent = stats.distinctCards;

  const filtered = Collection.filterItems(all, collectionQuery);
  const sorted = Collection.sortItems(filtered, collectionSort);

  const listEl = $('#collection-list');
  if (!sorted.length) {
    listEl.innerHTML = `<p class="empty-hint">${all.length ? 'Nenhuma carta bate com esse filtro.' : 'Sua coleção está vazia.'}</p>`;
    return;
  }
  listEl.innerHTML = sorted.map(itemCardHtml).join('');
  $$('#collection-list .item-card').forEach((el) => {
    el.addEventListener('click', () => openItemDetail(el.dataset.id));
  });
}

$('#collection-search').addEventListener('input', debounce((e) => {
  collectionQuery = e.target.value;
  renderCollection();
}, 250));

$('#collection-sort').addEventListener('change', (e) => {
  collectionSort = e.target.value;
  renderCollection();
});

/* ═══════════════════════════ Init ═══════════════════════════ */

renderTopbarSelectors();
showView('dashboard');
