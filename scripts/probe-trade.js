// ============================================================================
// Teste OFFLINE do executor — UM venue: pump.fun, a vista. Perps sairam do
// projeto (12/08/2026): a API do Jupiter Perps nao existe (so programa Anchor),
// e alavancagem nao e lugar pra codigo improvisado com dinheiro real.
//
// Cobre: as checagens deterministicas (honeypot Token-2022, piso de liquidez,
// teto de % da pool, teto por operacao, freio diario), o PnL pela variacao do
// market cap, a venda parcial e o piso de perda (token a zero = -100%, nunca
// mais). Rodar: node scripts/probe-trade.js
// ============================================================================

import * as broker from "../src/lib/broker.js";

let fails = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  PASS  ${msg}`);
  else { console.log(`  FAIL  ${msg}`); fails++; }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const MINT = "Ge87EtsjwRQbHaqQmKRno69RFTwh9bfSsm99XNxTpump";
// Token saudavel. `virtualSol` = a CURVA (define slippage); `realSol` = o
// dinheiro que de fato entrou no token. Sao coisas diferentes — confundir as
// duas foi um bug real, achado pelo Michel em 12/08/2026.
const token = (over = {}) => ({
  mint: MINT, tokenProgram: "spl", virtualSol: 1000, realSol: 100, usdMarketCap: 1e6, ...over,
});
const ctx = (over = {}) => ({ markets: [], tokens: {}, solUsd: 100, token: token(), ...over });
const cfg = { dailyLossLimitPct: 30, minPoolUsd: 5000, maxPoolPct: 2 };
const newAgent = () => ({
  id: "sable", wallet: 100, dayPnl: 0, dayStartWallet: 100, maxTradePct: 40,
  earned: { trade: 0 }, recentEarned: { trade: 0 }, dayEarned: 0,
  spent: { fees: 0 }, stats: { trades: 0, wins: 0, losses: 0 },
});
const newState = () => ({ seq: 0, tick: 0, positions: [] });
const buy = (sizeUsd = 10) => ({ venue: "pump", market: MINT, side: "buy", sizeUsd });

// ------------------------------------------------- 1. checagens de entrada
console.log("\n1) check: as recusas deterministicas");
const a = newAgent();
ok(broker.check(a, buy(10), ctx(), cfg).ok === true, "compra saudavel aceita");
ok(broker.check(a, buy(50), ctx(), cfg).ok === false, "acima do teto por operacao (40% de $100) recusada");
ok(broker.check(a, { ...buy(10), side: "sell" }, ctx(), cfg).ok === false, "side diferente de buy recusado (a vista, sem short)");
ok(broker.check(a, { ...buy(10), venue: "jupiter" }, ctx(), cfg).ok === false, "venue jupiter (perp) NAO existe mais");
// O honeypot agora e julgado pelo RAIO-X do mint (wallet.inspectMint), que o
// engine poe em ctx.mintReport — por EXTENSAO perigosa, nao pelo programa.
ok(broker.check(a, buy(10), ctx({ mintReport: { ok: false, dangers: ["permanent delegate — o dono pode confiscar"] } }), cfg).ok === false,
  "mint reprovado no raio-x (permanent delegate) e recusado");
ok(broker.check(a, buy(10), ctx({ mintReport: { ok: false, dangers: ["freeze authority ativa"] } }), cfg).ok === false,
  "freeze authority recusada (risco que a regra antiga NAO pegava)");
ok(broker.check(a, buy(10), ctx({ mintReport: { ok: true, dangers: [], isToken2022: true, extensions: ["metadataPointer", "tokenMetadata"] } }), cfg).ok === true,
  "Token-2022 so com metadata PASSA (a maioria da pump.fun hoje)");

// MAYHEM MODE: regra da casa — nao se compra no meio do evento.
ok(broker.check(a, buy(10), ctx({ token: token({ mayhemState: "active" }) }), cfg).ok === false,
  "token com MAYHEM MODE ativo recusado");
ok(/MAYHEM/.test(broker.check(a, buy(10), ctx({ token: token({ mayhemState: "active" }) }), cfg).reason),
  "a recusa diz que foi o mayhem (o agente entende o porque)");
ok(broker.check(a, buy(10), ctx({ token: token({ mayhemState: null }) }), cfg).ok === true,
  "token sem mayhem passa normalmente");
// Boost pos-migracao NAO bloqueia — e outra coisa, so contexto.
ok(broker.check(a, buy(10), ctx({ token: token({ boostMode: "COMPLETED" }) }), cfg).ok === true,
  "boost pos-migracao NAO bloqueia (nao e mayhem)");
// O piso olha o DINHEIRO DE VERDADE dentro do token (realSol), nao a curva.
ok(broker.check(a, buy(10), ctx({ token: token({ realSol: 0 }) }), cfg).ok === false,
  "token zerado ($0 dentro) recusa ordem de $10");
ok(/de verdade dentro/.test(broker.check(a, buy(10), ctx({ token: token({ realSol: 0 }) }), cfg).reason),
  "a recusa explica que o dinheiro real e que falta");
// Mas ordem MENOR que o que ja tem dentro passa — e o caso do teste de $1:
// na curva sempre da pra vender de volta, entao token zerado nao e armadilha.
ok(broker.check(a, { ...buy(1), sizeUsd: 0.5 }, ctx({ token: token({ realSol: 0.02 }) }), cfg).ok === true,
  "ordem menor que o que ha dentro passa (o teste de $1 em token novo)");
// A curva (virtualSol) segue mandando no SLIPPAGE, nao na liquidez.
ok(broker.check(a, buy(10), ctx({ token: token({ virtualSol: 4 }) }), cfg).ok === false,
  "ordem grande demais para a CURVA recusada (slippage)");
ok(broker.check(a, buy(10), ctx({ token: token({ virtualSol: 4 }) }), cfg).ok === false,
  "ordem grande demais para a pool recusada");
ok(broker.check(a, buy(10), ctx({ token: token({ usdMarketCap: 0 }) }), cfg).ok === false,
  "sem market cap legivel recusada (nao compro o que nao sei revender)");
ok(broker.check(a, buy(10), ctx({ token: { ...token(), mint: "OutroMint" } }), cfg).ok === false,
  "ficha de outro token recusada (nao compro as cegas)");
const broke = { ...newAgent(), wallet: 0 };
ok(broker.check(broke, buy(1), ctx(), cfg).ok === false, "carteira zerada recusada");
const perdedor = { ...newAgent(), dayPnl: -40 };
ok(broker.check(perdedor, buy(1), ctx(), cfg).ok === false, "freio de perda diaria (-30%) recusa");

// ------------------------------------------------- 2. entrada e preco
console.log("\n2) fill: entrada = market cap do momento");
{
  const ag = newAgent(); const st = newState();
  const v = broker.check(ag, buy(10), ctx(), cfg);
  ok(near(v.price, 1e6) && v.fee === 0.01, "entrada = mcap ($1M), taxa 1%");
  const pos = broker.fill(ag, buy(10), v, st);
  ok(pos.market === MINT && pos.venue === "pump", "posicao guarda o mint");
  ok(pos.leverage === undefined, "sem campo de alavancagem (nao existe mais)");
  // A carteira e ON-CHAIN desde 12/08/2026: a taxa ja saiu de la quando a ordem
  // executou. Debitar de novo no codigo seria contar duas vezes.
  ok(near(ag.wallet, 100), "carteira NAO e mexida pelo codigo (a corrente ja cobrou)");
  ok(near(ag.spent.fees, 0.1), "a taxa continua registrada em spent.fees (1% de $10)");
}

// ------------------------------------------------- 3. PnL pela variacao do mcap
console.log("\n3) mark + close: PnL = variacao do market cap");
{
  const ag = newAgent(); const st = newState();
  const v = broker.check(ag, buy(10), ctx(), cfg);
  const pos = broker.fill(ag, buy(10), v, st);
  broker.mark(st, { tokens: { [MINT]: { usdMarketCap: 1.5e6 } } }); // +50%
  ok(near(pos.unrealized, 5), "mcap +50% -> unrealized +$5 (sem lucro fantasma)");
  const done = broker.close(ag, pos, st, "take profit");
  ok(near(done.realized, 5 - 0.1), "realized = ganho - taxa de saida");
  ok(ag.stats.wins === 1 && ag.earned.trade > 0, "conta vitoria + renda de trade");
}

// ------------------------------------------------- 4. o piso da perda
console.log("\n4) o token pode ir a zero — e esse e o piso");
{
  const ag = newAgent(); const st = newState();
  const v = broker.check(ag, buy(10), ctx(), cfg);
  const pos = broker.fill(ag, buy(10), v, st);
  broker.mark(st, { tokens: { [MINT]: { usdMarketCap: 0 } } });
  ok(near(pos.unrealized, -10), "token a zero = -$10 (a entrada inteira)");
  broker.mark(st, { tokens: { [MINT]: { usdMarketCap: -5 } } }); // dado maluco
  ok(near(pos.unrealized, -10), "nunca perde MAIS que a entrada, nem com dado ruim");
}

// ------------------------------------------------- 5. venda parcial
console.log("\n5) venda parcial: realiza a fatia, deixa o resto correr");
{
  const ag = newAgent(); const st = newState();
  const v = broker.check(ag, buy(10), ctx(), cfg);
  const pos = broker.fill(ag, buy(10), v, st);
  broker.mark(st, { tokens: { [MINT]: { usdMarketCap: 2e6 } } }); // +100% -> +$10
  const trim = broker.close(ag, pos, st, "take some", 4);
  ok(trim.partial === true && near(trim.remaining, 6), "vendeu $4, restam $6 abertos");
  ok(near(trim.realized, 10 * 0.4 - 4 * 0.01), "realizou 40% do PnL, taxa so sobre a fatia");
  ok(st.positions.length === 1 && near(st.positions[0].sizeUsd, 6), "posicao continua com $6");
  const rest = broker.close(ag, st.positions[0], st, "close rest");
  ok(rest.partial === false && st.positions.length === 0, "sem sizeUsd vende o restante todo");
  const ag2 = newAgent(); const st2 = newState();
  const p2 = broker.fill(ag2, buy(10), broker.check(ag2, buy(10), ctx(), cfg), st2);
  broker.mark(st2, { tokens: { [MINT]: { usdMarketCap: 1e6 } } });
  const over = broker.close(ag2, p2, st2, "oversized", 999);
  ok(over.partial === false && st2.positions.length === 0, "pedir mais do que tem vende tudo");
}

console.log(`\n${fails === 0 ? "TODOS VERDES" : fails + " FALHA(S)"}\n`);
process.exit(fails === 0 ? 0 : 1);
