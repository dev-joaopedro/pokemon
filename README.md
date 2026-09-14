# Pokémon Card Scanner

App web para colecionadores: fotografa uma carta Pokémon, identifica-a, mostra
preço e informações, e organiza tudo numa coleção pessoal.

## Arquitetura

```
deploy/                     ← publicado no Netlify (netlify.toml: publish = "deploy")
  index.html                ← shell da SPA (dashboard, scan, busca, detalhe, coleção)
  js/
    app.js                  ← orquestrador: estado, navegação, ligação dos módulos à UI
    scanner.js              ← câmera + identificação (visão -> fallback OCR local)
    tcgdex.js               ← cliente da API TCGdex (dados de cartas)
    pricing.js               ← preços (TCGdex) + câmbio (open.er-api.com)
    collection.js            ← coleção do usuário (localStorage)
    translate.js             ← tradução oficial (TCGdex) + automática (MyMemory)
    util.js                  ← fetch com timeout, pool de requisições, helpers

netlify/functions/
  identify-card.mjs          ← única função server-side: visão do Claude sobre a foto da carta
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
