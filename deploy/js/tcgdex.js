/**
 * Cliente da TCGdex v2 — https://tcgdex.dev
 *
 * Escolhida por ser gratuita, sem chave, com CORS aberto (Access-Control-Allow-Origin: *),
 * com imagens em alta, com dados localizados oficialmente em 6 idiomas e — desde a
 * integração "TCG Markets" — com preços de Cardmarket e TCGplayer embutidos no card.
 *
 * Toda a leitura de dados do app passa por aqui. Trocar de fonte significa
 * reimplementar este módulo, não o resto do aplicativo.
 */

import { fetchJSON, normNum, slug, pool, AppError } from './util.js';

const BASE = 'https://api.tcgdex.net/v2';

/** Idiomas em que a TCGdex publica os dados das cartas. */
export const LANGUAGES = [
  { code: 'pt', label: 'Português', flag: '🇧🇷' },
  { code: 'en', label: 'English', flag: '🇺🇸' },
  { code: 'es', label: 'Español', flag: '🇪🇸' },
  { code: 'fr', label: 'Français', flag: '🇫🇷' },
  { code: 'de', label: 'Deutsch', flag: '🇩🇪' },
  { code: 'it', label: 'Italiano', flag: '🇮🇹' },
  // A TCGdex ainda não serve dados em japonês (retorna 404). Mantemos na lista
  // para o seletor, e o app avisa quando a tradução não existe.
  { code: 'ja', label: '日本語', flag: '🇯🇵', partial: true },
];

export const SUPPORTED_LANGS = new Set(LANGUAGES.map((l) => l.code));
export const DEFAULT_LANG = 'pt';

const setsCache = new Map(); // lang -> Promise<Set[]>
const cardCache = new Map(); // `${lang}:${id}` -> Promise<Card>
const setDetailCache = new Map(); // `${lang}:${setId}` -> Promise<SetDetail>

export function cardImage(card, size = 'high') {
  return card?.image ? `${card.image}/${size}.png` : '';
}

/** O id do card é `${setId}-${localId}`; o set é tudo antes do último hífen. */
export function setIdFromCardId(id) {
  const i = String(id || '').lastIndexOf('-');
  return i === -1 ? String(id || '') : String(id).substring(0, i);
}

export function getSets(lang = DEFAULT_LANG) {
  const key = SUPPORTED_LANGS.has(lang) ? lang : 'en';
  if (!setsCache.has(key)) {
    setsCache.set(
      key,
      fetchJSON(`${BASE}/${key}/sets`, { timeout: 15000 }).catch((err) => {
        setsCache.delete(key);
        throw err;
      }),
    );
  }
  return setsCache.get(key);
}

export function getCard(cardId, lang = DEFAULT_LANG) {
  const key = `${lang}:${cardId}`;
  if (!cardCache.has(key)) {
    cardCache.set(
      key,
      fetchJSON(`${BASE}/${lang}/cards/${encodeURIComponent(cardId)}`).catch((err) => {
        cardCache.delete(key);
        throw err;
      }),
    );
  }
  return cardCache.get(key);
}

/**
 * Mesma carta em outro idioma. Devolve null quando aquela língua não tem a
 * carta — é o caso do japonês hoje, e de sets nunca publicados numa região.
 */
export async function getCardTranslation(cardId, lang) {
  try {
    return await getCard(cardId, lang);
  } catch (err) {
    if (err.code === 'NOT_FOUND') return null;
    throw err;
  }
}

/** Mesmo que getCardTranslation, mas com o preenchimento de lacunas de getCardEnriched. */
export async function getCardTranslationEnriched(cardId, lang) {
  try {
    return await getCardEnriched(cardId, lang);
  } catch (err) {
    if (err.code === 'NOT_FOUND') return null;
    throw err;
  }
}

/**
 * Detalhe do set (inclui `releaseDate`, ausente no resumo `card.set`
 * embutido na resposta de uma carta).
 */
export function getSetDetail(setId, lang = DEFAULT_LANG) {
  const key = `${lang}:${setId}`;
  if (!setDetailCache.has(key)) {
    setDetailCache.set(
      key,
      fetchJSON(`${BASE}/${lang}/sets/${encodeURIComponent(setId)}`).catch((err) => {
        setDetailCache.delete(key);
        throw err;
      }),
    );
  }
  return setDetailCache.get(key);
}

