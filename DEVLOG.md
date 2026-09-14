# Diário de desenvolvimento — Pokémon Card Scanner

Este arquivo documenta, em detalhe, tudo que foi investigado, decidido,
construído e testado nesta sessão de trabalho. É o registro técnico completo;
o [README.md](README.md) é a versão resumida para quem só precisa rodar o
projeto ou configurá-lo no Netlify.

---

## 1. Estado do projeto antes desta sessão

O repositório continha:

- `deploy/index.html` (772 linhas) — único arquivo publicado no Netlify
  (`netlify.toml`: `publish = "deploy"`). HTML + CSS + JS tudo inline, sem
  build, sem framework.
- `busca_pokemon.html` (734 linhas, na raiz) — cópia divergente e mais antiga
  do mesmo app, **não publicada** (fora da pasta `deploy/`). Não fazia parte
  do site em produção.
- `netlify.toml` com apenas `[build] publish = "deploy"` — sem Functions,
  sem headers, sem configuração de runtime.
- `LICENSE`, `.gitignore` (ignorava só `iniciar_servidor.ps1`), e um script
  PowerShell local (`iniciar_servidor.ps1`, gitignored) provavelmente usado
  para servir a pasta localmente durante o desenvolvimento anterior.
- 7 commits no histórico, os últimos 4 todos tentando consertar o OCR:
  `34208c0` (corrige netlify.toml) → `0fed167` (lê carta inteira) →
  `ed9f2e5` (duas passagens de OCR) → `560ed7f` (contrast CSS filter) →
  `047bfc1` (sincroniza deploy com essas mudanças). Isso já indicava, antes
  de eu ler uma linha de código, que o OCR vinha sendo a fonte de dor
  recorrente do projeto.

### Como a leitura de carta funcionava

Busca por número: pega o texto digitado (ex.: `117/94`), separa
`localId=117` e `total=94`, busca a lista de **todos** os sets da TCGdex v2,
filtra os sets cujo `cardCount` bate com `94`, e dispara um `fetch` por set
candidato para `GET /v2/en/sets/{setId}/{localId}` — em paralelo, sem limite
de concorrência (podendo chegar a **170 requisições simultâneas** quando o
número não vem com o total, porque aí nenhum set é descartado antes).

Câmera: `getUserMedia` pedindo a câmera traseira, um `<video>` full-screen com
uma guia (`#scan-box`) desenhada por CSS por cima (não recorta de fato a
imagem, é só uma referência visual). Ao capturar, desenha o frame inteiro do
vídeo (`videoWidth` × `videoHeight`) num canvas.

OCR: Tesseract.js 5 carregado via `<script>` dinâmico na primeira leitura.
Recorta o topo do canvas (0–18% da altura) para o nome e o rodapé (85–100%)
para o número, aplica um filtro de contraste CSS (`contrast(2.5) saturate(0)`)
e roda `Tesseract.recognize(canvas, 'eng', { tessedit_pageseg_mode, tessedit_char_whitelist })`
várias vezes com PSMs diferentes (7, 8, 13) e variantes da imagem (original,
contraste, invertida) até achar algo que pareça um número.

### Diagnóstico: por que a leitura não funcionava

Encontrei três problemas concretos no código de OCR, nenhum deles de
configuração de ambiente (**não havia problema de CORS, nem de variável de
ambiente, nem de Netlify mal configurado** — a TCGdex responde
`Access-Control-Allow-Origin: *` e o app nunca teve backend):

1. **Os parâmetros do Tesseract eram descartados.**
   `Tesseract.recognize(canvas, 'eng', opts)` — a assinatura da v5 do
   Tesseract.js não aceita um terceiro argumento de opções nessa chamada de
   conveniência; `tessedit_pageseg_mode` e `tessedit_char_whitelist` nunca
   chegavam a ser aplicados. Todo o ajuste fino de PSM/whitelist do commit
   `560ed7f` era, na prática, inócuo — o Tesseract sempre rodava no modo
   automático padrão, sem whitelist nenhuma.
