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

## 8. Deploy e o pedido de "configurar o scanner de verdade"

Entre o fim da sessão anterior e esta mensagem, o usuário commitou e deu
push em todas as mudanças diretamente (commit `77bdee6 "teste"`, na branch
`main`, já sincronizado com `origin/main`) — confirmado com
`git log`/`git diff origin/main HEAD` (diff vazio). Conferi por amostragem
que os arquivos no commit já incluem as correções feitas durante os testes
(seção 5.2): `FINISH_PREFERENCE` em `pricing.js`, `getCardEnriched` em
`tcgdex.js`, a checagem de `ANTHROPIC_API_KEY` na function. Ou seja: o código
já publicado (ou publicando, dependendo de o site estar configurado para
deploy contínuo a partir do GitHub) é a versão corrigida, não a antiga
baseada em Tesseract quebrado.

O usuário então perguntou o que precisa "colocar" para o scanner
identificar a carta e já puxar os valores, dizendo que "tirando foto não
está funcionando". Isso bate exatamente com a limitação documentada na
seção 7: sem `ANTHROPIC_API_KEY` configurada no Netlify, a function
`identify-card` responde `503 NO_API_KEY` e o app cai automaticamente para o
OCR local — que lê só nome e número (quando lê), nunca set/raridade/variante,
e é justamente o comportamento "não funciona direito" que o usuário está
descrevendo. A resposta dada foi o passo a passo de onde conseguir a chave
(console.anthropic.com) e onde colocá-la (Netlify → Site configuration →
Environment variables → `ANTHROPIC_API_KEY` → novo deploy), com o aviso de
que cada leitura tem um custo pequeno (chamada ao Claude Opus 5 com imagem),
já que isso não estava explícito antes e o usuário deveria saber que passa a
existir um custo variável por escaneamento assim que a chave for
configurada.

## 9. "Escanear, não tirar foto" — detecção automática e contínua

O usuário perguntou se dava para identificar a carta sem configurar a chave
da Anthropic. Expliquei que a única forma 100% gratuita e sem chave é o
leitor local (Tesseract, já corrigido) ou a busca manual — não existe uma
terceira via mágica, porque uma carta física não tem chip nem código de
barras: qualquer identificação por software depende de capturar uma imagem
dela e analisá-la, seja qual for a ferramenta por trás.

Perguntei então o que ele imaginava por "escanear" em vez de "tirar foto", e
a resposta foi: detecção automática e contínua — apontar a câmera e o app
reconhecer sozinho, sem apertar botão, como um leitor de código de barras.

### O que foi implementado

- **`deploy/js/scanner.js`**: três funções de análise de frame, deliberadamente
  baratas (rodam sobre uma imagem 40×40 a cada ~220ms):
  - `grabTinyGray()` — reduz o frame atual da câmera a escala de cinza pequena.
  - `frameDiff()` — diferença média entre dois frames pequenos (mede se a
    câmera está parada).
  - `frameSharpness()` — energia de borda aproximada (mede se está em foco).
  - `AUTO_SCAN_THRESHOLDS` — limiares nomeados e comentados (estabilidade,
    nitidez, verificações seguidas necessárias, tempo mínimo entre tentativas
    reais, número de falhas seguidas antes de pausar).
- **`deploy/js/app.js`**: um `setInterval` (`autoScanTick`) que só dispara uma
  leitura de verdade (OCR local ou visão) quando a câmera está parada e
  nítida por `stableChecksNeeded` verificações seguidas, respeitando um
  cooldown mínimo entre tentativas e um teto de falhas consecutivas (depois
  disso, pausa e pede ação manual em vez de continuar gastando CPU/rede
  indefinidamente). Um botão "🔄 Auto" no cabeçalho do scanner liga/desliga
  esse modo; o botão "Capturar" continua funcionando a qualquer momento como
  disparo manual imediato.
- **`deploy/index.html`**: texto da tela mudou de "toque em Capturar" para
  "a detecção é automática", com uma linha de status ao vivo (`#auto-status`)
  informando o que está acontecendo ("Procurando carta...",
  "Mantendo o foco...", "Lendo...").

