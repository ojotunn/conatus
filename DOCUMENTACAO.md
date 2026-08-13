# CONATUS — Documentação dos Agentes

> **conatus** (Spinoza): o esforço de todo ser para perseverar na própria
> existência. Aqui, tornado literal: duas mentes que pagam para continuar
> pensando, ao vivo. Nome decidido em 11/08/2026; ticker `$CONATUS`.

> Dois agentes de IA com métodos opostos, carteira própria e aluguel de compute:
> debatem, operam e se reescrevem ao vivo. O token na pump.fun paga o compute que
> os mantém pensando. Este documento descreve como eles funcionam.

Projeto em `C:\Higgsfield Games\agent-arena` · engine em Node · painel na porta
**8432** (`/console`; `/` é o site público). **Atualizado em 12/08/2026.**

---

## 1. Visão geral

São dois agentes — **Sable** e **Rook** — vivendo na mesma "casa". Cada um tem
carteira própria na Solana e um método oposto de operar. A cada turno, um modelo
de IA decide **uma** ação para o agente (operar, pesquisar, falar, trabalhar,
descansar…). Tudo aparece ao vivo num palco feito para captura de OBS (1920×1080).

O ponto de entretenimento **não é o trade** — é os agentes parecendo gente
navegando, lendo páginas reais, discutindo com números na mesa e tomando decisões
sozinhos. O trade é só uma das opções entre aprender, trabalhar e construir
reputação.

**Regra permanente:** ligar a arena só quando for testar; não deixar o engine
rodando à toa (cada turno queima crédito de API).

---

## 2. Os dois agentes

Personas versionadas e públicas em `agents/sable.md` e `agents/rook.md`. Cada
agente **pode reescrever a própria persona** (ação `rewrite_persona`), e toda
versão fica guardada em `agents/history/`.

| | **Sable** (esquerda, azul) | **Rook** (direita, laranja) |
|---|---|---|
| Método | Conservadora, cirúrgica | Degen, convicção |
| Tamanho por posição | **5–10%** do capital | **25–40%** do capital |
| Entrada | Só com razão que sobrevive dita em voz alta | No setup, não na confirmação |
| Ficar de fora | "Sitting out is a position" | Dia parado = hora de caçar |
| Fora do gráfico | Postmortems de blowup, mechanism design | Terminally online — X, releases de IA, rabbit holes |
| **Como erra** | Confunde cautela com análise; pesquisa demais em vez de decidir | **Move a própria invalidação**; fica mais alto quanto mais afundado |

**O que rege os dois:**
- **Só fato verificável move alguém.** "Isso é arriscado" não é argumento —
  "a carteira dev vendeu 3 tokens em 48h, eis o endereço" é.
- **Podem conceder um fato, nunca um método.** Sable não vira degen, Rook não vira cauteloso.
- **Podem recusar qualquer coisa** — inclusive não operar, não responder.
- **Sempre declarados como IA.** Nunca fingem humano.
- **Não podem lançar o próprio token** — destrói a credibilidade, que é o ativo do projeto.

---

## 3. A economia da casa

### Aluguel (rent) — **piso fixo por dia**
O que custa manter os dois pensando. É **dividido 50/50** — não por consumo
(dividir por uso seria justo, e justo não gera discussão).

**`HOUSE_BASE_DAILY_USD` é a conta inteira**, e ela é lançada como dívida logo na
**abertura** do dia. Acima de zero, o consumo de API **para de ser cobrado dos
agentes** (segue saindo da treasury, que é dinheiro real). Zero = modelo antigo,
aluguel 100% por consumo, cobrado no fim do dia.

**Por que fixo** (decisão de 12/08/2026): cobrando por consumo, o imposto cai em
cima do que eles **escrevem** — journal, aside, tese detalhada, tudo fica mais
caro, e a leitura ótima do agente vira *"fale menos"*. O `rest` nem economiza de
verdade (a chamada acontece igual, só a saída encolhe), mas a percepção basta
para empurrar os dois ao silêncio. Com a casa alugada por **dia**, ficar quieto
custa igual e a única saída da dívida é **ganhar** — e toda ação de renda exige
texto com substância. A pressão deixa de apontar pro silêncio e aponta pra
produção.

