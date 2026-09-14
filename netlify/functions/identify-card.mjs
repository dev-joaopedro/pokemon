/**
 * identify-card — lê uma foto de carta Pokémon e devolve os campos impressos nela.
 *
 * Recebe: { image: "data:image/jpeg;base64,..." }
 * Devolve: { ok: true, source: "vision", card: { ... } }
 *
 * A chave da API fica SÓ aqui (variável de ambiente ANTHROPIC_API_KEY no Netlify).
 * Se ela não estiver configurada, respondemos 503 com code NO_API_KEY para que o
 * frontend caia no OCR local (Tesseract) em vez de travar.
 */

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5';

/** Limite do corpo da requisição. Imagens maiores são rejeitadas antes de sair daqui. */
const MAX_IMAGE_BYTES = 4_500_000;
const ALLOWED_MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp']);

/* ── Rate limiting simples, por IP ──────────────────────────────────────────
   Serverless não compartilha memória entre instâncias, então isto é "best
   effort": corta rajadas vindas de uma mesma instância quente. Um limite duro
   exigiria um KV externo (ver README). */
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 30;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > RATE_MAX;
}

/* ── Contrato de saída ───────────────────────────────────────────────────── */

/* Todo campo é obrigatório e de tipo simples: o modo strict garante um objeto
   com essa forma exata, e string vazia carrega o "não consegui ler". */
const CARD_SCHEMA = {
  type: 'object',
  properties: {
    readable: {
      type: 'boolean',
      description: 'true se a imagem contém uma carta Pokémon TCG com texto legível.',
    },
    problem: {
      type: 'string',
      enum: ['none', 'blurry', 'no_card', 'too_dark', 'cropped', 'glare'],
      description: 'Principal obstáculo à leitura. "none" quando a foto está boa.',
    },
    name: {
      type: 'string',
      description:
        'Nome impresso no topo da carta, exatamente como aparece, incluindo sufixos como "ex", "V", "VMAX", "GX". Não inclua "HP" nem o valor de HP. String vazia se não conseguir ler.',
    },
    number: {
      type: 'string',
      description:
        'Número da carta dentro da coleção, só a parte antes da barra, sem zeros à esquerda. Ex.: "025/165" -> "25"; "TG04/TG30" -> "TG04"; "SWSH284" -> "SWSH284". String vazia se não conseguir ler.',
    },
    setTotal: {
      type: 'string',
      description: 'A parte depois da barra. Ex.: "025/165" -> "165". String vazia se a carta não tiver barra (promos) ou se não der para ler.',
    },
    setName: {
      type: 'string',
      description: 'Nome da coleção/expansão, se estiver escrito na carta. Normalmente não está — nesse caso, string vazia.',
    },
    setCode: {
      type: 'string',
      description: 'Sigla do set no rodapé, quando impressa. Ex.: "SVI", "PAF", "OBF". String vazia se ausente.',
    },
    language: {
      type: 'string',
      enum: ['en', 'pt', 'es', 'fr', 'de', 'it', 'ja', 'ko', 'zh', 'unknown'],
      description: 'Idioma do texto impresso na carta.',
    },
    rarityText: {
      type: 'string',
      description:
        'Símbolo de raridade no rodapé, descrito em palavras: "circle", "diamond", "star", "star H", "double star", "gold star", "crown". String vazia se não der para ver.',
    },
    variantHints: {
      type: 'array',
      items: {
        type: 'string',
        enum: [
          'normal', 'reverse_holo', 'holo', 'promo', 'full_art', 'alternate_art',
          'illustration_rare', 'special_illustration_rare', 'secret_rare',
          'first_edition', 'shadowless', 'gold', 'rainbow',
        ],
      },
      description:
        'Características visuais observadas. Use "reverse_holo" quando só a moldura brilha e a arte é fosca; "holo" quando a arte brilha. Array vazio se não der para julgar.',
    },
    illustrator: {
      type: 'string',
      description: 'Nome após "Illus." no rodapé. String vazia se ausente.',
    },
    year: {
      type: 'string',
      description: 'Ano no aviso de copyright do rodapé, 4 dígitos. String vazia se ausente.',
    },
    hp: {
      type: 'string',
      description: 'Valor de HP impresso no topo, só os dígitos. String vazia se a carta não for de Pokémon.',
    },
    confidence: {
      type: 'number',
      description: 'Confiança de 0 a 1 na leitura de nome + número juntos.',
    },
  },
  required: [
    'readable', 'problem', 'name', 'number', 'setTotal', 'setName', 'setCode',
    'language', 'rarityText', 'variantHints', 'illustrator', 'year', 'hp', 'confidence',
  ],
  additionalProperties: false,
};

