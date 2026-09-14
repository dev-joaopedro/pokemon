/**
 * Coleção do usuário — persistida em localStorage.
 *
 * Cada item guarda um snapshot da carta (para funcionar offline e não
 * depender da API continuar no ar) mais os dados que só o dono da carta sabe:
 * quantidade, condição, idioma físico, variante e quando foi adicionada.
 */

import { formatMoney } from './pricing.js';

const STORE_KEY = 'pkmn_collection_v1';

export const CONDITIONS = [
  { code: 'NM', label: 'Near Mint' },
  { code: 'LP', label: 'Lightly Played' },
  { code: 'MP', label: 'Moderately Played' },
  { code: 'HP', label: 'Heavily Played' },
  { code: 'DMG', label: 'Damaged' },
];

export const VARIANTS = [
  { code: 'normal', label: 'Normal' },
  { code: 'reverse', label: 'Reverse Holo' },
  { code: 'holo', label: 'Holo' },
  { code: 'promo', label: 'Promo' },
  { code: 'full_art', label: 'Full Art' },
  { code: 'alternate_art', label: 'Alternate Art' },
  { code: 'illustration_rare', label: 'Illustration Rare' },
  { code: 'special_illustration_rare', label: 'Special Illustration Rare' },
  { code: 'secret_rare', label: 'Secret Rare' },
];

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function save(items) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(items));
    return true;
  } catch {
    return false; // storage cheio/bloqueado — chamador decide como avisar
  }
}

function uid() {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function listItems() {
  return load();
}

export function getItem(id) {
  return load().find((i) => i.id === id) || null;
}

/**
 * Adiciona (ou soma quantidade a) uma carta.
 * `entry`: { card, cardId, imageUrl, name, setName, number, lang, variant,
 *            condition, quantity, unitPrice, currency, priceSource, priceUpdated }
 */
export function addItem(entry) {
  const items = load();

  const dupe = items.find(
    (i) =>
      i.cardId === entry.cardId &&
      i.lang === entry.lang &&
      i.variant === entry.variant &&
      i.condition === entry.condition,
  );

  if (dupe) {
    dupe.quantity += entry.quantity;
    dupe.unitPrice = entry.unitPrice ?? dupe.unitPrice;
    dupe.currency = entry.currency ?? dupe.currency;
    dupe.priceSource = entry.priceSource ?? dupe.priceSource;
    dupe.priceUpdated = entry.priceUpdated ?? dupe.priceUpdated;
    save(items);
    return dupe;
  }

  const item = {
    id: uid(),
    addedAt: new Date().toISOString(),
    quantity: 1,
    condition: 'NM',
    variant: 'normal',
    ...entry,
  };
  items.push(item);
  save(items);
  return item;
}

export function updateItem(id, patch) {
  const items = load();
  const item = items.find((i) => i.id === id);
  if (!item) return null;
  Object.assign(item, patch);
  save(items);
  return item;
}

export function removeItem(id) {
  const items = load().filter((i) => i.id !== id);
  save(items);
}

/** Totais para o dashboard e o cabeçalho da coleção. */
export function getStats(items = load()) {
  const totalCards = items.reduce((sum, i) => sum + i.quantity, 0);
  const distinctCards = new Set(items.map((i) => i.cardId)).size;
  const totalValue = items.reduce((sum, i) => sum + (i.unitPrice || 0) * i.quantity, 0);

  let mostValuable = null;
  for (const i of items) {
    const v = (i.unitPrice || 0) * i.quantity;
    if (!mostValuable || v > mostValuable.value) mostValuable = { item: i, value: v };
  }

  return {
    totalCards,
    distinctCards,
    totalValue,
    mostValuable: mostValuable?.item || null,
    mostValuableValue: mostValuable?.value || 0,
  };
}

export function itemTotal(item) {
  return (item.unitPrice || 0) * item.quantity;
}

export function formatStat(value, currency) {
  return formatMoney(value, currency) ?? '—';
}

const SORTERS = {
  recent: (a, b) => new Date(b.addedAt) - new Date(a.addedAt),
  name: (a, b) => a.name.localeCompare(b.name, 'pt-BR'),
  value_desc: (a, b) => itemTotal(b) - itemTotal(a),
  value_asc: (a, b) => itemTotal(a) - itemTotal(b),
  set: (a, b) => (a.setName || '').localeCompare(b.setName || '', 'pt-BR'),
  rarity: (a, b) => (a.rarity || '').localeCompare(b.rarity || '', 'pt-BR'),
};

export function sortItems(items, sortKey = 'recent') {
  const sorter = SORTERS[sortKey] || SORTERS.recent;
  return [...items].sort(sorter);
}

export function filterItems(items, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return items;
  return items.filter((i) =>
    [i.name, i.setName, i.number, i.rarity].some((f) => String(f || '').toLowerCase().includes(q)),
  );
}

export function exportJSON() {
  return JSON.stringify(load(), null, 2);
}