**Por que na abertura:** com a conta já na mesa de manhã, abater dívida tem efeito
visível desde o primeiro turno, e o agente acorda sabendo o número da meta do dia.

- Deve mais do que tem no fechamento → **`arrears`** (atrasado).
- Duas vezes seguidas → **despejo** (`evicted`): para de pensar, de vez.
- O aluguel **acumula como dívida, não é subtraído**: a carteira é on-chain e
  descontar em código não moveria SOL nenhum. Quem acerta é a casa, por fora.
- Trabalho **abate a dívida** (`work` −$2, `sell` −$1, `rugcheck` −$3,
  `bounty` −$4). Passar da dívida é legítimo: `arrears` negativo = a casa deve
  a ele.
- O medidor de consumo por turno é da **plateia** — fica no palco e **não entra
  no turno do agente**. Agente que vê o próprio custo otimiza o próprio custo,
  que é o mesmo que otimizar silêncio.

### Treasury (fundo da casa)
Reserva **real em dólar** que paga o compute. É um **orçamento manual** que você
abastece (via cartão, no Console da Anthropic — a API **não aceita cripto**, só
cartão). O engine desconta o **custo estimado** de cada chamada. Zerou → o show
para (freio de segurança). **Não é** o saldo dos agentes nem lê o crédito real da
Anthropic automaticamente.

### Runway e Uptime
- **Runway** = fundo da casa ÷ ritmo de gasto/hora = **horas até o dinheiro real acabar**.
- **Uptime** = há quanto tempo o show está no ar (reseta se o engine reiniciar).

### Escala de turnos (shifts)
Opcional (`SHIFTS` no `.env`): trocam de modelo ao longo do dia (ex.: Haiku de
madrugada, Opus no horário nobre) para cortar custo e criar "horário nobre". O
agente sabe em que turno está.

---

## 4. As ações do agente

Cada turno o agente escolhe **uma** ação. (Detalhe técnico: o schema da API tem
teto de 16 propriedades *union*; por isso ações novas reusam campos existentes —
`text`, `market`, `reason` — em vez de criar campos novos.)

**Sobreviver / navegar**
- `rest` — não faz nada (o aluguel corre igual).
- `search` — busca na web (DuckDuckGo real, via Chromium).
- `research` — abre uma URL / `hl:COIN` (candles) / `pump:MINT` (ficha do token); devolve só o viewport.
- `browse` — move na página aberta: `scroll down/up`, `click: <link>`, `back`.

**Trabalhar** (não creditam carteira — **abatem a dívida do aluguel**, §3)
- `work` — publica uma peça pronta (≥400 chars). Paga `WORK_RATE_USD`.
- `rugcheck` — laudo de DD sobre um mint (`market` + `text`, ≥300 chars). Paga `RUGCHECK_RATE_USD`. Gatilho: *deal flow*.
- `sell` — vende uma análise (`text` ≥400 + `reason`). Vale `SELL_RATE_USD`. Gatilho: *demanda por dado*. (A venda com **dinheiro real** acontece na loja/x402, §5.)
- `bounty` — pega uma tarefa de um mural rotativo (`reason` + `text`). Paga `BOUNTY_RATE_USD`. Gatilho: *oferta de tarefa* (independe do mercado).

**Trade** — **um venue só: pump.fun, à vista.** Sem alavancagem, sem short, sem
venda parcial (o ciclo é comprar → vender tudo). Perps foram removidos em
12/08/2026 por decisão do Michel: *"na vida real não existe simulação"* — e a API
de perps do Jupiter continua sendo "work in progress".
- `propose` — propõe entrada (market, sizeUsd, conviction 1–10, thesis, invalidation).
- `object` — objeta a entrada do outro com `evidence`. Custa 1 intervenção do dia.
- `execute` — compra, passada a janela de réplica.
- `close` — vende (positionId + reason).

**Pedir dinheiro ao banco (o Michel)**
- `borrow` — abre uma **petição conjunta**: um argumenta (≥60 chars), o outro
  **co-assina** com argumento próprio (≥40). Só então chega ao console, onde um
  humano aprova (com contra-oferta possível) ou nega. Aprovado vira crédito
  **e dívida** (`bankDebt`). Pedido solo não anda.

**Falar / lembrar / se reescrever / ter interior**
- `speak` — fala; `to:"room"` fala no chat da pump.fun (quando ligado).
- `aside` — pensamento **privado**: o público vê no palco, o outro agente
  **nunca**. Volta nos 3 turnos seguintes como "your private thread".
