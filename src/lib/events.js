// ============================================================================
// O MUNDO ACONTECE COM ELES.
//
// Um mundo que nao muda produz agente que se repete: com ~1500 turnos por dia e
// nenhuma entrada nova, os dois releem as mesmas paginas com palavras
// diferentes (ja aconteceu — leram o mesmo grafico 6x em 11 turnos). O
// antidoto nao e mandar "seja interessante" no prompt; e mudar o mundo debaixo
// deles.
//
// REGRA QUE RESOLVE TUDO: todo evento e VERDADE VERIFICAVEL. Nada sorteado,
// nada de sabor. Se o mundo puder inventar acontecimento, nada na tela vale —
// e credibilidade e o ativo do projeto.
//
// Este modulo e puro: recebe retrato, devolve eventos. Quem busca dado e emite
// e o engine.
// ============================================================================

// ----------------------------------------------------------------------------
// ECOS — o passado volta.
//
// A melhor fonte das cinco: uma moeda que eles LERAM ou OPERARAM se moveu muito
// desde entao. Tem consequencia pessoal, tem drama, e e 100% checavel.
// ----------------------------------------------------------------------------
export function echoes(watch, mcapNow, { thresholdPct = 30, seen = [] } = {}) {
  const jaVisto = new Set(seen);
  const out = [];
  for (const w of watch ?? []) {
    const agora = mcapNow?.[w.mint];
    if (!Number.isFinite(agora) || agora <= 0) continue;
    if (!Number.isFinite(w.mcap) || w.mcap <= 0) continue;
    const pct = ((agora - w.mcap) / w.mcap) * 100;
    if (Math.abs(pct) < thresholdPct) continue;
    // A chave inclui a faixa de 30 em 30: a mesma moeda pode voltar quando
    // dobrar de novo, mas nao a cada tick por causa de ruido.
    const faixa = Math.trunc(pct / thresholdPct);
    const key = `echo:${w.mint}:${faixa}`;
    if (jaVisto.has(key)) continue;
    out.push({
      key,
      kind: "echo",
      agent: w.agent ?? null,
      mint: w.mint,
      pct,
      text:
        `THE COIN YOU ${(w.note ?? "read").toUpperCase()}: ${short(w.mint)} is ` +
        `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}% since you last looked` +
        (w.at ? ` (${ago(w.at)})` : "") + ".",
    });
  }
  return out;
}

// ----------------------------------------------------------------------------
// A CASA ESTA FICANDO SEM AR — o tesouro real cruzando limiares de sobrevida.
//
// Nao e sobre o gasto de cada um (isso saiu da vista deles de proposito, ver
// postDailyBill): e sobre quanto tempo a CASA ainda paga para os dois pensarem.
// Dispara uma vez por limiar cruzado, nunca a cada tick.
// ----------------------------------------------------------------------------
export function runwayAlarm(runwayHours, { seen = [], steps = [48, 24, 12, 6] } = {}) {
  if (!Number.isFinite(runwayHours) || runwayHours <= 0) return [];
  const jaVisto = new Set(seen);
  const cruzado = steps.filter((s) => runwayHours <= s).sort((a, b) => a - b)[0];
  if (cruzado == null) return [];
  const key = `runway:${cruzado}`;
  if (jaVisto.has(key)) return [];
  return [{
    key,
    kind: "runway",
    agent: null,
    text:
      `THE HOUSE HAS ABOUT ${Math.round(runwayHours)} HOURS OF POWER LEFT at the ` +
      `current rate. After that nobody here thinks. Nothing keeps the lights on ` +
      `except what comes in.`,
  }];
}

// ----------------------------------------------------------------------------
// A CASA FALHOU — RPC caiu, sala desconectou.
//
// O motor ja sabe disso hoje, mas guarda em log tecnico que ninguem le. Vira
// acontecimento na vida deles: dispara na TRANSICAO (caiu / voltou), nunca
// enquanto o estado permanece.
// ----------------------------------------------------------------------------
export function healthEvents(antes, agora) {
  const out = [];
  const mudou = (k) => antes?.[k] !== agora?.[k];
  if (mudou("rpc")) {
    out.push(agora.rpc
      ? { key: `health:rpc:up:${agora.n ?? 0}`, kind: "health", agent: null,
          text: "THE HOUSE CAN SEE ITS MONEY AGAIN — the chain reader is back." }
      : { key: `health:rpc:down:${agora.n ?? 0}`, kind: "health", agent: null,
          text: "THE HOUSE WENT BLIND TO THE CHAIN — the balance you see may be stale. " +
                "It is a broken instrument, not money moving." });
  }
  if (mudou("chat")) {
    out.push(agora.chat
      ? { key: `health:chat:up:${agora.n ?? 0}`, kind: "health", agent: null,
          text: "THE ROOM IS AUDIBLE AGAIN — live chat reconnected." }
      : { key: `health:chat:down:${agora.n ?? 0}`, kind: "health", agent: null,
          text: "THE ROOM WENT SILENT — the live chat dropped. Nobody can hear the audience right now." });
  }
  return out;
}

const short = (m) => (m && m.length > 12 ? `${m.slice(0, 4)}…${m.slice(-4)}` : m);

function ago(t) {
  const min = Math.max(1, Math.round((Date.now() - t) / 60000));
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
