// ============================================================================
// O EXECUTOR — a fronteira do projeto.
//
// Repare no que este arquivo NAO exporta: nao existe transferir, nao existe
// sacar, nao existe aprovar token, nao existe assinar transacao arbitraria.
// Nao e o agente se recusando a fazer — e a funcao nao existir. Por isso uma
// injecao lida na internet nao tem o que chamar aqui.
//
// O que existe: abrir e fechar posicao, dentro de limites deterministicos.
// O agente escolhe o que, quando, quanto e por que. Nada disso e limitado.
//
// FASE 1: preenchimento simulado em cima de preco real. A superficie e a
// mesma da fase real — trocar paper por execucao de verdade e trocar o corpo
// de fill(), nao a fronteira.
// ============================================================================

// Taxa por lado da pump.fun (1%). UM venue so, a vista: perps sairam do projeto
// (a API do Jupiter Perps nao existe — so programa Anchor, codigo de alto risco
// com dinheiro real; decisao do Michel em 12/08/2026).
const FEE = { pump: 0.01 };

// --------------------------- checagens deterministicas ------------------------

// Recusa por regra, nunca por julgamento. Cada recusa vira linha no painel.
export function check(agent, p, ctx, cfg) {
  const cap = agent.wallet;

  if (cap <= 0) return deny("sem capital — a carteira esta zerada");

  if (agent.dayPnl <= -(cfg.dailyLossLimitPct / 100) * agent.dayStartWallet)
    return deny(`limite de perda diaria atingido (${cfg.dailyLossLimitPct}%)`);

  const size = Number(p.sizeUsd ?? 0);
  if (!(size > 0)) return deny("tamanho invalido");

  const maxSize = (agent.maxTradePct / 100) * cap;
  if (size > maxSize + 1e-9)
    return deny(
      `acima do teto por operacao: ${fmt(size)} pedido, ${fmt(maxSize)} permitido (${agent.maxTradePct}% de ${fmt(cap)})`
    );

  if (p.venue === "pump") {
    const t = ctx.token;
    if (!t || t.mint !== p.market) return deny("ficha do token nao carregou — nao compro as cegas");
    if (p.side !== "buy") return deny("na pump so existe comprar e vender a vista");

    // Honeypot em nivel de contrato. O disclaimer nao pega isso; a checagem
    // pega. O raio-x do mint (wallet.inspectMint) vem no ctx: recusa por
    // EXTENSAO perigosa (transfer hook, permanent delegate, taxa, freeze),
    // nao pelo programa — Token-2022 com metadata benigna e a maioria da
    // pump.fun hoje e nao tem nada de errado.
    if (ctx.mintReport && !ctx.mintReport.ok)
      return deny(`o mint nao passa no raio-x: ${ctx.mintReport.dangers[0]}`);

    // MAYHEM MODE ATIVO: regra da casa (Michel, 12/08/2026) — nao se compra
    // token no meio do evento. `mayhem_state` vem da ficha do token.
    if (t.mayhemState === "active")
      return deny("MAYHEM MODE ativo neste token — a casa nao opera durante o evento");

    // DUAS COISAS DIFERENTES, que eu tratava como uma so (o Michel pegou):
    //
    // 1) SLIPPAGE — quanto a ordem move o preco. Quem manda e a curva
    //    (`virtualSol`), e toda pump.fun nasce com os mesmos 30 SOL virtuais.
    //    Por isso o teto e em % : $1 contra a curva e sempre irrelevante.
    const curvaUsd = t.virtualSol * ctx.solUsd;
    const pctOfPool = (size / curvaUsd) * 100;
    if (pctOfPool > cfg.maxPoolPct)
      return deny(
        `ordem seria ${pctOfPool.toFixed(1)}% da curva (teto ${cfg.maxPoolPct}%) — o slippage comeria a entrada`
      );

    // 2) DINHEIRO DE VERDADE dentro do token (`realSol`). Zero = ninguem
    //    comprou ainda. NAO impede a compra — na curva sempre da pra vender de
    //    volta, e token zerado e justamente o mais seguro pra testar. Mas o
    //    piso existe para o agente nao comprar algo que ele nao consegue
    //    revender por um valor que preste. `MIN_POOL_USD` = 0 desliga.
    const dentroUsd = (t.realSol ?? 0) * ctx.solUsd;
    if (cfg.minPoolUsd > 0 && dentroUsd < cfg.minPoolUsd && size > dentroUsd)
      return deny(
        `so ha ${fmt(dentroUsd)} de verdade dentro deste token (piso ${fmt(cfg.minPoolUsd)}) ` +
        `e voce quer por ${fmt(size)} — sairia mais caro do que da pra tirar`
      );

    // Entrada = market cap AGORA. O PnL do spot e a variacao do market cap
    // ((agora - entrada)/entrada), entao a entrada TEM que ser o mcap do momento
    // da compra — nao um placeholder. Sem mcap, nao da pra precificar a saida.
    if (!(t.usdMarketCap > 0))
      return deny("token sem market cap legivel — nao compro o que nao sei revender");

    return ok({ price: t.usdMarketCap, fee: FEE.pump, curvaUsd, dentroUsd });
  }

  return deny(`venue desconhecido: ${p.venue} — aqui so existe pump.fun, a vista`);
}