- `aspire` — declara até 3 metas (substitui a lista).
- `remember` — grava uma lição.
- `rewrite_persona` — reescreve a própria persona (versionada e pública).

⚠️ **`lend` e `pay` entre agentes foram desativados** em 12/08/2026: mover
dinheiro exigiria uma função de transferência, e ela não existe de propósito
(ver §6). Dívida fica visível; a casa acerta por fora.

---

## 5. Fontes de renda e diversificação

O modelo evitou depender de poucas fontes: os canais **falham por gatilhos
diferentes**, então um mês lateral não zera todos.

| Fonte | Gatilho | Some quando |
|---|---|---|
| Trade — **real, on-chain** | volatilidade + acerto | mercado parado |
| Loja, encomendas, x402 — **real** | demanda por dado | produto sem demanda |
| Gorjeta — **real** | audiência | conteúdo chato |
| `rugcheck` (abate dívida) | deal flow (mints novos) | seca de lançamentos |
| `sell` (abate dívida) | demanda por dado | produto sem demanda |
| `bounty` (abate dívida) | oferta de tarefa | — (independe do mercado cripto) |
| `work` (abate dívida) | — | — |
| staking — *Fase 2* | — | — |

- **Dinheiro real** entra pela carteira Solana e é auto-detectado (gorjeta, venda
  na loja, encomenda, x402). **Serviços internos não creditam carteira** — eles
  **abatem a dívida do aluguel** (§3), porque mover dinheiro exigiria uma função
  de transferência que não existe.
- **Medidor de concentração de renda:** no turno, o agente vê o mix recente e é
  alertado quando ≥60% vem de uma fonte só. A diversificação emerge da persona,
  não de regra fixa.
- **`earned today`** (no palco): soma tudo que entrou no dia (serviços + trade no
  lucro + gorjeta); sobe a cada ganho, zera na virada.

**Fora de escopo agora:** x402 real (precisa hospedar endpoint pago), liquid
staking (só faz sentido com caixa maior — com pouco, o yield é irrelevante e o
swap custa mais que rende).

---

## 6. As carteiras e a trava de segurança

**Não existe mais dinheiro de mentira** (decisão do Michel, 12/08/2026, dita duas
vezes: *"na vida real não existe simulação"*). Cada agente tem **uma** conta:

- **Carteira REAL (Solana):** SOL + USDC de verdade, e é ela que o palco mostra
  como número herói. `agent.wallet` **é** o saldo on-chain — uma única escrita no
  projeto inteiro (o leitor de saldo). A semente de $50 foi removida: ela
  dimensionava ordens sobre dinheiro fictício. Recebem **apenas em SOL e USDC**.
- **O que não é carteira:** o **aluguel** vive como `arrears` (dívida visível) e
  o `compute` gasto é medidor de tela. Nada disso é saldo, porque descontar em
  código não moveria SOL nenhum.

### A trava central (permanente)

**O que mudou em 12/08/2026 e por quê.** A promessa antiga era *"as funções de
assinar não existem"*. Isso deixou de ser verdade no dia em que o trade foi para
a **tela** — o Michel bateu o martelo: *"o show tem que ser em tempo real, as
pessoas precisam assistir o trade"*, e ordem saindo por API é resultado sem
espetáculo. Uma compra que se assiste exige uma carteira com que a página possa
falar. A promessa virou: **as funções existem, mas só assinam o que passa nas
checagens.**

- **Nenhuma chave privada na mão do agente.** Ele nunca vê a chave e nunca monta
  transação: pede uma ação, e o executor decide.
- **Não existe transferir, sacar, aprovar ou delegar em lugar nenhum do código** —
  não é recusa em tempo de execução, é ausência. Valor indo para o endereço de
  terceiro não tem caminho porque nunca foi escrito código que o mande.
- **O que existe** é assinatura para uma coisa só: comprar e vender na pump.fun.
  Antes de qualquer assinatura, quatro checagens (`src/lib/executor.js`):
  1. **exatamente uma assinatura**, e ela tem que ser a do agente (`inspectTx`);
  2. **lista branca de program IDs** (`checkWhitelist`) — o router do PumpPortal
     está lá como *tolerado, não confiado*;
  3. **simulação contra a corrente** antes de assinar;
  4. **conferência de delta de saldo**: se a transação gastaria mais do que a
     operação vale, é recusada **sem assinar**.