const SYSTEM = `Você transcreve o que está IMPRESSO em cartas Pokémon TCG. Você não é um classificador de imagens.

Regras:
- Transcreva apenas o que consegue efetivamente ler na foto. Nunca complete com conhecimento prévio sobre qual carta "deveria" ser.
- Se um campo não estiver legível na imagem, devolva string vazia para ele. Uma string vazia é uma resposta correta; um chute não é.
- O número da carta fica no rodapé, normalmente à esquerda ou à direita, no formato "NNN/NNN".
- Cartas promocionais costumam ter um código sem barra (ex.: "SWSH284", "SM210").
- Cartas japonesas trazem o número no rodapé com o total abaixo ou ao lado, e usam sufixos diferentes.
- O nome fica no topo. Sufixos como "ex", "V", "VMAX", "VSTAR", "GX" fazem parte do nome e devem ser mantidos com a mesma capitalização impressa.
- "confidence" deve refletir o quanto você realmente enxergou. Foto tremida, com reflexo forte ou cortada merece confiança baixa mesmo que você consiga adivinhar a carta.
- Chame a ferramenta report_card exatamente uma vez.`;

/* ── Helpers ────────────────────────────────────────────────────────────── */

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

/** Separa um data URL em media type + base64, validando ambos. */
function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return { error: 'Imagem ausente.' };
  const m = /^data:([a-z/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  if (!m) return { error: 'Formato de imagem inválido. Envie um data URL base64.' };

  const mediaType = m[1].toLowerCase();
  if (!ALLOWED_MEDIA.has(mediaType)) {
    return { error: `Tipo de imagem não suportado: ${mediaType}` };
  }

  const data = m[2].replace(/\s/g, '');
  // 4 caracteres base64 = 3 bytes.
  const bytes = Math.floor((data.length * 3) / 4);
  if (bytes > MAX_IMAGE_BYTES) {
    return { error: 'Imagem muito grande. Reduza a resolução antes de enviar.' };
  }
  if (bytes < 2000) {
    return { error: 'Imagem vazia ou muito pequena.' };
  }
  return { mediaType, data };
}

/* ── Handler ────────────────────────────────────────────────────────────── */

export default async (req, context) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }
  if (req.method !== 'POST') {
    return json(405, { ok: false, code: 'METHOD', error: 'Use POST.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(503, {
      ok: false,
      code: 'NO_API_KEY',
      error:
        'Identificação por visão não configurada. Defina ANTHROPIC_API_KEY nas variáveis de ambiente do Netlify.',
    });
  }

  const ip = context?.ip || req.headers.get('x-nf-client-connection-ip') || 'anon';
  if (rateLimited(ip)) {
    return json(429, {
      ok: false,
      code: 'RATE_LIMIT',
      error: 'Muitas leituras seguidas. Espere um minuto e tente de novo.',
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, code: 'BAD_BODY', error: 'Corpo da requisição inválido.' });
  }

  const parsed = parseDataUrl(body?.image);
  if (parsed.error) {
    return json(400, { ok: false, code: 'BAD_IMAGE', error: parsed.error });
  }

  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 22_000 });

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      // Leitura de texto impresso não se beneficia de raciocínio longo, e a
      // função tem orçamento de 26s.
      output_config: { effort: 'low' },
      tools: [
        {
          name: 'report_card',
          description: 'Registra os campos lidos na carta.',
          strict: true,
          input_schema: CARD_SCHEMA,
        },
      ],
      tool_choice: { type: 'tool', name: 'report_card' },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data },
            },
            {
              type: 'text',
              text: 'Transcreva os campos impressos nesta carta. Deixe null o que não conseguir ler.',
            },
          ],
        },
      ],
    });

    if (response.stop_reason === 'refusal') {
      return json(422, {
        ok: false,
        code: 'REFUSED',
        error: 'Não foi possível analisar esta imagem.',
      });
    }

    const block = response.content.find((b) => b.type === 'tool_use');
    if (!block) {
      return json(502, {
        ok: false,
        code: 'NO_RESULT',
        error: 'O leitor não devolveu um resultado utilizável.',
      });
    }

    return json(200, { ok: true, source: 'vision', model: MODEL, card: block.input });
  } catch (err) {
    const status = err?.status;
    if (status === 401 || status === 403) {
      return json(503, {
        ok: false,
        code: 'BAD_API_KEY',
        error: 'A chave da API foi recusada. Verifique ANTHROPIC_API_KEY no Netlify.',
      });
    }
    if (status === 429) {
      return json(429, {
        ok: false,
        code: 'UPSTREAM_RATE_LIMIT',
        error: 'Serviço de leitura ocupado. Tente novamente em instantes.',
      });
    }
    console.error('identify-card falhou:', err?.message || err);
    return json(502, {
      ok: false,
      code: 'UPSTREAM',
      error: 'Serviço de leitura temporariamente indisponível.',
    });
  }
};

export const config = { path: '/api/identify-card' };
