/**
 * Tradução do texto da carta.
 *
 * Fonte preferida: a própria TCGdex, que publica o card oficialmente
 * localizado em pt/en/es/fr/de/it — isso é o texto real impresso na versão
 * daquele idioma, não uma tradução automática.
 *
 * Quando o idioma pedido não existe na TCGdex (hoje, japonês), caímos para
 * tradução automática via MyMemory (gratuita, sem chave, CORS aberto) e
 * deixamos isso explícito na interface — nunca disfarçada de texto oficial.
 */

import { fetchJSON, AppError } from './util.js';
import { getCardTranslation, getCardTranslationEnriched, LANGUAGES } from './tcgdex.js';

const MYMEMORY = 'https://api.mymemory.translated.net/get';

const FIELD_LABELS = {
  name: 'Nome',
  description: 'Descrição',
  attacks: 'Ataques',
  abilities: 'Habilidades',
  weaknesses: 'Fraqueza',
  resistances: 'Resistência',
  retreat: 'Recuo',
};

/** Extrai os textos "traduzíveis" de um card TCGdex num formato uniforme. */
export function extractCardText(card) {
  const attacks = (card.attacks || []).map((a) => ({
    name: a.name || '',
    effect: a.effect || '',
    damage: a.damage ?? null,
    cost: a.cost || [],
  }));

  const abilities = (card.abilities || []).map((a) => ({
    name: a.name || '',
    effect: a.effect || '',
    type: a.type || '',
  }));

  const weaknesses = (card.weaknesses || []).map((w) => `${w.type} ${w.value || ''}`.trim());
  const resistances = (card.resistances || []).map((r) => `${r.type} ${r.value || ''}`.trim());

  return {
    name: card.name || '',
    description: card.description || card.effect || '',
    attacks,
    abilities,
    weaknesses,
    resistances,
    retreat: typeof card.retreat === 'number' ? String(card.retreat) : '',
  };
}

/**
 * Devolve { text, mode, lang } onde mode é "official" (veio da própria TCGdex
 * naquele idioma) ou "machine" (tradução automática, aplicada a partir do
 * texto em inglês).
 */
export async function getCardInLanguage(cardId, targetLang, englishCardFallback) {
  const supportsLang = LANGUAGES.some((l) => l.code === targetLang && !l.partial);

  if (supportsLang) {
    // Enriquecida: alguns sets antigos têm ataques/habilidades sem nome ou
    // efeito localizado na TCGdex; sem isso, a "tradução oficial" mostraria
    // texto em branco onde o "original" (também enriquecido) mostra inglês.
    const translated = await getCardTranslationEnriched(cardId, targetLang);
    if (translated) {
      return { card: translated, text: extractCardText(translated), mode: 'official', lang: targetLang };
    }
  }

  // TCGdex não tem essa carta nesse idioma — traduzimos automaticamente a
  // partir do inglês, que é o idioma com maior cobertura na fonte.
  const base = englishCardFallback || (await getCardTranslation(cardId, 'en'));
  if (!base) {
    throw new AppError('NOT_FOUND', 'Texto da carta indisponível para tradução.');
  }
  const baseText = extractCardText(base);
  const translated = await machineTranslateCardText(baseText, targetLang);
  return { card: base, text: translated, mode: 'machine', lang: targetLang, sourceLang: 'en' };
}

async function translateString(text, targetLang, sourceLang = 'en') {
  const q = String(text || '').trim();
  if (!q) return '';
  try {
    const res = await fetchJSON(
      `${MYMEMORY}?q=${encodeURIComponent(q)}&langpair=${sourceLang}|${targetLang}`,
      { timeout: 8000 },
    );
    const out = res?.responseData?.translatedText;
    return out && res.responseStatus === 200 ? out : q;
  } catch {
    return q; // Falha na tradução automática: mostra o original em vez de travar a tela.
  }
}

async function machineTranslateCardText(text, targetLang) {
  const [name, description, retreat] = await Promise.all([
    translateString(text.name, targetLang),
    translateString(text.description, targetLang),
    translateString(text.retreat, targetLang),
  ]);

  const attacks = await Promise.all(
    text.attacks.map(async (a) => ({
      ...a,
      name: await translateString(a.name, targetLang),
      effect: await translateString(a.effect, targetLang),
    })),
  );

  const abilities = await Promise.all(
    text.abilities.map(async (a) => ({
      ...a,
      name: await translateString(a.name, targetLang),
      effect: await translateString(a.effect, targetLang),
    })),
  );

  const [weaknesses, resistances] = await Promise.all([
    Promise.all(text.weaknesses.map((w) => translateString(w, targetLang))),
    Promise.all(text.resistances.map((r) => translateString(r, targetLang))),
  ]);

  return { name, description, attacks, abilities, weaknesses, resistances, retreat };
}

export { FIELD_LABELS };