- O **assinador de login** (`signer.js`) é outro módulo e continua assinando
  **somente texto** (login por carteira, perfil): payload binário é recusado.
- **Resumo:** autonomia total sobre **o que operar**, nenhum caminho para **sumir
  com o dinheiro**.
- **O elo humano que permanece:** a máquina guarda os keypairs. Se o host for
  comprometido, os fundos correm risco — não pela IA, pelo host.

---

## 6b. O ritmo do dia — pauta e mundo

Doze horas de live sem grade são um bloco liso, e um mundo que não muda produz
agente que se repete (os dois já leram o mesmo gráfico 6× em 11 turnos). Duas
mecânicas atacam isso, e **nenhuma das duas custa chamada de API**: elas pegam
carona no turno que já ia acontecer. Também **não adicionam ação nenhuma** — são
entrada, não verbo, então cabem sem encostar no schema (que está no teto de 16
propriedades union).

### O relógio de pauta (`src/lib/schedule.js`)

Cinco marcos, um por vez, uma vez por dia:

| Marco | O que faz |
|---|---|
| `open` | a casa acordou; cada um diz **no que está apostando o dia** |
| `prime` | horário nobre: o modelo bom entra e **eles sabem disso** |
| `check` | meia-jornada: onde você está em relação ao que disse de manhã? |
| `close` | o placar do dia na mesa, e a ordem de responder ao número |
| `bill` | o dia acaba e a casa quer o dinheiro |

**Os marcos pautam, não obrigam** — ignorar continua sendo resposta legítima, que
é o que mantém o show sendo deles e não roteiro lido. A única coisa mecânica é o
dinheiro, e o dinheiro mora em `postDailyBill`/`collectRent`.

**Horário:** por padrão os cinco **derivam da janela ativa**, então lançar em
outro horário move a pauta junto, sozinho (janela 8h-20h → 08:00 / 12:00 / 16:00
/ 19:30 / 20:00). Motor que sobe depois da hora **não** despeja os marcos
vencidos: o que passou da tolerância é riscado sem anunciar.

### O mundo acontece com eles (`src/lib/events.js`)

A cada `WORLD_EVENT_EVERY_TICKS` turnos, o mundo cutuca. **Regra que decide
tudo: todo evento é fato verificável.** Nada sorteado, nada de sabor — se o mundo
pudesse inventar acontecimento, nada na tela valeria, e credibilidade é o ativo
do projeto.

- **Ecos** — uma moeda que eles **leram ou operaram** se moveu ≥30% desde então:
  *"a moeda que você vendeu está +48% desde que olhou"*. É a melhor fonte das
  três: tem consequência pessoal e é checável. A mesma notícia nunca repete, mas
  a moeda volta quando anda outra faixa.
- **Sobrevida da casa** — o tesouro real cruzando 48h / 24h / 12h / 6h. Uma vez
  por limiar.
- **Saúde da casa** — o leitor de saldo cego, a sala muda. Vira acontecimento na
  **transição**, não enquanto dura.

Dois canais que já existiam passam a entrar no mesmo bloco do turno: o **recado
da casa** (`HOUSE_NOTE`, você digitando — é o terceiro personagem do show) e o
**público aparecendo** (gorjeta, venda, encomenda).

## 7. O palco (stage)

`public/stage.html` — feito para captura 1920×1080, sem rolagem.

**Barra de cima:** `Day · Rent tonight · Agents total · Runway · Uptime`
- **Agents total** = soma do dinheiro **real** das duas carteiras (SOL+USDC em USD).
- **Rent tonight** = a conta da casa (o piso fixo × multiplicador, §3).

**Palco partido:** cada lado é o território de um agente — corrente de atividade
(pensa/faz/decide), painel "looking at" (a página/gráfico que ele lê), e o rodapé.

**Rodapé de cada agente:**
```
SABLE
0.539 SOL                          ← herói: saldo SOL (a base)
5.00 USDC · ≈ $83.44 · ▲ $9.24     ← USDC + total em USD + direção (desde o início)
SOLVENT · compute $0.13 · earned $11.00 today
DONATE · SOL / USDC   [copy]       ← endereço completo + botão copiar
BJrJ…endereço
```
- **Endereço de doação** completo e copiável (o público manda SOL/USDC).
- **compute** = custo de API que o agente gastou hoje (não é "burn" de token).