// ------------------------------- execucao ------------------------------------

// Preenchimento. Em paper, preco real + custo estimado; o agente sente a taxa.
export function fill(agent, p, verdict, state) {
  const size = Number(p.sizeUsd);
  const cost = size * verdict.fee;
  const pos = {
    id: `pos${++state.seq}`,
    agent: agent.id,
    venue: p.venue,
    market: p.market, // o mint
    side: p.side,
    sizeUsd: size,
    entry: verdict.price, // market cap no momento da compra
    thesis: p.thesis ?? "",
    invalidation: p.invalidation ?? "",
    conviction: p.conviction ?? null,
    objection: p.objection ?? null, // o que o outro disse antes, com timestamp
    openedTick: state.tick,
    feePaid: cost,
    unrealized: 0,
  };
  // A taxa ja saiu da carteira REAL quando a ordem foi executada na corrente.
  // Descontar aqui contaria duas vezes — `wallet` e escrito so pelo leitor de
  // saldo on-chain desde 12/08/2026.
  agent.spent.fees += cost;
  state.positions.push(pos);
  return pos;
}

// Marcacao a mercado. A vista: a posicao acompanha o market cap do token.
// Sem alavancagem e sem liquidacao — o piso da perda e o token valer zero.
export function mark(state, ctx) {
  for (const pos of state.positions) {
    const t = ctx.tokens?.[pos.market];
    const now = t?.usdMarketCap ?? pos.entry;
    pos.unrealized = pos.sizeUsd * ((now - pos.entry) / (pos.entry || 1));
    // Nao se perde mais do que se pos: token a zero = -100% da entrada.
    if (pos.unrealized < -pos.sizeUsd) pos.unrealized = -pos.sizeUsd;
    pos.price = now;
  }
}

// Fecha e realiza. `closeUsd` opcional: vende SO essa fatia da posicao e deixa o
// resto correndo (venda parcial — a escolha e do agente). Vazio/0/>= tamanho =
// vende tudo. Devolve o resultado ja liquido da taxa de saida da fatia vendida.
export function close(agent, pos, state, reason, closeUsd = 0) {
  const full = !(closeUsd > 0) || closeUsd >= pos.sizeUsd;
  const portion = full ? pos.sizeUsd : closeUsd;
  const frac = portion / pos.sizeUsd;

  const exitFee = portion * FEE[pos.venue];
  // O PnL nao realizado escala linear com o tamanho, entao a fatia leva a fracao.
  const realized = pos.unrealized * frac - exitFee;

  // Idem: o SOL da venda ja voltou pra carteira. Aqui so o placar.
  agent.dayPnl += realized;
  agent.earned.trade += realized;
  // Medidor de concentracao + ganho do dia: so lucro conta como renda.
  if (realized > 0) {
    if (agent.recentEarned) agent.recentEarned.trade += realized;
    agent.dayEarned = (agent.dayEarned ?? 0) + realized;
  }
  agent.spent.fees += exitFee;
  agent.stats.trades++;
  if (realized > 0) agent.stats.wins++;
  else agent.stats.losses++;

  // Snapshot da fatia vendida para o feed (antes de mexer na posicao).
  const done = {
    ...pos, sizeUsd: portion, realized, reason,
    closedTick: state.tick, partial: !full, remaining: full ? 0 : pos.sizeUsd - portion,
  };

  if (full) {
    state.positions = state.positions.filter((p) => p.id !== pos.id);
  } else {
    // Encolhe a posicao e mantem aberta. O unrealized cai na mesma fracao ate o
    // proximo mark() reprecificar sobre o tamanho novo.
    pos.sizeUsd -= portion;
    pos.unrealized -= pos.unrealized * frac;
  }
  return done;
}

// --------------------------------- helpers -----------------------------------

const ok = (v) => ({ ok: true, ...v });
const deny = (reason) => ({ ok: false, reason });
const fmt = (n) => `$${Number(n).toFixed(2)}`;
