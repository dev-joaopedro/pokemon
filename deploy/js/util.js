/* Utilitários compartilhados. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function escHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Remove zeros à esquerda de "007" sem destruir "TG04" nem "0". */
export function normNum(v) {
  const s = String(v ?? '').trim();
  return /^\d+$/.test(s) ? String(parseInt(s, 10)) : s.toUpperCase();
}

/** Normaliza texto para comparação: sem acento, sem pontuação, minúsculo. */
export function slug(v) {
  return String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Erro com código legível, para o app distinguir causas sem parsear mensagens. */
export class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * fetch com timeout obrigatório. Nenhuma chamada de rede no app pode ficar
 * pendurada para sempre — é o que produz a tela de carregamento infinita.
 */
export async function fetchJSON(url, { timeout = 12000, signal, ...init } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new AppError('TIMEOUT', 'Tempo esgotado.')), timeout);
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); throw signal.reason; }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (res.status === 404) throw new AppError('NOT_FOUND', 'Não encontrado.');
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error || ''; } catch { /* corpo não-JSON */ }
      throw new AppError(`HTTP_${res.status}`, detail || `Serviço respondeu ${res.status}.`);
    }
    return await res.json();
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw ctrl.signal.reason instanceof AppError
        ? ctrl.signal.reason
        : new AppError('ABORTED', 'Requisição cancelada.');
    }
    if (err instanceof AppError) throw err;
    throw new AppError('NETWORK', 'Sem conexão com o serviço.');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Executa tarefas com limite de paralelismo. A busca por número precisa varrer
 * muitos sets; sem isso o navegador dispara 170 conexões de uma vez e a API
 * começa a recusar.
 */
export async function pool(items, limit, worker, { signal } = {}) {
  const results = new Array(items.length);
  let cursor = 0;

  async function run() {
    while (cursor < items.length) {
      if (signal?.aborted) return;
      const i = cursor++;
      try {
        results[i] = await worker(items[i], i);
      } catch {
        results[i] = null;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

/** Mensagem amigável a partir do código do erro. */
export function friendlyError(err) {
  const code = err?.code;
  switch (code) {
    case 'TIMEOUT':
      return 'O serviço demorou demais para responder. Tente de novo.';
    case 'NETWORK':
      return 'Verifique sua conexão com a internet.';
    case 'NOT_FOUND':
      return 'Não encontramos essa carta.';
    case 'RATE_LIMIT':
    case 'UPSTREAM_RATE_LIMIT':
      return 'Muitas leituras seguidas. Aguarde um instante.';
    case 'ABORTED':
      return '';
    default:
      return err?.message || 'Algo deu errado. Tente novamente.';
  }
}

export function formatDate(iso, { withTime = false } = {}) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

/** Redimensiona um canvas/imagem para caber em maxDim e devolve um data URL JPEG. */
export function toDataUrl(source, maxDim = 1400, quality = 0.86) {
  const w = source.width || source.videoWidth;
  const h = source.height || source.videoHeight;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const out = document.createElement('canvas');
  out.width = Math.round(w * scale);
  out.height = Math.round(h * scale);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', quality);
}