**Sobre os limiares de `AUTO_SCAN_THRESHOLDS`:** foram escolhidos por
raciocínio (o que costuma indicar uma imagem parada/nítida em termos de
diferença de pixel e energia de borda), não calibrados contra uma câmera
física — este ambiente de desenvolvimento não tem acesso a uma câmera real.
Documentado explicitamente no código como ponto a ajustar depois de uso real
em celular.

### Como foi testado sem uma câmera física

O Chromium do Playwright aceita `--use-fake-device-for-media-stream`, que
alimenta `getUserMedia` com um vídeo sintético (um padrão colorido em
movimento) em vez de pedir uma câmera real. Isso permitiu confirmar, com o
navegador de verdade:

- A câmera abre e o `<video>` recebe stream (1920×1080) sem cair no aviso de
  "câmera não disponível".
- O loop de verificação roda de fato: o texto de `#auto-status` muda sozinho
  ao longo do tempo (confirma que `autoScanTick` está sendo chamado e
  reagindo ao conteúdo do vídeo).
- O botão "🔄 Auto" alterna corretamente para "⏸ Manual" (parando o loop, e
  limpando o texto de status) e de volta para "🔄 Auto" (reiniciando o loop).
- Fechar o modal (`✕`) realmente encerra o `setInterval` (confirmado
  indiretamente: nenhum erro nem leitura fantasma depois de fechado).

O padrão sintético do Chromium nunca vai gerar uma leitura "bem-sucedida" de
verdade (não é uma carta), então esse teste não prova qualidade de
reconhecimento — só prova que o mecanismo (loop, limiares, transições de
estado, start/stop) funciona sem travar ou vazar timers. Qualidade real de
detecção só se valida em uso com celular e carta física.

### Bugs encontrados e corrigidos durante esse teste

1. **Botão "tentar de novo" desligava o modo automático em vez de retomá-lo.**
   Depois de `maxConsecutiveFails` tentativas sem sucesso, o loop se pausa
   sozinho (`autoScanPausedForManual = true`) mas a preferência do usuário
   (`autoScanEnabled`) continua `true`. O texto de aviso manda tocar em
   "🔄 Auto" para tentar de novo, mas o handler do botão só invertia
   `autoScanEnabled` — como já era `true`, o clique desligava o modo em vez
   de retomá-lo. **Fix:** o handler agora trata o caso de pausa
   separadamente, sempre retomando (nunca desligando) quando pausado.
2. **Falha do lado do servidor travava o usuário sem alternativa.** Rodando
   contra o `netlify dev` local (que não conseguia carregar a function por
   causa da versão do Node — ver seção 5), uma tentativa de captura manual
   revelou que `identifyCard()` só caía para o OCR local quando o erro tinha
   código `NO_API_KEY` ou `NETWORK` — qualquer outro erro do lado do servidor
   (ex.: resposta 5xx genérica, timeout do lado da Anthropic, recusa do
   modelo) era relançado e travava o fluxo, direto contrariando a regra de
   nunca deixar o usuário sem saída. **Fix:** `identifyCard()` agora cai para
   o OCR local em qualquer falha que não seja o cancelamento explícito do
   próprio usuário (`ABORTED`). Confirmado depois do fix: o overlay de
   carregamento passou a ficar visível de forma contínua durante toda a
   transição visão→OCR local, em vez de sumir e reaparecer.

Também foi criado nesta etapa um arquivo `claude.md` na raiz do projeto
(pelo usuário, fora desta sessão) com regras permanentes do projeto — leitura
obrigatória antes de qualquer alteração, proibição de recriar o projeto do
zero ou duplicar arquitetura, preservação de funcionalidades não relacionadas
à tarefa, e proibição de inventar dados/preços/APIs. Essas regras já
descrevem a forma como este trabalho vinha sendo conduzido (extensão do
código existente, preços reais com "Preço não encontrado" quando ausentes),
e passam a valer explicitamente para qualquer trabalho futuro neste
repositório.