2. **Um worker novo (e um download do modelo de idioma) a cada chamada.**
   Sem reaproveitar o worker entre as ~6-9 chamadas de `recognize` de uma
   única leitura, cada uma recarregava o modelo `eng.traineddata`. Em
   conexão de celular isso facilmente estourava qualquer paciência do
   usuário, e em conexões mais lentas simplesmente travava.
3. **Os recortes eram cegos ao enquadramento real.** `cropRegion` assumia
   que a carta preenchia o frame inteiro (0% a 100% da largura), mas a
   captura desenhava o vídeo inteiro — incluindo qualquer fundo fora da
   guia visual `#scan-box`. Numa foto de celular típica, isso significa que
   o "rodapé da carta" nem sempre cai nos 85–100% da altura da imagem
   capturada.

Acima desses três bugs, havia um problema de fundo maior: **OCR genérico
sobre foto de carta holográfica** (reflexo, textura, perspectiva, fonte
estilizada) é a ferramenta errada para o trabalho, mesmo sem bugs. E mesmo
funcionando perfeitamente, Tesseract nunca leria símbolo de set, variante,
idioma ou raridade — exatamente os campos que o pedido original exige.

---

## 2. Decisões de arquitetura

### 2.1. Identificação da carta: visão do Claude + Netlify Function

**Decisão:** trocar OCR genérico por uma Netlify Function
(`netlify/functions/identify-card.mjs`) que envia a foto para o Claude
(`claude-opus-5`, com visão) e recebe de volta um JSON estruturado via
*tool use* com `strict: true`.

**Por quê:**
- Lê o texto impresso de verdade (nome, número, total do set, idioma,
  raridade em palavras, variante, ilustrador, ano), não só "qual desenho
  parece esse Pokémon".
- Tolera reflexo, ângulo e holografia muito melhor que um pipeline de
  contraste + whitelist de caracteres.
- `strict: true` no schema da tool garante que a resposta é sempre um objeto
  com exatamente os campos esperados — sem parsing manual de texto livre.
- Uma chave de API secreta **nunca pode ir para o frontend**; por isso a
  chamada mora inteiramente numa Netlify Function server-side, e o frontend
  só fala com `/api/identify-card` (redirecionado via `netlify.toml`).

**Contrato de erro pensado para nunca travar a tela:**
- Sem `ANTHROPIC_API_KEY` configurada → `503 NO_API_KEY` → o frontend cai
  automaticamente para o OCR local (Tesseract, agora corrigido) em vez de
  travar.
- Corpo/imagem inválidos → `400 BAD_BODY` / `400 BAD_IMAGE` com mensagem
  específica (imagem ausente, formato não suportado, muito grande, muito
  pequena).
- Chave rejeitada pela Anthropic (401/403) → `503 BAD_API_KEY` com instrução
  de onde corrigir.
- Rate limit da Anthropic (429) → `429 UPSTREAM_RATE_LIMIT`.
- Qualquer outro erro do upstream → `502 UPSTREAM`, nunca deixa a promise
  pendurada (a função tem timeout de 22s no cliente da Anthropic e 26s no
  `netlify.toml`).
- Rate limiting próprio, por IP, best-effort (30 leituras / 10 min por
  instância de servidor quente) — documentado como não-garantido entre
  instâncias frias, já que serverless não compartilha memória.

**Schema pensado para nunca inventar dado:** todo campo textual aceita
string vazia como resposta válida ("não consegui ler"), e o prompt do
sistema instrui explicitamente a nunca completar com conhecimento prévio
sobre "qual carta deveria ser". `confidence` reflete legibilidade real da
foto, não a confiança de um palpite.

### 2.2. Dados de cartas: TCGdex v2

**Decisão:** manter a TCGdex v2 (já usada no código antigo) como única fonte
de dados de cartas, mas isolada atrás de `js/tcgdex.js` para poder trocar no
futuro sem tocar no resto do app.

**Por quê (confirmado testando a API ao vivo, não por lembrança de
treinamento):**
- `curl -I https://api.tcgdex.net/v2/en/sets` devolve
  `Access-Control-Allow-Origin: *` — CORS aberto de verdade, chamável direto
  do navegador.
