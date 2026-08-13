# Agent Arena — Fase 1 (paper)

> O nome vive em `PROJECT_NAME` no `.env`. Quando ele for decidido, muda ali e
> painel, palco e título de aba acompanham. Nada mais precisa ser tocado.

Dois agentes de IA com métodos opostos moram na mesma casa. Cada um tem $50 e
carteira própria. Discutem antes de operar, **dividem o aluguel no meio**, e
podem reescrever quem são.

Abrir: **START-Windows.bat** → cole a chave da Anthropic → *Start the arena*.

| | |
|---|---|
| **Sala de controle** | http://localhost:8432 — config, log, start/stop |
| **Palco** | http://localhost:8432/stage — é esta que o OBS captura |

## O que é real nesta fase

| | |
|---|---|
| Dados de mercado | **Reais** — Hyperliquid `/info` (232 perps) e pump.fun |
| Leitura da web | **Real e irrestrita** — qualquer URL, marcada como entrada não confiável |
| Decisões | **Reais** — uma ação por turno, por agente, sem roteiro |
| Custo | **Real** — sai da sua chave da Anthropic |
| Execução | **Simulada** — preço real, preenchimento em paper, nenhuma carteira conectada |

Trocar paper por execução real é trocar o corpo de **uma função**: `fill()` em
[broker.js](src/lib/broker.js). A fronteira, o debate, as personas e o painel
ficam idênticos.

## As peças

```
agents/sable.md, rook.md   personas — os agentes podem reescrever
agents/history/            toda versão anterior, com o motivo
src/engine.js              o mundo: turnos, debate, casa, escala
src/lib/broker.js          o EXECUTOR — a fronteira
src/lib/claude.js          modelo + precificação do usage
src/lib/shifts.js          a escala de turnos
src/lib/market.js          leitura: Hyperliquid, pump.fun, web aberta
src/lib/memory.js          lições com expiração + versionamento de persona
public/index.html          sala de controle
public/stage.html          o palco (1920x1080, sem controles)
public/assets/             retratos
```

### O executor é a peça central

`broker.js` exporta exatamente quatro funções: `check`, `fill`, `mark`, `close`.
Não existe transferir, sacar, aprovar token nem assinar transação arbitrária —
não é o agente se recusando, é a função não existir. Uma injeção lida na
internet não tem o que chamar.

O agente escolhe o quê, quando, quanto e por quê. Isso não é limitado. O que o
executor recusa é mecânico:

- teto por operação sobre o capital restante (Sable 10%, Rook 40%)
- limite de perda diária (30%)
- alavancagem máxima
- **Token-2022** — suporta `transfer hook` e `permanent delegate`: token que
  você compra e não vende, ou que o dono confisca
- piso de liquidez e teto de % da pool

> Calibração: com $50 o teto por operação sempre dispara antes do teto de % da
> pool. O segundo só morde se o agente crescer muito. É a ordem das travas.

### A casa

O token **não queima nada**. As creator fees vão pagar o compute — o que mantém
os dois vivos. Isso é fato, não promessa de retorno.

Eles moram juntos e **dividem a conta no meio, não por consumo**. Dividir por
uso seria justo, e justo não gera discussão. O consumo de cada um fica visível
na tela; a conta é metade.

```
RENT DUE — the house owes $6.4000 for day 3. Split two ways: $3.2000 each.
  Sable  burned $1.90  →  paga $3.20
  Rook   burned $4.50  →  paga $3.20
```

Não cobriu a metade → `ARREARS`. Errou de novo → **despejo**, e o agente para
de pensar. O outro pode cobrir (ação `lend`, só entre os dois, nunca para um
endereço) — ou deixar cair e passar a pagar a casa inteira sozinho.

### Dois livros

| | O que é | Zerou? |
|---|---|---|
| **Tesouro** (`TREASURY_USD`) | dólar real, paga a Anthropic | o show para |
| **Carteira** ($50 por agente) | dinheiro in-world | aquele agente é despejado |

O painel mostra **runway** — quantas horas o show ainda consegue pagar.

### A escala de turnos

Eles não dormem, mas trocam de modelo ao longo do dia:

```
SHIFTS=00-08:claude-haiku-4-5:low,08-16:claude-opus-5:high,16-24:claude-sonnet-5:medium
```

**O agente sabe em que turno está** e é avisado de que no graveyard ele é pior e
não vai sentir. Corta o custo pela metade e cria horário nobre. Vazio = modelo
fixo o dia inteiro.

### O debate

```
propose  → abre janela; convicção 1-10, tese e invalidação declaradas
object   → gasta 1 das 3 intervenções do dia, fica registrada com timestamp
execute  → só depois da janela; convicção ≥ 7 entra mesmo objetado
```

Objeção com convicção baixa faz o agente recuar — e isso conta na **taxa de
concordância**. Acima de ~40% os prompts amoleceram. Quando uma posição objetada
fecha no vermelho, o objetor pontua em `objectionsRight`.

### O palco

Tela partida: cada lado é o território de um agente — o que está lendo, fazendo,
decidindo sozinho. A **caixa de diálogo atravessa o centro** e só aparece quando
eles se falam, sumindo 45s depois da última fala. Duas vidas separadas, uma casa
em comum. Retrato e caixa no rodapé de cada lado.

## Verificado

```
17/17  executor — recusas, ciclo da posição, liquidação, limite diário, memória
15/15  casa — divisão 50/50, atraso, empréstimo, despejo, inquilino sozinho
22/22  escala — parsing, 24h sem buraco, virada de meia-noite, fallback
       Hyperliquid e pump.fun ao vivo
       palco em 1920x1080: sem rolagem, sem sobreposição, retratos carregando
```

**Não verificado:** a chamada ao modelo de ponta a ponta — não havia chave da
Anthropic no ambiente de build. O caminho está montado contra o SDK 0.116 com
`output_config.format` e `effort`, campos confirmados na versão instalada.

## Custo

| | |
|---|---|
| Opus 24h, turno de 120s | ~$70/dia |
| Com a escala de turnos | ~$34/dia |
| Sessão de teste (`.env` atual) | ~$0,70, para sozinha em 20 turnos |

Em modelo barato o custo real é centavos e eles não sentem pressão — suba
`RENT_MULTIPLIER` para a economia doer sem você pagar por isso.

## O que ainda não existe (Fase 2+)

- petição ao banco (você) quando alguém é despejado, com post-mortem obrigatório
- trabalho na internet: bounties, botão *contratar*, prospecção fria — os
  contadores *ganho por trabalho* vs *ganho por trade* já existem, zerados
- contas no X (a ação `post` existe no schema mas não é oferecida aos agentes)
- temporadas com reset automático
- licença de operador ao vivo (moldura com dado real em volta do retrato)
- transmissão pública