## 10. Scanner com detecção de contorno em tempo real (OpenCV.js + pHash)

Pedido nesta sessão: evoluir o "escaneie sem clicar" (seção 9, baseado em
diff de pixel + nitidez sobre o frame inteiro) para um scanner de verdade —
contorno da carta detectado e desenhado ao vivo, perspectiva endireitada
automaticamente, identificação em duas etapas (OCR local rápido, com
fallback de pHash contra um banco de imagens conhecidas), tudo isso sem tirar
o usuário do fluxo já existente (confirmação, detalhe, adicionar à coleção).

### 10.1. Levantamento antes de mexer (regra 1 do `claude.md`)

Antes de escrever qualquer código, li `scanner.js`, `app.js`, `tcgdex.js` e
`index.html` por completo para entender o que já existia: a câmera
(`startCamera`/`stopCamera`/`captureFrame`), a identificação em duas camadas
já existente (visão do Claude via Netlify Function, com fallback para OCR
Tesseract local — seções 1-2 deste arquivo) e o loop de auto-scan da seção 9
(`grabTinyGray`/`frameDiff`/`frameSharpness` rodando a cada 220ms sobre o
frame inteiro, sem nenhuma noção de "onde está a carta"). Ou seja: a
identificação em duas etapas (visão → OCR) e o conceito de "loop de
verificação leve antes de disparar uma leitura cara" já existiam — o que
faltava era (a) saber *onde* a carta está no quadro (contorno real, não só
"a imagem está parada"), (b) endireitar a perspectiva antes de ler, e (c) um
terceiro nível de fallback por imagem (pHash) para quando nem OCR nem a
visão automática (que deixou de ser chamada no loop silencioso, ver 10.3)
resolvem.

### 10.2. Restrição de ambiente descoberta ao testar: sem acesso à TCGdex

O pedido original imaginava um "banco pré-computado de hashes... calculado
offline, uma vez, a partir das URLs de imagem que a API já fornece". Antes de
prometer isso, testei o acesso: `curl` para `api.tcgdex.net` e
`assets.tcgdex.net` deu **timeout de conexão** (`curl: (28)`) neste ambiente,
apesar de outros hosts (`google.com`, `registry.npmjs.org`,
`cdn.jsdelivr.net`, `docs.opencv.org`) responderem normalmente — não é uma
falta de internet genérica, é especificamente esses dois hosts da TCGdex que
não são alcançáveis daqui (`nslookup` resolve o IP normalmente, a conexão
TCP é que trava). Ou seja: **não dava para baixar as imagens de milhares de
cartas para gerar um banco de hashes real nesta sessão** — e fabricar um
arquivo de hashes fingindo que vieram de imagens reais violaria a regra 4 do
`claude.md` (não inventar dados/IDs/APIs).

Perguntei ao usuário como proceder (pergunta explícita, não decisão
unilateral, já que isso muda o escopo/entregável) e a resposta escolhida foi:
**script offline (para rodar com internet de verdade) + cache incremental no
navegador**, não um banco fabricado nem a ausência total do recurso. É o que
foi implementado — ver 10.5.

### 10.3. Arquitetura escolhida: substituir o gatilho, não duplicar o pipeline

Decisão central: a detecção de contorno (OpenCV) **substitui** o mecanismo de
gatilho antigo (diff de pixel no frame inteiro) em vez de rodar ao lado dele
— manter os dois seria exatamente a "segunda arquitetura paralela" proibida
pela regra 2. `frameDiff()` foi removido de `scanner.js`; `grabTinyGray()` e
`frameSharpness()` foram **mantidos e reaproveitados**, só que agora aplicados
ao recorte já endireitado da carta (para decidir se vale a pena tentar ler)
em vez de ao frame cru da câmera.

Dentro da identificação em si, a decisão foi manter os dois caminhos que já
existiam, mas separar por contexto de uso:

- **Botão manual "Capturar" / galeria:** continua chamando `identifyCard()`
  sem nenhuma mudança — visão do Claude primeiro, OCR local como fallback.
  Não mexi nisso porque é uma ação explícita e pontual do usuário, e a
  qualidade da visão vale o custo nesse caso.
- **Loop silencioso (auto-scan):** passou a usar OCR local (grátis) como
  fast path e pHash (grátis) como fallback, **sem nunca chamar a visão paga
  automaticamente**. Isso não estava no pedido original em termos explícitos
  de custo, mas é uma consequência direta de seguir a especificação (“fast
  path: OCR... fallback: pHash”) — e evita o problema real que o código
  antigo tinha: o loop de auto-scan da seção 9 chamava `identifyCard()`
  (visão primeiro) a cada tentativa automática, ou seja, cada ~2.2s de
  câmera parada gerava uma chamada paga à Anthropic sem o usuário saber.
  Documentando aqui porque é uma mudança de comportamento de custo, não só
  de mecanismo.

Quando o OCR local lê algo utilizável, o resultado entra no
`handleReading()` já existente (resolve candidatos via `resolveReading` na
TCGdex, mostra tela de confirmação) — nenhuma duplicação de fluxo. Quando é o
pHash que acha a carta, como o match já dá o **ID exato** da carta (não um
nome/número aproximado), criei `handleDirectMatch()` em vez de forçar esse
resultado pelo `resolveReading()` (que faz busca por nome/número — seria
redundante e mais lento para um caso em que já se sabe o ID). Ainda assim,
`handleDirectMatch()` mostra a tela de confirmação com a carta encontrada em
vez de pular direto para o detalhe — decisão deliberadamente conservadora,
porque pHash pode errar (falso positivo) e o banco de hashes hoje está vazio
por padrão (10.5), então essa via ainda não tem validação de qualidade em
produção.

### 10.4. OpenCV.js: contorno, ordenação de pontos, warp

`scanner.js` ganhou:

- `loadOpenCv()` — carregamento sob demanda (só quando o scanner abre), do
  build oficial `https://docs.opencv.org/4.9.0/opencv.js` (~10MB de
  asm.js/WASM, testado ao vivo: `curl -I` respondeu `200`, `Content-Length:
  10257309`). Mesmo padrão de carregamento dinâmico que o Tesseract.js já
  usava — não pesa no carregamento inicial do app.
- `detectCardQuad(cv, canvas)` — cinza → blur gaussiano → Canny →
  dilatação → `findContours` → para cada contorno, `approxPolyDP` e fica
  com o maior quadrilátero convexo que passe de 5% da área do frame. Devolve
  os 4 pontos (já ordenados) e a fração de área ocupada.
- `orderQuadPoints()` — ordena 4 pontos quaisquer como
  topo-esquerda/topo-direita/baixo-direita/baixo-esquerda (por soma e
  diferença de coordenadas — algoritmo padrão para essa tarefa), necessário
  porque `approxPolyDP` não garante nenhuma ordem específica.
- `warpCardPerspective(cv, canvas, quad, outW, outH)` — usa
  `getPerspectiveTransform` e `warpPerspective` para endireitar o
  quadrilátero detectado num retângulo 300×420 (proporção 2.5:3.5, igual à
  de uma carta física).
