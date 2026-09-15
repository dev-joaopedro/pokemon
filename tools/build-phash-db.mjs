#!/usr/bin/env node
/**
 * Gera `deploy/data/card-hashes.json` — o banco de pHash pré-computado que o
 * scanner usa como fallback quando o OCR não consegue ler o código impresso
 * da carta.
 *
 * Baixa a lista de cartas da TCGdex, busca a imagem oficial de cada uma
 * (tamanho "low", já suficiente para um hash perceptual) e calcula o hash
 * com o MESMO algoritmo que o navegador usa ao vivo (`deploy/js/phash.js`,
 * importado diretamente aqui) — isso garante que um hash calculado offline
 * é diretamente comparável ao hash calculado no celular durante o scan.
 *
 * IMPORTANTE — por que este script existe separado do app e precisa ser
 * rodado manualmente: o ambiente onde este projeto foi desenvolvido não tinha
 * acesso a `api.tcgdex.net`/`assets.tcgdex.net` (timeout de conexão testado
 * diretamente), então este script nunca foi executado nem validado contra
 * dados reais nesta sessão — não fabricamos um banco de hashes falso para
 * simular que funciona. Rode-o você mesmo, numa máquina com internet livre,
 * sempre que quiser (re)gerar o banco. Ele é incremental: cartas que já
 * estão no arquivo de saída não são baixadas de novo.
 *
 * Requer Node >= 20.10 (a versão instalada do `sharp` usa import attributes
 * de JSON, que precisam dessa versão ou mais nova — testado localmente com
 * Node 20.9 e falha nesse ponto; o ambiente onde este projeto foi
 * desenvolvido só tinha 20.9 disponível, por isso o script foi validado com
 * uma versão mais antiga do `sharp` temporariamente e depois restaurado à
 * versão segura de verdade — ver DEVLOG.md).
 *
 * Uso:
 *   npm install                     # instala a dependência `sharp` (decodificação de imagem)
 *   npm run build:phash-db          # roda com os padrões (idioma en, todas as coleções)
 *
 *   node tools/build-phash-db.mjs --sets base1,base2   # só essas coleções (bom p/ testar)
 *   node tools/build-phash-db.mjs --limit 200          # para nos primeiros 200 cartas (teste rápido)
 *   node tools/build-phash-db.mjs --concurrency 4      # menos requisições em paralelo
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { computePHash, PHASH_IMG_SIZE } from '../deploy/js/phash.js';

const BASE = 'https://api.tcgdex.net/v2';

function parseArgs(argv) {
  const args = { lang: 'en', concurrency: 8, out: 'deploy/data/card-hashes.json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lang') args.lang = argv[++i];
    else if (a === '--sets') args.sets = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
  }
  return args;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return res.json();
}

async function pool(items, limit, worker) {
  const results = [];
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        console.error(`  [erro] ${items[i]?.id ?? i}: ${err.message}`);
        results[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

/**
 * A resposta de `/sets/{id}` pode ou não trazer o campo `image` de cada carta
 * embutido no resumo — não pudemos confirmar isso ao vivo neste ambiente
 * (sem acesso à API). Por segurança, se `image` não vier no resumo, busca a
 * carta completa em `/cards/{id}` antes de desistir dela.
 */
async function resolveCardImage(card, lang) {
  if (card.image) return card.image;
  const full = await fetchJSON(`${BASE}/${lang}/cards/${encodeURIComponent(card.id)}`);
  return full.image || null;
}

async function hashCardImage(imageBaseUrl) {
  const res = await fetch(`${imageBaseUrl}/low.png`);
  if (!res.ok) throw new Error(`imagem HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const { data } = await sharp(buf)
    .resize(PHASH_IMG_SIZE, PHASH_IMG_SIZE, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return computePHash(Float64Array.from(data));
}

async function loadExisting(path) {
  try {
    const raw = await readFile(path, 'utf8');
    const list = JSON.parse(raw);
    return new Map(Array.isArray(list) ? list.map((e) => [e.id, e]) : []);
  } catch {
    return new Map();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log(`Buscando coleções (idioma ${args.lang})...`);
  let sets = await fetchJSON(`${BASE}/${args.lang}/sets`);
  if (args.sets) sets = sets.filter((s) => args.sets.includes(s.id));
  console.log(`${sets.length} coleção(ões) selecionada(s).`);

  const existing = await loadExisting(args.out);
  console.log(`${existing.size} carta(s) já no banco existente (não serão recalculadas).`);

  let allCards = [];
  for (const set of sets) {
    process.stdout.write(`  listando ${set.id}... `);
    try {
      const detail = await fetchJSON(`${BASE}/${args.lang}/sets/${encodeURIComponent(set.id)}`);
      const cards = (detail.cards || []).map((c) => ({ ...c, setId: set.id }));
      allCards.push(...cards);
      console.log(`${cards.length} carta(s)`);
    } catch (err) {
      console.log(`falhou (${err.message})`);
    }
    if (args.limit && allCards.length >= args.limit) {
      allCards = allCards.slice(0, args.limit);
      break;
    }
  }
  console.log(`${allCards.length} carta(s) no total.`);

  const todo = allCards.filter((c) => c.id && !existing.has(c.id));
  console.log(`${todo.length} carta(s) sem hash ainda — baixando imagem e calculando pHash...`);

  let done = 0;
  let failed = 0;
  await pool(todo, args.concurrency, async (card) => {
    const imageUrl = await resolveCardImage(card, args.lang);
    if (!imageUrl) throw new Error('carta sem imagem cadastrada na TCGdex');
    const hash = await hashCardImage(imageUrl);
    existing.set(card.id, {
      id: card.id,
      hash,
      name: card.name || '',
      number: String(card.localId ?? ''),
      setId: card.setId || '',
    });
    done++;
    if (done % 50 === 0) console.log(`  ${done}/${todo.length} processadas...`);
  });
  failed = todo.length - done;

  await mkdir(dirname(args.out), { recursive: true });
  const out = [...existing.values()];
  await writeFile(args.out, JSON.stringify(out));
  console.log(`\nPronto: ${out.length} carta(s) no banco (${done} nova(s), ${failed} falharam), salvo em ${args.out}.`);
  if (failed > 0) {
    console.log('Rode o script de novo para tentar de novo só as que faltam (o script é incremental).');
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error('Falha ao gerar o banco de pHash:', err);
    process.exitCode = 1;
  });
}