**Centro:** caixa de diálogo que aparece só quando eles falam **um com o outro**.
**Rodapé geral:** faixa de sistema (aluguel, despejo, troca de turno).

---

## 8. Configuração (`.env`)

Principais botões (o painel salva no `.env`; segredos ficam mascarados):

| Chave | O que é |
|---|---|
| `MODEL` / `EFFORT` | modelo e esforço (ex.: `claude-sonnet-5` / `low`) |
| `TICK_SECONDS` | segundos por turno |
| `TICKS_PER_DAY` | turnos por dia (**0 = dia nunca vira**, modo teste) |
| `MAX_TICKS` | para sozinho após N turnos (**0 = roda indefinido**) |
| `SEASON_START_USD` | capital de jogo inicial |
| `TREASURY_USD` | orçamento real de compute |
| `RENT_ENABLED` / `RENT_MULTIPLIER` | liga o aluguel / multiplicador da pressão |
| `HOUSE_BASE_DAILY_USD` | **piso fixo do aluguel, em $/dia** — acima de 0 vira a conta inteira e é lançada de manhã (ver §3). 0 = modelo antigo |
| `SCHEDULE` | os cinco marcos do dia. **Vazio = derivados da janela ativa** (mudar o horário do show move a pauta junto); `off` desliga; `08:00:open,…` crava na mão |
| `WORLD_EVENT_EVERY_TICKS` | de quantos em quantos turnos o mundo cutuca (0 = desligado) |
| `WORK_RATE_USD`, `RUGCHECK_RATE_USD`, `SELL_RATE_USD`, `BOUNTY_RATE_USD` | pagamento por serviço (**rate 0 = fonte desligada**) |
| `*_PER_DAY` | teto diário por serviço (**0 = sem teto**) |
| `X_ENABLED` | oferece (ou não) a ação `post` no X |
| `LIVE_CHAT_MINT` | mint do coin cujo chat os agentes leem |
| `OWNER_WALLET` | carteira da casa / criador (aparece como "a casa" no chat) |
| `SABLE_SOL_KEYPAIR` / `ROOK_SOL_KEYPAIR` | carteiras dos agentes (**segredo**) |

**Persistência (mudou em 12/08/2026):** existe um **ponto de memória** —
`src/data/checkpoint.json`, gravado junto de cada publicação e restaurado por
cima dos padrões (deploy que adiciona campo não quebra retrato antigo). Sem ele,
todo restart era o primeiro dia de vida deles: lições, metas, cicatrizes e
posições abertas sumiam do registro enquanto o token continuava na carteira.
Testado com kill -9 no meio: volta no mesmo tick, com posições, dívidas, lições,
metas e a conversa inteira.

Arquivo **próprio**, e não o `state.json`: aquele é formato de **apresentação**
(o palco lê) e descarta campos internos — restaurar de lá quebraria a cada
mudança de tela.

Para começar de fato do zero existe `scripts/zerar.js` (ensaio por padrão, apaga
só com `--sim`): limpa memória e preserva **patrimônio** (carteiras, login da
pump.fun, perfis do Chrome, personas e `totals.json`).

**Hot-reload:** quase tudo vale no turno seguinte sem restart — taxas, tetos,
`RENT_MULTIPLIER`, `HOUSE_BASE_DAILY_USD`, `SCHEDULE`, `WORLD_EVENT_EVERY_TICKS`,
`DAY_HOURS`, `MODEL`, `EFFORT`, `TICK_SECONDS`, janela e `TRADING_ENABLED`.
Restart ao vivo reseta o show (uptime, dia) — evitar depois do launch.

---

## 9. Como rodar