- `quadsAreStable()` — compara dois quads consecutivos (deslocamento do
  centro + variação de área, ambos como fração da maior dimensão do frame)
  para decidir se a carta está "parada" — substitui o `frameDiff()` antigo
  com um sinal muito mais direto (é literalmente "o contorno da carta não se
  moveu", não "os pixels do frame inteiro não mudaram muito").

Cuidado de implementação: todo `cv.Mat`/`MatVector` criado dentro dessas
funções é explicitamente `.delete()`ado (`try/finally`) — o WASM do
OpenCV.js não tem coletor de lixo automático para esses objetos, e como o
loop roda a cada 400ms indefinidamente enquanto o scanner está aberto, um
vazamento aqui cresceria o heap do WASM continuamente até travar o
navegador. Validado indiretamente no teste da seção 10.7 (o loop rodou ~15s
seguidos sem erro nem sinais de degradação).

Mapeamento de coordenadas: a detecção roda sobre um frame reduzido
(`detectMaxDim: 320`, o maior lado; requisito pedia 320×240, usei o maior
lado para não distorcer a proporção real do vídeo). Para o warp final, os
pontos do quad são reescalados de volta para a resolução plena do frame
capturado (`scaleQuadPoints`) antes de endireitar — a detecção é barata e
roda em baixa resolução, mas o recorte que alimenta OCR/pHash usa a imagem
em resolução mais alta disponível, para não perder nitidez de texto.

### 10.5. Banco de pHash: `phash.js` (puro) + worker + IndexedDB + script offline

`deploy/js/phash.js` implementa o algoritmo pHash clássico (o mesmo da
biblioteca de referência `imagehash.phash` em Python: imagem 32×32 em cinza
→ DCT 2D → os 8×8 coeficientes de frequência mais baixa → 1 bit por
coeficiente comparado à mediana do bloco → hash de 64 bits). Escrito sem
nenhuma dependência de DOM nem de Node — só matemática pura — exatamente
para poder ser importado tanto pelo navegador (`phash-worker.js`, rodando
num Web Worker) quanto pelo script offline em Node
(`tools/build-phash-db.mjs`). Isso garante que um hash calculado offline por
um script Node é diretamente comparável (mesma distância de Hamming
significa a mesma coisa) a um hash calculado ao vivo no celular — sem essa
garantia, o banco pré-computado seria inútil.

**Validação real do algoritmo** (não só "o código não deu erro" — conferi
que a matemática funciona): como não há acesso a imagens reais da TCGdex
nesta sessão (10.2), gerei duas imagens sintéticas em SVG simulando uma
"carta" (retângulo + círculo + texto), uma delas com leve deslocamento e
ruído/blur simulando uma segunda foto da mesma carta, e uma terceira
claramente diferente (símbolo bem deslocado). Rodando o pipeline completo
(`sharp` redimensiona para 32×32 em cinza → `computePHash` → `findClosest`):
a variação "ruidosa" da mesma carta ficou a **distância de Hamming 6** do
original, contra **distância 30** para a carta diferente, e `findClosest`
identificou corretamente o candidato certo como melhor match. Isso confirma
que o algoritmo distingue "mesma carta, foto diferente" de "carta diferente"
antes de depender dele com dados reais.

Três peças novas:

- **`phash-worker.js`** (Web Worker, `type: 'module'`): recebe mensagens
  `match` (calcula o hash de uma grade 32×32 recebida da thread principal e
  compara contra o banco pré-computado + o cache do IndexedDB, devolve os
  candidatos mais próximos) e `learn` (calcula e grava um hash no
  IndexedDB). Todo o cálculo pesado (DCT + comparação) fica fora da thread
  de UI — é o requisito 5 do pedido.
- **`phash-db.js`**: wrapper na thread principal — cria o worker uma vez,
  correlaciona `postMessage`/resposta por `requestId`, expõe
  `matchCardImage()`/`learnCard()` como Promises simples para o `app.js` usar.
- **`tools/build-phash-db.mjs`**: script Node standalone que busca as
  coleções da TCGdex, baixa a imagem oficial ("low.png") de cada carta,
  usa `sharp` para decodificar/redimensionar/converter para cinza 32×32, e
  calcula o hash com o mesmo `computePHash` do navegador. Incremental (não
  recalcula cartas que já estão no arquivo de saída) e com concorrência
  limitada. **Nunca rodado contra a API de verdade nesta sessão** — sem
  acesso a `api.tcgdex.net` (10.2) — e isso é dito explicitamente no próprio
  cabeçalho do script, não só aqui. Uma incerteza documentada no código: não
  pude confirmar ao vivo se `GET /v2/{lang}/sets/{id}` embute o campo
  `image` em cada carta do resumo ou só nos detalhes completos — por
  segurança, o script busca a carta completa (`/cards/{id}`) sempre que
  `image` não vem no resumo, em vez de assumir uma coisa e falhar em
  silêncio se a suposição estiver errada.

`deploy/data/card-hashes.json` começa como `[]` neste repositório — não
inventei entradas de exemplo nem fabriquei hashes de cartas que eu não
processei de verdade.

**Aprendizado incremental client-side** (a parte que reduz a dependência do
script): toda vez que `loadCardDetail()` carrega uma carta, `app.js` chama
`learnCardHashInBackground(card)`, que baixa a **imagem oficial** da carta
(`cardImage(card, 'low')`, servida pela TCGdex com CORS aberto — por isso
`loadImageUrl()` usa `img.crossOrigin = 'anonymous'`, necessário para depois
poder ler os pixels via `getImageData` sem o navegador bloquear o canvas por
"tainted canvas") e ensina o hash dela ao worker, que grava no IndexedDB.
Deliberadamente hasheia sempre a imagem oficial, nunca a foto tirada pela
câmera — misturar hash de foto de câmera (com iluminação/ruído/ângulo
específicos de uma única captura) com hash de imagem de referência
degradaria a qualidade do banco em vez de crescer ele de forma útil. Isso
roda em segundo plano (fire-and-forget, erros engolidos silenciosamente) e
nunca bloqueia nem pode quebrar a tela de detalhe.

### 10.6. Integração com a UI: overlay de contorno, câmera, botão manual

`index.html` ganhou um `<canvas id="contour-canvas">` posicionado sobre o
vídeo (`position: absolute; inset: 0`), desenhado a cada tick do loop de
auto-scan. A guia fixa antiga (`#scan-box`, a moldura pontilhada) foi mantida
como referência visual sutil (opacidade da vinheta reduzida de `.52` para
`.28`, borda mudada para tracejada) — preservação deliberada de UI que já
funcionava (regra 3), só ajustada porque agora a carta pode ser detectada em
qualquer posição do quadro, não só dentro daquela moldura fixa.

O mapeamento de coordenadas do contorno (detectado num canvas reduzido, em
resolução "crua" do vídeo) para a posição desenhada na tela precisa levar em
conta que o `<video>` usa `object-fit: cover` (corta e escala, não é uma
correspondência 1:1 entre pixel do vídeo e pixel da tela) — implementei
`videoDisplayRect()` em `app.js` com a matemática padrão desse mapeamento
(comparando proporção do vídeo com proporção da caixa exibida) para os
pontos do contorno caírem no lugar certo em qualquer tamanho de tela/vídeo.

O botão "Capturar" manual ganhou um pequeno aproveitamento do pipeline novo:
se um recorte já endireitado (`lastWarpedCanvas`) foi gerado há menos de
1.5s, ele é usado no lugar do frame cru — melhora o enquadramento enviado
para `identifyCard()` sem mudar o comportamento quando não há warp recente
disponível (fallback automático para `captureFrame()`, igual a antes).

### 10.7. Testes realizados nesta etapa

**Sintaxe:** todos os módulos novos/alterados (`phash.js`, `phash-worker.js`,
`phash-db.js`, `scanner.js`, `app.js`, `tools/build-phash-db.mjs`) passaram
por `node --check` sem erro.

**Matemática do pHash validada de ponta a ponta** com `sharp` + imagens
sintéticas — ver 10.5 (distância 6 vs. 30, candidato certo identificado
como melhor match).

**Dependências:** `npm install` com `sharp` como nova devDependency. A
primeira tentativa (`sharp@^0.33.5`) instalou limpo mas `npm audit` acusou 1
vulnerabilidade alta (CVEs em `libvips`/`libheif` vendorizados pelo próprio
pacote) — troquei para `sharp@^0.35.4` (a versão que o próprio `npm audit`
indicou como corrigida) e o audit ficou limpo (`found 0 vulnerabilities`).
Efeito colateral: `sharp@0.35.x` usa import attributes de JSON
(`import pkg from "./package.json" with { type: "json" }`), que exigem
Node ≥ 20.10 — o Node instalado neste ambiente é 20.9.0 e falhou nesse ponto
exato ao tentar `import`. Para não deixar a validação da matemática do pHash
sem teste por causa disso, reinstalei temporariamente `sharp@0.33.5` só
para rodar o teste local, confirmei o resultado, e restaurei
`sharp@^0.35.4` (a versão de verdade, sem a vulnerabilidade) no
`package.json`/lockfile antes de terminar — documentado também no cabeçalho
de `tools/build-phash-db.mjs` e como `engines.node` em `package.json`, para
quem for rodar o script de verdade saber que precisa de Node mais novo.

**Navegador real, com câmera falsa** (mesma técnica da seção 9 — Chromium
via Playwright com `--use-fake-device-for-media-stream`, já que este
ambiente não tem câmera física): subi `netlify dev` servindo `deploy/` de
verdade e, com um script Playwright, verifiquei ao vivo:

- A câmera abre e o `<video>` recebe stream (1920×1080).
- **OpenCV.js carrega de verdade** (`window.cv.Mat` fica disponível) —
  confirma que o `<script>` dinâmico e o `onRuntimeInitialized` funcionam
  num navegador real, não só no papel.
- O loop de auto-scan roda repetidamente por ~15s sem nenhum erro de
  console/página — nem os de `cv.Mat` não liberado, nem de outro tipo. O
  padrão sintético do Chromium não gerou nenhum quadrilátero aceito pelo
  detector (status ficou em "🔍 Procurando carta..." o tempo todo) — é o
  comportamento correto quando não há uma carta de verdade no quadro, e
  mostra que o gatilho não dispara em falso sobre ruído.
- O `<canvas id="contour-canvas">` é redimensionado corretamente
  (`1280×497` em device pixels, batendo com o viewport de teste × DPR).
- **O Web Worker de pHash responde corretamente**: enviei uma mensagem
  `match` com uma grade cinza-sólida sintética (32×32) através de
  `phash-db.js` de dentro da própria página e recebi de volta um array de
  matches (vazio, porque o banco está vazio — 10.5) sem nenhum erro. Isso
  confirma, num navegador real: o `Worker` com `type: 'module'` carrega,
  `import` dentro do worker funciona, o `fetch` de `card-hashes.json`
  funciona, e o acesso a IndexedDB dentro do worker funciona.
- Zero erros de `console.error`/`pageerror` durante toda a sessão de teste.

**O que isso prova e o que não prova** (mesma ressalva da seção 9, repetida
porque continua verdadeira): prova que o mecanismo — carregamento,
agendamento do loop, gestão de memória do OpenCV, overlay, worker — funciona
sem travar ou vazar recursos. **Não prova qualidade de detecção real**
(contorno de carta física, iluminação real, ângulos variados) nem qualidade
de matching de pHash com dados reais, porque nem uma câmera física nem o
banco de hashes populado estavam disponíveis nesta sessão. Só uso real em
celular, com uma carta física e (idealmente) o banco de hashes gerado,
valida isso.

### 10.8. O que fica pendente, honestamente

- Rodar `npm run build:phash-db` numa máquina com acesso à internet livre e
  Node ≥ 20.10, e confirmar que a suposição sobre o formato da resposta de
  `/sets/{id}` (10.5) está certa.
- Calibrar `AUTO_SCAN_THRESHOLDS` (`minQuadAreaFraction`,
  `stableFramesNeeded`, `centroidEpsFraction`, `areaRatioEpsFraction`,
  `sharpnessMin`, `phashMaxDistance`) contra uso real em celular — os
  valores atuais são os mesmos "escolhidos por raciocínio, não medidos"
  que já valiam para os limiares antigos.
- Validar a taxa de acerto do pHash como fallback de verdade, depois que o
  banco tiver cobertura real (script ou uso orgânico via
  `learnCardHashInBackground`).