/** Ano de lançamento do set de uma carta, ou '' se indisponível. */
export async function getCardYear(card, lang = DEFAULT_LANG) {
  if (!card?.set?.id) return '';
  try {
    const set = await getSetDetail(card.set.id, lang);
    return set?.releaseDate ? set.releaseDate.slice(0, 4) : '';
  } catch {
    return '';
  }
}

/**
 * Alguns sets mais antigos têm lacunas na localização da TCGdex: o nome e o
 * texto de ataques/habilidades vêm vazios num idioma mas existem em inglês.
 * Preenchemos essas lacunas com o inglês em vez de mostrar campos em branco —
 * isso não é "tradução automática" (não é exibido como tal), é só completar
 * um dado que a própria fonte deveria ter localizado e não localizou.
 */
export async function getCardEnriched(cardId, lang = DEFAULT_LANG) {
  const card = await getCard(cardId, lang);
  if (lang === 'en') return card;

  const missingAttackText = (card.attacks || []).some((a) => !a.name);
  const missingAbilityText = (card.abilities || []).some((a) => !a.name);
  if (!missingAttackText && !missingAbilityText) return card;

  try {
    const en = await getCard(cardId, 'en');
    return {
      ...card,
      attacks: fillMissingText(card.attacks, en.attacks),
      abilities: fillMissingText(card.abilities, en.abilities),
      description: card.description || en.description || '',
    };
  } catch {
    return card; // Sem inglês disponível — segue com o que a fonte deu.
  }
}

function fillMissingText(local, fallback) {
  if (!Array.isArray(local)) return local;
  return local.map((item, i) => {
    const src = fallback?.[i];
    if (!src) return item;
    return {
      ...item,
      name: item.name || src.name || '',
      effect: item.effect || src.effect || '',
    };
  });
}

/** Busca por nome (parcial). Devolve os objetos resumidos da API. */
export async function searchByName(name, lang = DEFAULT_LANG, { signal } = {}) {
  const q = String(name || '').trim();
  if (q.length < 2) return [];
  const url = `${BASE}/${lang}/cards?name=like:${encodeURIComponent(q)}`;
  const res = await fetchJSON(url, { timeout: 15000, signal });
  return Array.isArray(res) ? res : [];
}

export async function getCardBySetLocal(setId, localId, lang = DEFAULT_LANG, { signal } = {}) {
  try {
    return await fetchJSON(
      `${BASE}/${lang}/sets/${encodeURIComponent(setId)}/${encodeURIComponent(localId)}`,
      { timeout: 10000, signal },
    );
  } catch {
    return null;
  }
}

/** Um set "bate" com o total impresso na carta se o official ou o total coincidir. */
function setMatchesTotal(set, total) {
  if (!set?.cardCount || !total) return false;
  const t = normNum(total);
  return (
    normNum(String(set.cardCount.official ?? '')) === t ||
    normNum(String(set.cardCount.total ?? '')) === t
  );
}

/**
 * Busca por número impresso ("117/94" ou só "117").
 *
 * Preserva o comportamento da versão anterior do app — varrer os sets — mas com
 * paralelismo limitado e cancelamento, em vez de 170 fetches simultâneos.
 */
export async function searchByNumber(raw, lang = DEFAULT_LANG, { signal, onProgress } = {}) {
  const parts = String(raw || '').trim().split('/');
  const localId = normNum(parts[0]);
  const total = parts[1] ? normNum(parts[1]) : null;

  if (!localId || !/^[A-Z]{0,4}\d+[A-Z]?$/i.test(localId)) {
    throw new AppError('BAD_INPUT', 'Digite um número de carta válido, como 117/94.');
  }

  const allSets = await getSets(lang);
  let sets = allSets;

  if (total) {
    sets = allSets.filter((s) => setMatchesTotal(s, total));
    if (!sets.length) {
      throw new AppError(
        'NO_SET',
        `Nenhuma coleção com ${total} cartas. Tente buscar só por ${localId}.`,
      );
    }
  }

  onProgress?.(`Procurando em ${sets.length} coleções...`);

  const base = await pool(
    sets,
    12,
    (s) => getCardBySetLocal(s.id, localId, lang, { signal }),
    { signal },
  );
  if (signal?.aborted) return [];

  const hits = base.filter((c) => c?.id);

  // Variantes com sufixo de letra (ex.: 25a) existem em alguns sets; só vale a
  // pena procurá-las nos sets que já deram acerto.
  const hitSets = sets.filter((_, i) => base[i]?.id);
  const suffixed = await pool(
    hitSets.flatMap((s) => ['a', 'b', 'c'].map((sfx) => ({ setId: s.id, lid: localId + sfx }))),
    12,
    ({ setId, lid }) => getCardBySetLocal(setId, lid, lang, { signal }),
    { signal },
  );

  return [...hits, ...suffixed.filter((c) => c?.id)];
}

