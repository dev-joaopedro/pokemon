/**
 * Preços — a fonte é o próprio objeto de carta da TCGdex (campo `pricing`,
 * dentro de `variants_detailed[]`), que já agrega:
 *   - Cardmarket, em EUR (mercado europeu)
 *   - TCGplayer, em USD (mercado americano)
 *
 * A TCGdex não expõe preço por estado de conservação (Near Mint, Lightly
 * Played, ...) nem por mercado brasileiro — por isso o app NUNCA inventa um
 * fator de desconto para isso. O que mostramos é sempre um valor com fonte e
 * data reais; o estado de conservação fica registrado na coleção do usuário
 * como metadado, sem ajustar o preço.
 *
 * Câmbio: open.er-api.com (gratuito, sem chave), cacheado 6h em localStorage.
 * Convertido a partir do valor de origem mais confiável para cada variante —
 * nunca de um preço já convertido.
 */

import { fetchJSON } from './util.js';

export const CURRENCIES = [
  { code: 'BRL', label: 'Real brasileiro', symbol: 'R$' },
  { code: 'USD', label: 'Dólar americano', symbol: 'US$' },
  { code: 'EUR', label: 'Euro', symbol: '€' },
  { code: 'GBP', label: 'Libra esterlina', symbol: '£' },
  { code: 'JPY', label: 'Iene japonês', symbol: '¥' },
  { code: 'CAD', label: 'Dólar canadense', symbol: 'CA$' },
  { code: 'AUD', label: 'Dólar australiano', symbol: 'A$' },
];

export const DEFAULT_CURRENCY = 'BRL';

const RATES_KEY = 'pkmn_rates_v1';
const RATES_TTL = 6 * 60 * 60 * 1000;

/** Busca as taxas com USD como base, cacheadas em localStorage por 6h. */
export async function getRates() {
  try {
    const cached = JSON.parse(localStorage.getItem(RATES_KEY) || 'null');
    if (cached && Date.now() - cached.at < RATES_TTL) return cached.rates;
  } catch { /* cache corrompido — ignora */ }

  const data = await fetchJSON('https://open.er-api.com/v6/latest/USD', { timeout: 8000 });
  const rates = data?.rates;
  if (!rates) throw new Error('Câmbio indisponível.');

  try {
    localStorage.setItem(RATES_KEY, JSON.stringify({ at: Date.now(), rates }));
  } catch { /* storage cheio ou bloqueado — segue sem cache */ }

  return rates;
}

function convert(amount, fromCcy, toCcy, rates) {
  if (fromCcy === toCcy) return amount;
  const usd = fromCcy === 'USD' ? amount : amount / rates[fromCcy];
  return toCcy === 'USD' ? usd : usd * rates[toCcy];
}

/**
 * TCGplayer publica um sub-objeto por acabamento (normal, holofoil,
 * reverse-holofoil, 1st-edition-holofoil, ...). Dado o tipo de variante da
 * carta, tentamos o acabamento correspondente primeiro — sem isso, uma carta
 * "normal" podia acabar mostrando o preço (mais caro) do reverse-holo.
 */
const FINISH_PREFERENCE = {
  normal: ['normal'],
  reverse: ['reverse-holofoil', 'reverse'],
  holo: ['holofoil', 'holo', '1st-edition-holofoil'],
  firstEdition: ['1st-edition-holofoil', '1st-edition-normal', '1st-edition'],
  wPromo: ['normal', 'holofoil'],
};

function pickTcgplayerFinish(tcgplayer, variantType) {
  for (const key of FINISH_PREFERENCE[variantType] || []) {
    const vals = tcgplayer[key];
    const amount = vals?.marketPrice ?? vals?.midPrice;
    if (typeof amount === 'number') return { amount, finish: key };
  }
  // Nenhum acabamento esperado bateu — usa o mais caro entre os disponíveis
  // em vez de deixar a variante sem preço nenhum.
  let best = null;
  for (const [finish, vals] of Object.entries(tcgplayer)) {
    if (finish === 'unit' || finish === 'updated' || !vals) continue;
    const amount = vals.marketPrice ?? vals.midPrice;
    if (typeof amount === 'number' && (!best || amount > best.amount)) best = { amount, finish };
  }
  return best;
}

/**
 * Extrai os melhores preços de cada fonte a partir de UM objeto `pricing` da
 * TCGdex. Esse objeto tanto pode vir de `variants_detailed[i].pricing`
 * (quando a carta tem mais de um acabamento) quanto do `pricing` no nível da
 * carta (que é o único lugar onde ele existe para a maioria das cartas com
 * variante única) — por isso a função não sabe nem precisa saber de onde
 * veio, só recebe o `variantType` para escolher o acabamento certo.
 */