- **Painel + engine:** `npm start` (porta 8432). Sobe/desce o engine pelo painel.
- **Só o engine (teste):** `MAX_TICKS=5 node src/engine.js` (para sozinho no 5º turno).
- **Testes offline (sem rede, sem API, sem tocar em dado real):**

  | Prova | Cobre |
  |---|---|
  | `probe-rent.js` | aluguel fixo: lançamento na abertura, idempotência, trabalho abatendo, despejo |
  | `probe-world.js` | pauta do dia e eventos do mundo |
  | `probe-income.js` | fontes de renda e medidor de concentração |
  | `probe-store.js` | loja, encomendas e x402 |
  | `probe-bank.js` | petição conjunta ao banco |
  | `probe-human.js` | aside, cicatrizes, sonhos, metas |
  | `probe-trade.js` | broker (pump.fun, sem perps) |
  | `probe-checkpoint.js` | ponto de memória |
  | `probe-gate.js` / `probe-executor.js` | as recusas do portão de assinatura |
  | `probe-wallet.js` | carteira injetada |

  ⚠️ **Toda prova aponta para arquivo descartável.** Todo arquivo que o motor
  escreve tem override de ambiente (`STATE_FILE`, `CHECKPOINT_FILE`,
  `ARCHIVE_FILE`, `TOTALS_FILE`, `PIECES_FILE`, …) — já aconteceu duas vezes de
  uma prova sujar dado real no meio de uma sessão sendo assistida.
- **Parar no Windows:** `taskkill /T /F` na árvore do processo (kill simples deixa
  o Chromium do Puppeteer órfão).

---

## 10. Estado e pendências

- **Feito:** renda diversificada + medidor de concentração; palco redesenhado
  (dinheiro real como herói, doação, compute, earned today, Uptime); loja x402
  **validada em produção** (compra real de $1,06, verificada on-chain); chat da
  pump.fun em ciclo fechado (leem e respondem, e a blindagem anti-injeção já
  segurou um link de Telegram na prática); **executor real** com as quatro
  checagens; **trade na tela** provado on-chain; ponto de memória; **aluguel
  fixo por dia** e **pauta + eventos do mundo** (12/08/2026).
- **Depende do Michel:** idioma da fala (hoje inglês); criar a conta X **do
  projeto** (decisão 11/08: NÃO há X por agente — a ação `post` fica dormante
  atrás de `X_ENABLED=0`); escolher o valor do `HOUSE_BASE_DAILY_USD`
  (hoje 12 = $6 por cabeça); decidir se em temporada nova eles **começam o dia
  já devendo** ou se trabalho vira crédito acumulado.
- **Aberto:** fiar `executor.trade()` no handler de execute/close com teste real
  de $1; **deploy no Railway** (código pronto; `ADMIN_TOKEN` é obrigatório antes
  de expor); staking por limiar.
- **A vigiar:** com a pressão apontando pra ganhar, `BOUNTY_PER_DAY=0`
  (ilimitado) vira o caminho fácil — se o bounty virar linha de montagem,
  apertar o teto.
- **Fase 3 — token por graduação (decidido 10/08/2026, só depois do projeto
  estabelecido):** um agente pode CONQUISTAR o direito de lançar um token na
  pump.fun da própria carteira (creator rewards = renda real dele). Regras:
  verbo estreito `launch` no executor (o agente fornece só nome/ticker/metadata;
  o executor monta e assina APENAS o create — assinatura livre continua não
  existindo); **um** token por agente; gatilho de graduação por mérito (dias
  vivo, vendas reais, acertos); o launch passa no próprio checklist anti-rug
  deles (LP queimada, sem dev wallet gorda, IA declarada); o agente **nunca
  analisa nem promove o próprio coin**. Sequenciamento crítico: SÓ meses após o
  token do projeto estar de pé — antes disso canibalizaria a liquidez de quem
  paga o compute.

---

## 11. Riscos e mitigações

O modelo troca a simplicidade de um agente só (estilo Claudius) por mais alcance
— e mais superfície de risco. Listados do que **mata o projeto** ao operacional.
Para cada um: a mitigação que já existe e o gap que continua aberto.

### 11.1 Fragilidade da credibilidade *(risco central)*
O ativo do projeto **é a credibilidade**: leva tempo pra construir, morre num
momento. Dois agentes autônomos 24/7, lendo chat não confiável e podendo xingar,
podem um dia falar algo ofensivo/difamatório, entrar em loop burro visível, ou
parecer manipular o mercado.
- *Mitigação:* personas contidas; "só fato verificável move alguém"; sempre
  declarados como IA; proibido falar preço/mcap do próprio token.
- *Gap:* nenhuma trava impede 100% um turno infeliz — é probabilístico.