/* ── Resolução da leitura do scanner em cartas reais ─────────────────────── */

/**
 * Recebe os campos lidos na foto e devolve candidatos ordenados por quão bem
 * batem com o que estava impresso.
 *
 * Estratégia, em ordem de custo:
 *  1. Nome + número -> busca por nome e filtra pelo número (1 requisição)
 *  2. Número + total -> varre só os sets com aquele total (poucas requisições)
 *  3. Só nome -> busca por nome
 *  4. Só número -> varredura completa (caro, último recurso)
 */
export async function resolveReading(reading, lang = DEFAULT_LANG, { signal, onProgress } = {}) {
  const name = (reading.name || '').trim();
  const number = normNum(reading.number || '');
  const total = reading.setTotal ? normNum(reading.setTotal) : '';
  const byId = new Map();

  const add = (card) => {
    if (card?.id && !byId.has(card.id)) byId.set(card.id, card);
  };

  if (name) {
    onProgress?.(`Procurando "${name}"...`);
    try {
      const found = await searchByName(name, lang, { signal });
      found.forEach(add);
      // A TCGdex serve nomes localizados; se a carta é inglesa e o app está em
      // português, a busca no idioma do app não acha. Tentamos inglês também.
      if (lang !== 'en' && found.length === 0) {
        (await searchByName(name, 'en', { signal })).forEach(add);
      }
    } catch (err) {
      if (err.code === 'ABORTED') throw err;
    }
  }

  if (signal?.aborted) return [];

  const nameGaveNumberMatch =
    number && [...byId.values()].some((c) => normNum(c.localId) === number);

  if (number && !nameGaveNumberMatch) {
    onProgress?.('Procurando pelo número...');
    try {
      const query = total ? `${number}/${total}` : number;
      const found = await searchByNumber(query, lang, { signal, onProgress });
      found.forEach(add);
    } catch (err) {
      if (err.code === 'ABORTED') throw err;
    }
  }

  if (signal?.aborted) return [];

  const scored = [...byId.values()].map((card) => ({
    card,
    score: scoreCandidate(card, { name, number, total, setName: reading.setName }),
  }));

  scored.sort((a, b) => b.score - a.score);

  // Os resumos da busca por nome não trazem set nem preço; hidratamos os
  // melhores candidatos com o card completo.
  const top = scored.slice(0, 12);
  const hydrated = await pool(
    top,
    6,
    async ({ card, score }) => {
      if (card.set?.id && card.rarity !== undefined) return { card, score };
      try {
        return { card: await getCard(card.id, lang), score };
      } catch {
        return { card, score };
      }
    },
    { signal },
  );

  return hydrated.filter(Boolean).map((x) => x.card);
}

function scoreCandidate(card, { name, number, total, setName }) {
  let score = 0;

  if (name) {
    const a = slug(card.name);
    const b = slug(name);
    if (a === b) score += 6;
    else if (a.startsWith(b) || b.startsWith(a)) score += 4;
    else if (a.includes(b) || b.includes(a)) score += 2;
  }

  if (number && normNum(card.localId) === number) score += 5;
  if (total && setMatchesTotal(card.set, total)) score += 4;

  if (setName && card.set?.name) {
    const a = slug(card.set.name);
    const b = slug(setName);
    if (a === b) score += 3;
    else if (a.includes(b) || b.includes(a)) score += 1;
  }

  // Havendo empate, cartas com imagem são mais úteis para a confirmação visual.
  if (card.image) score += 0.5;

  return score;
}