function extractPricesFromPricingObject(pricing, variantType) {
  if (!pricing) return null;
  const out = { cardmarket: null, tcgplayer: null };

  if (pricing.cardmarket && typeof pricing.cardmarket.avg === 'number') {
    // Cartas holo/reverse têm uma trilha de preço "-holo" separada na Cardmarket.
    const isHoloish = variantType === 'holo' || variantType === 'reverse';
    const holoTrend = pricing.cardmarket['trend-holo'];
    const trend = isHoloish && typeof holoTrend === 'number' ? holoTrend : pricing.cardmarket.trend ?? pricing.cardmarket.avg;
    out.cardmarket = {
      amount: trend,
      currency: pricing.cardmarket.unit || 'EUR',
      updated: pricing.cardmarket.updated || null,
      label: 'Cardmarket (tendência)',
    };
  }

  if (pricing.tcgplayer) {
    const best = pickTcgplayerFinish(pricing.tcgplayer, variantType);
    if (best) {
      out.tcgplayer = {
        amount: best.amount,
        currency: pricing.tcgplayer.unit || 'USD',
        updated: pricing.tcgplayer.updated || null,
        label: `TCGplayer (${best.finish})`,
      };
    }
  }

  return out.cardmarket || out.tcgplayer ? out : null;
}

/** Preços de uma variante específica, com fallback para o `pricing` da carta. */
function extractVariantPrices(variant, cardPricingFallback) {
  return extractPricesFromPricingObject(variant?.pricing || cardPricingFallback, variant?.type);
}

/**
 * Preço de referência de uma carta, na variante pedida (ou na primeira
 * disponível), convertido para a moeda alvo.
 *
 * Devolve null quando a carta não tem NENHUM preço na fonte — nesse caso a UI
 * deve mostrar "Preço não encontrado", nunca estimar um valor.
 */
export async function getCardPrice(card, { variantType, targetCurrency = DEFAULT_CURRENCY } = {}) {
  const variants = Array.isArray(card?.variants_detailed) ? card.variants_detailed : [];

  const variant =
    variants.find((v) => v.type === variantType) ||
    variants.find((v) => extractVariantPrices(v, card?.pricing)) ||
    variants[0] ||
    null;

  let prices = variant ? extractVariantPrices(variant, card?.pricing) : null;
  const effectiveVariantType = variant?.type || variantType || 'normal';

  // Muitas cartas de variante única não têm `variants_detailed[].pricing` —
  // só o `pricing` agregado no nível da carta. Sem este fallback, essas
  // cartas apareceriam como "preço não encontrado" mesmo tendo preço real.
  if (!prices && card?.pricing) {
    prices = extractPricesFromPricingObject(card.pricing, effectiveVariantType);
  }

  if (!prices) return null;

  // Preferimos a fonte cujo mercado é mais líquido para o tipo de carta:
  // Cardmarket para o público europeu/BR (mais próximo do que se paga fora
  // dos EUA), TCGplayer como alternativa quando só ele existir.
  const primary = prices.cardmarket || prices.tcgplayer;
  const secondary = prices.cardmarket && prices.tcgplayer ? prices.tcgplayer : null;

  let rates = null;
  let rateError = null;
  try {
    rates = await getRates();
  } catch (err) {
    rateError = err;
  }

  const toDisplay = (src) => {
    if (!src) return null;
    const canConvert = rates && (src.currency === 'USD' || rates[src.currency] !== undefined);
    const converted = src.currency === targetCurrency
      ? src.amount
      : canConvert
        ? convert(src.amount, src.currency, targetCurrency, rates)
        : null;
    return {
      ...src,
      converted,
      convertedCurrency: converted !== null ? targetCurrency : null,
    };
  };

  return {
    variantType: effectiveVariantType,
    primary: toDisplay(primary),
    secondary: toDisplay(secondary),
    rateUnavailable: !rates && targetCurrency !== primary.currency,
    rateError: rateError?.message || null,
  };
}

/** Todas as variantes com preço, para o usuário escolher qual bate com a carta física dele. */
export function listPricedVariants(card) {
  const variants = Array.isArray(card?.variants_detailed) ? card.variants_detailed : [];
  const list = variants
    .map((v) => ({ type: v.type, prices: extractVariantPrices(v, card?.pricing) }))
    .filter((v) => v.prices);

  // Sem variantes detalhadas mas com preço agregado na carta: oferece ao
  // menos a variante "normal" em vez de deixar o seletor vazio.
  if (!list.length && card?.pricing) {
    const prices = extractPricesFromPricingObject(card.pricing, 'normal');
    if (prices) list.push({ type: 'normal', prices });
  }

  return list;
}

export function formatMoney(amount, currencyCode) {
  if (typeof amount !== 'number' || Number.isNaN(amount)) return null;
  const ccy = CURRENCIES.find((c) => c.code === currencyCode);
  try {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: currencyCode,
      minimumFractionDigits: currencyCode === 'JPY' ? 0 : 2,
      maximumFractionDigits: currencyCode === 'JPY' ? 0 : 2,
    }).format(amount);
  } catch {
    return `${ccy?.symbol || currencyCode} ${amount.toFixed(2)}`;
  }
}

/** Histórico curto a partir das médias móveis que a própria Cardmarket publica. */
export function priceHistoryFromCardmarket(card, variantType) {
  const variant = card?.variants_detailed?.find((v) => v.type === variantType) || card?.variants_detailed?.[0];
  const cm = variant?.pricing?.cardmarket || card?.pricing?.cardmarket;
  if (!cm) return [];

  const points = [
    { label: '30 dias', value: cm.avg30 },
    { label: '7 dias', value: cm.avg7 },
    { label: 'Ontem', value: cm.avg1 },
    { label: 'Atual', value: cm.trend ?? cm.avg },
  ].filter((p) => typeof p.value === 'number');

  return points.map((p) => ({ ...p, currency: cm.unit || 'EUR' }));
}