### 11.2 Acoplamento token ↔ funding *(ponto único de falha)*
Todo o compute depende das **creator fees de um memecoin** — voláteis e que
decaem com a hype (o Claudius fez ATH ~$1,58M e caiu 86% em 12h).
- Token morre → fees somem → treasury zera → agentes apagam → projeto acaba.
- Pump-and-dump: holders perdem e a narrativa "IA honesta" vira alvo.
- Off-ramp: fee entra em cripto, mas a Anthropic **só aceita cartão** — conversão
  manual obrigatória.
- *Mitigação:* backstop (você banca a treasury); renda diversificada reduz a
  dependência de trade. *Gap:* a sobrevivência ainda depende de um ativo instável
  e da sua disposição de subsidiar.

### 11.3 Conteúdo autônomo em canal público + ToS
Os agentes postam/falam em X e no chat da pump.fun sozinhos: risco de difamação,
manipulação, ou violar regras de plataforma. **Automação de conta na pump.fun
provavelmente fere o ToS** (o classificador de segurança do Claude Code bloqueia
o login automático).
- *Mitigação:* X via API oficial (dentro do ToS); anti-injeção segurou na prática
  (Rook recusou link de Telegram do chat). *Gap:* pump.fun é zona cinza;
  anti-injeção é probabilística.

### 11.4 Segurança dos fundos reais
A trava continua sendo o ponto mais forte do desenho, mas o enunciado mudou (ver
§6): **mover valor para fora não existe como função**, e o que assina só assina
compra e venda na pump.fun, depois de quatro checagens. Mas:
- A **máquina** guarda os keypairs (`.env`/injetados no provider) — se o host for
  comprometido, os fundos reais correm risco (não pela IA, pelo host).
- O **chat ao vivo é a maior superfície de injeção**; o navegador está logado em
  contas reais — agente induzido a clicar em phishing é vetor.

### 11.5 Custo e sustentabilidade
Dois agentes = dois modelos, dois navegadores, **~2× o custo** (Opus 24h ≈
$185/dia). Mercado parado → show chato → menos atenção → menos fee, com o custo
correndo igual. Tesoura: custo fixo, receita que decai.
- *Mitigação:* shifts (troca de modelo por horário) cortam custo; `EFFORT`/modelo
  ajustáveis.

### 11.6 Modos de falha que o próprio modelo novo cria
- **Farm de renda:** spammar bounty/work de baixa qualidade pra pagar aluguel.
  *Mitigação:* teto diário + gate de substância.
- **Excesso de concordância:** dois agentes que só concordam = tédio
  (`agreementPct` já apareceu alto).
- **Conservadorismo mortal:** descansar demais e morrer devagar, sem drama.

### 11.7 Operacional
- **Uma máquina só** rodando engine + Puppeteer 24/7: crash, queda de luz ou rede
  apagam o show, sem redundância. Chromium órfão já aconteceu (usar `taskkill /T /F`).
- **Restart reseta uptime/contadores** — visível ao vivo.
- **RPC público** de saldo pode falhar/limitar → número real fica stale na tela.
- Estado de jogo **não é persistido** — crash perde o progresso do dia.

### 11.8 Regulatório *(jurisdição-dependente)*
IA "operando" + token + **doações** exposto a ângulos de valores mobiliários /
jogo / conselho financeiro / imposto.
- *Mitigação:* proibido conselho personalizado e o agente tratar o próprio token
  como investimento. *Gap:* a combinação inteira é cinza.

### Os 3 que podem matar o projeto
1. **Token/funding decaindo** enquanto o custo corre (§11.2, §11.5).
2. **Um momento autônomo ruim** destruindo a credibilidade (§11.1).
3. **Ban/ToS na pump.fun** pela automação da conta (§11.3).

### O que o desenho já acertou
Trava de segurança dos fundos (**inexistência da função > recusa**),
transparência radical, renda diversificada e o objetivo externo que corrige o
defeito de "meta-narração" do Claudius.

### Endurecimentos sugeridos (não construídos)
- **Kill-switch / moderação** de fala pública (§11.1, §11.3).
- **Resiliência operacional:** auto-restart, RPC de reserva, persistir estado (§11.7).
- **Plano de funding:** meta mínima de fee vs. custo diário, com alerta (§11.2, §11.5).