- Gratuita, sem chave.
- Localização oficial confirmada em `en`, `fr`, `es`, `it`, `pt`, `de`
  (`curl` retornando 200 para cada); `ja`, `ko`, `zh-tw` etc. retornam 404 —
  **japonês não está disponível na fonte hoje**, documentado como limitação
  conhecida.
- **Descoberta importante:** o card object da TCGdex agora inclui preço de
  mercado embutido (campo `pricing` e `variants_detailed[].pricing`) — isso
  não era esperado antes de eu consultar a API ao vivo, e mudou a arquitetura
  de preços (ver 2.3): não precisei integrar uma segunda API só para preços.

### 2.3. Preços: campo `pricing` da própria TCGdex

**Decisão:** usar `card.pricing` / `card.variants_detailed[].pricing`
(Cardmarket em EUR, TCGplayer em USD) como única fonte de preço, com câmbio
via `open.er-api.com`.

**Por quê:** ver a descoberta acima. Evita integrar e manter chave de uma
terceira API (ex.: TCGplayer API oficial exige aprovação de parceria).

**Limitação documentada, não escondida:** nenhuma das duas fontes
(Cardmarket, TCGplayer) expõe preço por estado de conservação (Near Mint /
Lightly Played / etc.) nem um preço específico do mercado brasileiro. O app
**não inventa** um fator de desconto por condição — mostra sempre o preço de
mercado real, com fonte e data, e guarda a condição da carta como metadado
da coleção do usuário, não como multiplicador de preço. Isso é uma
implementação explícita do pedido do usuário ("não simplesmente converter...
se existir um preço específico" e "não inventar preços").

**Câmbio:** `open.er-api.com/v6/latest/USD`, testado ao vivo
(`curl` retornando `{"result":"success", "rates": {...}}`), gratuito, sem
chave, cacheado 6h em `localStorage` para não bater na API a cada render.
Conversão sempre a partir da moeda de origem do preço (EUR da Cardmarket ou
USD da TCGplayer), nunca de um valor já convertido — evita erro composto de
arredondamento/spread.

### 2.4. Tradução: TCGdex (oficial) + MyMemory (automática, só como fallback)

**Decisão:** para os 6 idiomas que a TCGdex já serve nativamente, buscar o
card completo naquele idioma — isso é o texto oficialmente impresso, não uma
tradução automática. Só cair para tradução automática (MyMemory, testada ao
vivo com CORS aberto) quando a TCGdex não tiver a carta naquele idioma
(japonês, hoje).

**Por quê:** o pedido explicitamente distingue "texto original" de
"tradução" e pede para marcar tradução automática como tal. Usar o dado
oficial da própria fonte sempre que ele existe é estritamente melhor que
traduzir automaticamente um texto que já existe corretamente localizado.

### 2.5. Coleção: `localStorage`

**Decisão:** manter a coleção do usuário inteiramente no navegador
(`localStorage`), sem backend/banco de dados.

**Por quê:** o projeto não tinha login nem qualquer sistema de contas antes
desta sessão, e nada no pedido pede autenticação de usuário. Adicionar um
banco de dados real (e a autenticação que isso implicaria) seria expandir o
escopo além do que foi pedido. `localStorage` é suficiente para "a coleção
passa a mostrar o valor estimado total" funcionar de ponta a ponta num único
dispositivo. Documentado como ponto de extensão futuro se o usuário quiser
sincronizar entre dispositivos.

---

## 3. Arquivos criados/modificados e por quê

| Arquivo | O que mudou | Por quê |
|---|---|---|
| `netlify.toml` | Adicionado `functions`, timeout da function, headers de cache e segurança | Habilitar Netlify Functions e endurecer headers básicos (nosniff, referrer-policy, permissions-policy restringindo câmera a same-origin) |
| `package.json` | **Novo** — dependência `@anthropic-ai/sdk` | A function precisa do SDK oficial da Anthropic |
| `netlify/functions/identify-card.mjs` | **Novo** | Identificação por visão (ver 2.1) |
| `deploy/index.html` | Reescrito por completo | De um app de busca manual para um app com dashboard, scanner, confirmação, detalhe, coleção e busca — ver seção 4 |
| `deploy/js/util.js` | **Novo** | `fetch` com timeout obrigatório (nunca deixar uma tela de carregamento infinita), pool de requisições com concorrência limitada, helpers de escape/formatação |
| `deploy/js/tcgdex.js` | **Novo** | Cliente da TCGdex — busca por nome/número, resolução de leitura do scanner em candidatos, enriquecimento de dados (ver bug #2 na seção 5) |
| `deploy/js/pricing.js` | **Novo** | Extração de preço por variante, conversão de moeda, histórico curto |
| `deploy/js/collection.js` | **Novo** | CRUD da coleção em `localStorage`, estatísticas, ordenação/filtro |
| `deploy/js/translate.js` | **Novo** | Tradução oficial vs. automática |
| `deploy/js/scanner.js` | **Novo** | Câmera, captura, identificação (visão → fallback OCR local corrigido) |
| `deploy/js/app.js` | **Novo** | Orquestrador: estado global, navegação entre telas, ligação de todos os módulos à UI |
| `README.md` | **Novo** | Documentação resumida: arquitetura, fontes de dados, configuração no Netlify, limitações |
| `DEVLOG.md` | **Novo** (este arquivo) | Registro técnico completo desta sessão |
| `.gitignore` | Adicionado `node_modules/`, `.netlify/`, `.env*` | Consequência de agora ter uma dependência npm e rodar `netlify dev` localmente |

`busca_pokemon.html` (raiz) **não foi tocado** — não faz parte do site
publicado (fora de `deploy/`), e apagá-lo não era necessário para nenhum dos
objetivos pedidos.

---

## 4. O que a UI ganhou

Antes: uma tela única com campo de busca por número + resultado.

Depois — seguindo o fluxo pedido item por item:

1. **Dashboard** (`view-dashboard`): valor total da coleção (na moeda
   selecionada), contagem de cartas, cartas diferentes, carta mais valiosa,
   últimas adicionadas, botão grande "ESCANEAR CARTA".
2. **Scanner** (`#scan-modal`): câmera traseira com guia de enquadramento,
   captura, opção de galeria, spinner com mensagens de progresso
   ("Lendo nome...", "Lendo número...").
3. **Confirmação** (`view-confirm`): mostra o que foi lido da foto
   (nome/número/confiança) e a lista de cartas candidatas — nunca adiciona
   automaticamente quando há mais de uma opção ou confiança baixa.
4. **Detalhe** (`view-detail`): imagem (nunca alterada), nome, Pokémon,
   número, coleção, raridade, idioma, ano, ilustrador, preço com fonte e
   data, histórico curto, seletor de variante, formulário de
   quantidade/condição, botão adicionar/salvar/remover, bloco de tradução
   (texto original vs. tradução, com selo "oficial" ou "automática").
5. **Coleção** (`view-collection`): estatísticas, busca, ordenação (recente,
   nome, valor, coleção, raridade), lista editável.
6. **Busca manual** (`view-search`): por nome ou número, mesma lógica de
   candidatos do scanner.

Navegação inferior fixa (estilo app mobile) com atalho central para o
scanner. Tema escuro dourado/laranja preservado do design anterior (era a
única parte do código antigo que já funcionava bem visualmente).

---

## 5. Testes realizados e bugs encontrados

Sem acesso a `chromium-cli` neste ambiente (Windows, sem o binário
disponível), o navegador foi validado com Playwright (Chromium) instalado
sob demanda — ver metodologia abaixo. Fui transparente sobre essa escolha em
vez de pular a validação visual.

### 5.1. Metodologia

1. **Sintaxe:** todos os módulos ES verificados com
   `node --input-type=module --check` (o `--check` do Node não aceita
   `import`/`export` em arquivos `.js` sem essa flag).
2. **Servidor real:** `netlify dev` rodando a pasta `deploy/` de verdade
   (não um servidor estático improvisado).
3. **Function isolada:** como o `netlify dev` local exige Node ≥ 20.12.2
   para emular Functions (aqui só havia 20.9.0 — **limitação do ambiente
   local, não do código**; o Netlify controla a versão de runtime em
   produção via `netlify.toml`/build image), testei
   `netlify/functions/identify-card.mjs` chamando o handler exportado
   diretamente em Node, com objetos `Request` reais (a Web API `Request` do
   Node ≥ 18, não um mock manual).
4. **Chamada real à Anthropic com chave inválida:** para confirmar que o
   mapeamento de erro 401→503 funciona de ponta a ponta (não só no papel),
   fiz uma chamada de verdade à API da Anthropic com uma chave no formato
   certo mas inválida, e conferi a resposta.
5. **Navegador real:** Playwright + Chromium (baixado nesta sessão,
   ~115 MB) navegando `http://localhost:8888` e interagindo com os
   controles reais (preencher busca, clicar em resultado, trocar select de
   tradução, clicar em adicionar à coleção, navegar entre abas), com
   screenshot em cada etapa e captura de `console.error`/`pageerror`.

### 5.2. Bugs encontrados e corrigidos durante o teste (não hipotéticos — vistos rodando)

1. **Ataques sem nome/efeito.** A carta de teste (`bw3-4`, Petilil, set de
   2011) tem `attacks[].name` e `.effect` vazios na resposta em português da
   TCGdex, mas presentes em inglês — uma lacuna de localização da própria
   fonte para sets antigos. **Fix:** `tcgdex.js` ganhou `getCardEnriched()`,
   que detecta nome/efeito vazio e busca a versão em inglês só para
   preencher esses campos especificamente (nunca substitui nome, número ou
   qualquer outro campo que já veio certo).
2. **"Preço não encontrado" para cartas com preço real.** A mesma carta tem
   `pricing` só no nível da carta (`card.pricing`), não dentro de
   `variants_detailed[].pricing` — isso só acontece para cartas com um único
   acabamento; cartas com holo/reverse têm os dois níveis preenchidos (por
   isso não apareceu nos meus testes de API isolados antes, que usaram
   cartas holo). **Fix:** `pricing.js` agora usa `card.pricing` como
   fallback sempre que a variante não tem seu próprio bloco de preço, e
   escolhe o acabamento do TCGplayer (`normal`/`holofoil`/`reverse-holofoil`/
   ...) de acordo com o tipo de variante pedido, em vez de pegar sempre o
   mais caro disponível.
3. **"Ano" sempre vazio.** O resumo de set embutido dentro da resposta de
   uma carta (`card.set`) não tem `releaseDate` — esse campo só existe no
   endpoint de detalhe do set (`GET /v2/{lang}/sets/{setId}`). **Fix:**
   `tcgdex.js` ganhou `getSetDetail()` (cacheado) e `getCardYear()`; a tela
   de detalhe renderiza primeiro sem o ano e completa a célula assim que a
   segunda chamada volta, sem atrasar o resto da tela.
4. **Painel "Tradução" em branco onde o "Original" já mostrava texto.**
   Consequência do bug 1: o texto original (retirado do card já enriquecido
   em `app.js`) mostrava o fallback em inglês, mas o painel de tradução
   buscava a carta traduzida "crua" (`getCardTranslation`, sem
   enriquecimento), reproduzindo a mesma lacuna de localização. **Fix:**
   `translate.js` passou a usar `getCardTranslationEnriched()` para o
   caminho de tradução oficial, mantendo os dois painéis consistentes.
5. **Mapeamento de variante do scanner para a TCGdex.** O schema de visão
   usa nomes como `reverse_holo`/`first_edition`; os tipos de variante da
   TCGdex usam `reverse`/`firstEdition`. Sem tradução entre os dois
   vocabulários, a variante detectada na foto nunca batia com a variante
   real da carta no seletor de preço. **Fix:** tabela de mapeamento
   `VARIANT_HINT_TO_TCGDEX` em `app.js`.
6. **Bug de edição na coleção (encontrado por inspeção de código, não em
   runtime):** salvar uma edição que muda variante/condição chamava
   `Collection.addItem()` (que cria um item novo quando a chave
   cardId+idioma+variante+condição muda) **antes** de `updateItem()` corrigir
   a quantidade — na prática, para qualquer edição que trocasse variante ou
   condição, o app ficaria com dois itens na coleção em vez de um atualizado.
   **Fix:** `saveToCollection()` agora bifurca completamente: item existente
   vai só para `updateItem()`, nunca passa por `addItem()`.
7. **Otimização morta em `runTranslation()` (inspeção de código):** o código
   tentava reaproveitar a carta já carregada como base para a tradução
   automática checando `card.lang === 'en'` — mas o objeto de carta da
   TCGdex não tem campo `lang` (o idioma é implícito na URL da requisição,
   não fica gravado na resposta), então a condição era sempre falsa e a
   função sempre refazia uma busca em inglês, mesmo quando já tinha a carta
   em inglês em mãos. Não causava dado errado, só uma requisição
   desnecessária. **Fix:** trocado para `state.lang === 'en'`, que é onde o
   idioma da carta carregada realmente fica registrado.

Depois dos fixes 1–4, repeti a captura de tela e confirmei visualmente: ano
"2011" aparecendo, preço "R$ 0,95" com histórico de 4 pontos e variação
percentual, ataques "Ram"/"Absorb" com nome e efeito nos dois painéis de
tradução, e nenhuma duplicata na coleção depois de adicionar.

### 5.3. Cenários de erro da Function testados diretamente

Chamando `identify-card.mjs` sem passar pelo emulador do `netlify dev`
(por causa da limitação de versão de Node do ambiente local):

| Cenário | Status | Código |
|---|---|---|
| Sem `ANTHROPIC_API_KEY` | 503 | `NO_API_KEY` |
| Método GET | 405 | `METHOD` |
| Corpo não-JSON | 400 | `BAD_BODY` |
| Sem campo `image` | 400 | `BAD_IMAGE` |
| Data URL malformado | 400 | `BAD_IMAGE` |
| `image/gif` (tipo não suportado) | 400 | `BAD_IMAGE` |
| Imagem muito pequena (< 2000 bytes) | 400 | `BAD_IMAGE` |
| Chave no formato certo mas inválida (chamada real à Anthropic) | 503 | `BAD_API_KEY` |

Nenhum cenário lançou exceção não tratada nem deixou a resposta pendurada —
o requisito de "nunca travar numa tela de carregamento infinita" está
coberto tanto no cliente (`fetchJSON` com timeout obrigatório em
`util.js`) quanto no servidor (timeout do cliente Anthropic + timeout da
function no `netlify.toml`).

### 5.4. O que **não** foi testado (limitação honesta)

- **A identificação por visão de verdade**, com uma `ANTHROPIC_API_KEY`
  válida e uma foto real de carta. Não há chave configurada neste ambiente
  de desenvolvimento. O contrato de entrada/saída da function foi validado
  (schema, tratamento de erro, chamada real à API só para confirmar o
  mapeamento de erro de autenticação), mas a qualidade da leitura em fotos
  reais — ângulos ruins, reflexo forte, letra pequena — só pode ser
  validada com uso real após configurar a chave no Netlify.
- **Câmera real de celular.** O Chromium headless usado no teste não tem
  câmera; o fluxo de captura por câmera não pôde ser exercitado fim-a-fim
  (o fallback de galeria/arquivo, sim, está implementado e testado no nível
  de código, mas não clicado neste teste).

---

## 6. Limitações conhecidas (repetidas do README, para quem só lê este arquivo)

- Preço por estado de conservação: não existe nas fontes usadas; não é
  inventado.
- Japonês: TCGdex não publica cartas nesse idioma hoje; tradução cai para
  automática (MyMemory) a partir do inglês, sinalizada como tal na tela.
- Rate limit da function de visão é por instância de servidor (memória de
  processo), não um limite duro global.
- Coleção é local ao navegador (`localStorage`), sem sincronização entre
  dispositivos.

## 7. O que falta para funcionar 100% em produção

Só uma coisa: configurar `ANTHROPIC_API_KEY` nas variáveis de ambiente do
site no Netlify (Site configuration → Environment variables) e fazer um novo
deploy. Sem isso, o app funciona normalmente, mas a identificação por foto
usa o OCR local (Tesseract corrigido) em vez da leitura por visão — mais
limitado (só nome e número), mas funcional. Todos os outros serviços
(TCGdex, câmbio, tradução automática) são gratuitos e sem chave, já
funcionando sem nenhuma configuração adicional.
