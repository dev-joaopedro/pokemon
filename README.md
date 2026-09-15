# Pokémon Card Scanner

App web para colecionadores: fotografa uma carta Pokémon, identifica-a, mostra
preço e informações, e organiza tudo numa coleção pessoal.

## Arquitetura

```
deploy/                     ← publicado no Netlify (netlify.toml: publish = "deploy")
  index.html                ← shell da SPA (dashboard, scan, busca, detalhe, coleção)
  js/
    app.js                  ← orquestrador: estado, navegação, ligação dos módulos à UI
    scanner.js              ← câmera, contorno/warp (OpenCV.js) e identificação (visão/OCR)
    phash.js                ← pHash (DCT) puro — compartilhado entre navegador e o script offline
    phash-worker.js         ← Web Worker: calcula/compara pHash fora da thread de UI
    phash-db.js             ← wrapper do worker de pHash usado pela UI
    tcgdex.js               ← cliente da API TCGdex (dados de cartas)
    pricing.js               ← preços (TCGdex) + câmbio (open.er-api.com)
    collection.js            ← coleção do usuário (localStorage)
    translate.js             ← tradução oficial (TCGdex) + automática (MyMemory)
    util.js                  ← fetch com timeout, pool de requisições, helpers
  data/
    card-hashes.json         ← banco de pHash pré-computado (gerado por tools/build-phash-db.mjs)

netlify/functions/
  identify-card.mjs          ← única função server-side: visão do Claude sobre a foto da carta

tools/
  build-phash-db.mjs         ← script offline (Node) que gera deploy/data/card-hashes.json
```

Não há build step nem framework — é HTML + ES modules servidos estaticamente,
mais uma Netlify Function em Node para a única chamada que precisa de uma
chave secreta (identificação por visão).

## Por que cada fonte de dados

| Necessidade | Fonte | Por quê |
|---|---|---|
| Dados de cartas (nome, set, raridade, ataques...) | [TCGdex v2](https://tcgdex.dev) | Gratuita, sem chave, CORS aberto (`Access-Control-Allow-Origin: *`), imagens em alta, dados localizados oficialmente em 6 idiomas |
| Preços | Campo `pricing` da própria TCGdex (Cardmarket em EUR + TCGplayer em USD) | Já vem no card, com timestamp de atualização — sem precisar de outra integração |
| Câmbio | [open.er-api.com](https://www.exchangerate-api.com/docs/free) | Gratuita, sem chave, cacheada 6h |
| Identificação por foto | Claude (`claude-opus-5`, visão) via Netlify Function | Lê o texto impresso (nome, número, set, idioma, variante) em vez de "adivinhar" a carta pelo desenho |
| Tradução automática (quando a TCGdex não tem o idioma) | [MyMemory](https://mymemory.translated.net) | Gratuita, sem chave, CORS aberto — usada só como fallback e sempre identificada como "tradução automática" na tela |

A camada de dados fica isolada em `js/tcgdex.js` e `js/pricing.js`: trocar de
fonte no futuro significa reescrever esses dois arquivos, não o resto do app.

## Scanner ao vivo (detecção automática de contorno)

Enquanto o scanner está aberto, a cada ~400ms o app roda OpenCV.js sobre um
frame reduzido da câmera para achar o contorno quadrilátero da carta,
desenha esse contorno em tempo real sobre o vídeo e, quando ele fica parado
por alguns frames seguidos, endireita a carta (warp de perspectiva) e tenta
identificá-la em duas etapas, sem precisar apertar nenhum botão:

1. **OCR local** (Tesseract.js) sobre o recorte já endireitado — grátis, roda
   no aparelho.
2. **pHash** (hash perceptual da imagem) contra um banco de cartas
   conhecidas, comparado num Web Worker — usado só se o OCR não conseguir
   ler nome nem número.

O botão manual "Capturar" continua usando o caminho original (visão do
Claude, com fallback para OCR) — a chamada paga só acontece nessa ação
deliberada do usuário, nunca automaticamente durante o scan contínuo.

### Banco de pHash

`deploy/data/card-hashes.json` é o banco pré-computado, gerado por
`npm run build:phash-db` (script `tools/build-phash-db.mjs`, requer internet
e Node ≥ 20.10 — não foi possível rodá-lo no ambiente onde este recurso foi
desenvolvido, então o arquivo começa vazio (`[]`) neste repositório; veja
DEVLOG.md para o porquê). Independentemente do script, o app também aprende
sozinho: toda vez que uma carta é exibida na tela de detalhe, o hash da sua
imagem oficial (nunca da foto da câmera) é salvo num cache local
(IndexedDB), então o banco cresce com o uso real mesmo sem rodar o script.

## Configuração no Netlify

### Obrigatório para a identificação por visão funcionar

1. No painel do site: **Site configuration → Environment variables**
2. Adicione `ANTHROPIC_API_KEY` com uma chave da Anthropic Console (https://console.anthropic.com)
3. Faça um novo deploy (variáveis de ambiente só entram em builds novos)

A chave **nunca** entra no frontend — ela só existe dentro de
`netlify/functions/identify-card.mjs`, que roda no servidor.

**Sem essa variável configurada:** o app não trava. O scanner detecta a
ausência da chave (resposta `503 NO_API_KEY`) e cai automaticamente para OCR
local via Tesseract.js — mais limitado (só lê nome e número, sem set/idioma/
variante), mas funcional offline de backend.

### Nada mais precisa de configuração

TCGdex, open.er-api.com e MyMemory são todas gratuitas e sem chave — não há
outro segredo para gerenciar.

## Limitações conhecidas (documentadas, não escondidas)

- **Preço por estado de conservação (NM/LP/MP/HP/Damaged):** nenhuma das
  fontes de preço usadas expõe isso. O app deixa o usuário registrar a
  condição da carta na coleção, mas não aplica um desconto inventado sobre o
  preço — o valor mostrado é sempre o de mercado, com a fonte e a data
  visíveis. Se uma fonte de preço por condição for integrada no futuro, o
  ponto de extensão é `js/pricing.js`.
- **Japonês:** a TCGdex ainda não publica cartas em japonês (404 na API).
  Nesse caso a tradução cai para automática (MyMemory) a partir do inglês, e
  a interface avisa isso explicitamente.
- **Rate limit da função de visão:** é por instância de servidor (memória do
  processo), não um limite duro global — suficiente para conter abuso
  casual, mas não substitui um KV/Redis se o tráfego crescer.
- **Banco de pHash vazio por padrão:** `deploy/data/card-hashes.json` começa
  como `[]`. O fallback por imagem só funciona bem depois de rodar
  `npm run build:phash-db` (uma vez, com internet) ou depois de algum uso
  real do app (cada carta vista na tela de detalhe ensina seu próprio hash).
  Sem nenhuma das duas coisas, o scan automático conta só com o OCR local.
- **Limiares de contorno/estabilidade/nitidez não calibrados com câmera
  real:** foram escolhidos por raciocínio (ver comentários em
  `js/scanner.js`), sem acesso a uma câmera física neste ambiente de
  desenvolvimento. Ajuste-os em `AUTO_SCAN_THRESHOLDS` depois de testar em
  um celular de verdade.
