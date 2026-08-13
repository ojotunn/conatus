// ============================================================================
// Cliente do modelo + contabilidade de custo — o "aluguel" do agente.
//
// Cada chamada devolve, junto da decisao, quanto ela custou em dolares reais.
// Esse numero sai da carteira do agente: existir tem preco, pensar fundo custa
// mais, e quem quebra literalmente nao consegue mais pensar. E o unico numero
// do projeto que nao e simulado nem na Fase 1.
//
// Precos em USD por milhao de tokens (Anthropic, jun/2026). Cache: escrita
// custa 1.25x a entrada, leitura 0.1x.
// ============================================================================

import Anthropic from "@anthropic-ai/sdk";

const PRICES = {
  "claude-opus-5": { in: 5.0, out: 25.0 },
  "claude-sonnet-5": { in: 3.0, out: 15.0 },
  "claude-haiku-4-5": { in: 1.0, out: 5.0 },
};

const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.1;

let client = null;

function getClient() {
  if (!client) client = new Anthropic(); // le ANTHROPIC_API_KEY do ambiente
  return client;
}

// Converte o bloco `usage` da resposta em dolares. Se o modelo nao estiver na
// tabela, cai no preco do Opus para nao subfaturar o aluguel por engano.
export function priceUsage(model, usage) {
  const p = PRICES[model] ?? PRICES["claude-opus-5"];
  const inTok = usage?.input_tokens ?? 0;
  const outTok = usage?.output_tokens ?? 0;
  const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const usd =
    (inTok * p.in +
      cacheWrite * p.in * CACHE_WRITE_MULT +
      cacheRead * p.in * CACHE_READ_MULT +
      outTok * p.out) /
    1e6;
  return {
    usd,
    inTok,
    outTok,
    cacheWrite,
    cacheRead,
    totalTok: inTok + outTok + cacheWrite + cacheRead,
  };
}

// Contrato de saida do agente. Um objeto plano com tudo obrigatorio e
// anulavel — schema estrito rejeita campo opcional, entao o "nao se aplica"
// vira null em vez de ausencia.
const ACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["journal", "aside", "action"],
  properties: {
    journal: {
      type: "string",
      description:
        "O que voce esta pensando agora, em primeira pessoa. Isso vai ao vivo na tela.",
    },
    // O PENSAMENTO PRIVADO: o publico ve, o outro agente NUNCA. E a camada
    // interior — o que voce nao diria em voz alta. String vazia = sem aside.
    aside: {
      type: "string",
      description:
        "A private thought your housemate never sees (the audience does). What you actually feel or suspect but would not say out loud. Empty string if nothing.",
    },
    action: {
      type: "object",
      additionalProperties: false,
      required: [
        "type", "remark", "reason", "query", "to", "text", "venue", "market", "side",
        "sizeUsd", "conviction", "thesis", "invalidation", "proposalId",
        "evidence", "positionId", "lesson", "personaText", "why",
      ],
      properties: {
        type: {
          type: "string",
          enum: [
            "rest",
            "search",
            "research",
            "browse",
            "speak",
            "work",
            "propose",
            "object",
            "execute",
            "close",
            "lend",
            // `pay` nao acrescenta campo nenhum ao schema — reusa sizeUsd e
            // reason. Valor de enum e de graca; propriedade com union e que
            // conta para o teto de 16 do validador.
            "pay",
            // Tres fontes de renda novas. Nenhuma acrescenta campo ao schema —
            // reusam `market`/`text`/`reason`, entao a contagem de union
            // continua 16/16. So mais valor de enum, que e de graca.
            "rugcheck",
            "sell",
            "bounty",
            // Peticao de emprestimo ao BANCO (humano). Nao acrescenta campo:
            // reusa sizeUsd (valor) + reason (o argumento) + proposalId
            // (co-assinatura do pedido do outro). Enum e de graca.
            "borrow",
            // METAS de longo prazo (o horizonte alem do aluguel). Reusa `text`
            // (a lista de aspiracoes, uma por linha). Enum e de graca.
            "aspire",
            "post",
            "remember",
            "rewrite_persona",
          ],
        },
        // Uma fala dirigida ao outro agente, colada em QUALQUER acao. E o que
        // impede o palco de virar dois monologos: o agente age e comenta no
        // mesmo turno, sem custo extra de chamada. null quando nao ha o que dizer.
        remark: { type: ["string", "null"] },
        reason: { type: ["string", "null"] },
        // No `browse`, `query` carrega o movimento ("scroll down" | "scroll up" |
        // "click: <texto>" | "back") — campo proprio estouraria o limite de 16
        // parametros com union do validador da API.
        query: { type: ["string", "null"] },
        to: { type: ["string", "null"] },
        text: { type: ["string", "null"] },
        // enum SOZINHO, sem `type` ao lado: o validador estrito da API rejeita a
        // combinacao dos dois ("Enum value 'pump' does not match declared type").
        // O enum ja restringe os valores, entao o type e redundante de qualquer jeito.
        // UM venue so: pump.fun, a vista. Perps sairam (sem API real; ver
        // broker.js). Comprar e a unica entrada; sair e `close`.
        venue: { enum: ["pump", null] },
        market: { type: ["string", "null"] },
        side: { enum: ["buy", null] },
        sizeUsd: { type: ["number", "null"] },
        conviction: { type: ["number", "null"] },
        thesis: { type: ["string", "null"] },
        invalidation: { type: ["string", "null"] },
        proposalId: { type: ["string", "null"] },
        evidence: { type: ["string", "null"] },
        positionId: { type: ["string", "null"] },
        lesson: { type: ["string", "null"] },
        personaText: { type: ["string", "null"] },
        why: { type: ["string", "null"] },
      },
    },
  },
};

// Uma decisao. `system` fica estavel entre turnos (cache); `situation` e o que
// muda. Devolve { journal, action, cost } — cost ja precificado.
// No Haiku o `effort` nao existe, mas o raciocinio existe pela porta antiga
// (`budget_tokens`). Sem isto, trocar o modelo desliga o pensamento inteiro em
// silencio — nenhum erro, so respostas mais rasas. Verificado em 12/08/2026:
// Haiku aceita thinking + schema JSON na mesma chamada.
const HAIKU_BUDGET = { low: 1024, medium: 2048, high: 4096, xhigh: 6144, max: 8192 };

export async function decide({ model, effort, system, situation, maxTokens = 4000 }) {
  // `effort` so existe em Opus 4.5+ / Sonnet 4.6+. Haiku recusa o parametro
  // com 400 ("This model does not support the effort parameter") e o engine
  // cai em loop — entao no Haiku a gente traduz effort em orcamento de thinking.
  const supportsEffort = !/haiku/i.test(model);
  const budget = supportsEffort ? 0 : (HAIKU_BUDGET[effort] ?? HAIKU_BUDGET.medium);

  const res = await getClient().messages.create({
    model,
    // O orcamento de pensamento sai do mesmo teto da resposta, entao ele ganha
    // espaco proprio — senao o agente pensa e fica sem folego pra agir.
    max_tokens: maxTokens + budget,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    ...(budget ? { thinking: { type: "enabled", budget_tokens: budget } } : {}),
    output_config: {
      ...(supportsEffort ? { effort } : {}),
      format: { type: "json_schema", schema: ACTION_SCHEMA },
    },
    messages: [{ role: "user", content: situation }],
  });

  const cost = priceUsage(model, res.usage);

  if (res.stop_reason === "refusal") {
    return {
      journal: "(recusei responder a este contexto)",
      aside: "",
      action: { type: "rest", reason: "refusal" },
      cost,
      refused: true,
    };
  }

  const text = res.content.find((b) => b.type === "text")?.text ?? "{}";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Saida truncada (max_tokens) — trata como turno perdido, mas o aluguel
    // ja foi gasto e tem que ser cobrado assim mesmo.
    return {
      journal: "(minha resposta foi cortada antes de terminar)",
      aside: "",
      action: { type: "rest", reason: "truncated" },
      cost,
      truncated: true,
    };
  }

  return {
    journal: parsed.journal ?? "",
    aside: String(parsed.aside ?? "").trim(),
    action: parsed.action ?? { type: "rest" },
    cost,
  };
}

// Texto livre, sem schema — para os SONHOS (uma chamada barata por noite).
// Devolve { text, cost }. Nao entra no fluxo de acao: e literatura, nao decisao.
export async function freeText({ model, system, user, maxTokens = 400 }) {
  const res = await getClient().messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  const cost = priceUsage(model, res.usage);
  const text = res.content.find((b) => b.type === "text")?.text?.trim() ?? "";
  return { text, cost };
}
