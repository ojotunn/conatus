// ============================================================================
// Teste OFFLINE das novas fontes de renda. Zero rede, zero API, zero arena.
//
// Importa o engine (seguro: so roda o mundo com isMain) e exercita direto os
// handlers rugcheck/sell/bounty, os gates, as cotas do dia, o acumulo em
// recentEarned, o decaimento no rollDay e a funcao pura incomeMix.
// Rodar: node scripts/probe-income.js
// ============================================================================

// O catalogo da loja aponta pra um descartavel ANTES de importar o engine —
// os handlers sell/rugcheck publicam peca, e o probe ja sujou o catalogo REAL
// uma vez por nao fazer isto. Import dinamico porque import estatico icaria.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "arena-income-"));
process.env.PIECES_FILE = path.join(TMP, "pieces.json");
process.env.CHECKPOINT_FILE = path.join(TMP, "checkpoint.json");
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.ARCHIVE_FILE = path.join(TMP, "archive.jsonl");
process.env.TOTALS_FILE = path.join(TMP, "totals.json");

const { state, cfg, apply, incomeMix, rollDay } = await import("../src/engine.js");

// Esta prova e dos TETOS POR CANAL. A jornada compartilhada (WORK_HOURS_PER_DAY)
// estouraria antes deles e mascararia o que esta sendo testado aqui — ela tem a
// prova dela em probe-hours.js. Uma mecanica por prova.
cfg.workHoursPerDay = 0;

let fails = 0;
const ok = (cond, msg) => {
  if (cond) { console.log(`  PASS  ${msg}`); }
  else { console.log(`  FAIL  ${msg}`); fails++; }
};
const near = (a, b) => Math.abs(a - b) < 1e-9;

// Um agente limpo em estado conhecido, sem depender de ordem de execucao.
function reset(a) {
  a.wallet = 50;
  a.earned = { trade: 0, work: 0, rugcheck: 0, sell: 0, bounty: 0 };
  a.recentEarned = { trade: 0, work: 0, rugcheck: 0, sell: 0, bounty: 0, tips: 0, paid: 0 };
  a.rugchecksToday = 0;
  a.sellsToday = 0;
  a.bountiesToday = 0;
  a.status = "solvent";
}

const S = state.agents.sable;
const long = (n) => "x".repeat(n);

// PUBLICAR NAO E RECEBER (regra do Michel, 12/08/2026). Antes estas acoes
// pingavam dolares na carteira e o palco anunciava lucro que nao existia em
// lugar nenhum. Agora a peca entra no catalogo e o caixa so sobe quando alguem
// PAGA de verdade. Esta prova impede que o dinheiro fantasma volte.
console.log("");
console.log("1) rugcheck ABATE A DIVIDA e nao toca a carteira");
reset(S);
await apply(S, { type: "rugcheck", market: "ABC123pump", text: long(320) });
ok(near(S.wallet, 50), `a CARTEIRA nao e tocada (era ${S.wallet}) — so a corrente escreve nela`);
ok(near(S.arrears, -cfg.rugcheckRateUsd), `o trabalho abateu $${cfg.rugcheckRateUsd} da divida (arrears negativo = a casa deve)`);
ok(near(S.earned.rugcheck, cfg.rugcheckRateUsd), "conta como renda no medidor de mix");
ok(near(S.recentEarned.rugcheck, cfg.rugcheckRateUsd), "e na janela recente");
ok(S.rugchecksToday === 1, `rugchecksToday == 1`);

console.log("\n2) gates de substancia recusam (nao credita, nao conta)");
reset(S);
await apply(S, { type: "rugcheck", market: "ABC", text: long(50) });   // texto curto
ok(near(S.wallet, 50) && S.rugchecksToday === 0, "texto < 300 recusado");
await apply(S, { type: "rugcheck", market: "", text: long(320) });      // sem mint
ok(near(S.wallet, 50) && S.rugchecksToday === 0, "market vazio recusado");

console.log("\n3) cota diaria bloqueia na (cap+1)-esima");
reset(S);
for (let i = 0; i < cfg.rugchecksPerDay; i++)
  await apply(S, { type: "rugcheck", market: "ABC123pump", text: long(320) });
const walletAtCap = S.wallet;
await apply(S, { type: "rugcheck", market: "ABC123pump", text: long(320) }); // estourar
ok(S.rugchecksToday === cfg.rugchecksPerDay, `parou em ${cfg.rugchecksPerDay}/dia`);
ok(near(S.wallet, walletAtCap), "carteira nao mexeu apos a cota");

console.log("");
console.log("4) sell e bounty tambem abatem divida, e exigem os campos certos");
reset(S);
await apply(S, { type: "sell", text: long(420), reason: "SOL microstructure" });
ok(near(S.earned.sell, cfg.sellRateUsd) && near(S.wallet, 50) && S.sellsToday === 1,
  "sell abate divida sem tocar a carteira");
await apply(S, { type: "sell", text: long(100), reason: "x" });
ok(S.sellsToday === 1, "sell recusa texto curto");
reset(S);
await apply(S, { type: "bounty", reason: "holder distribution teardown", text: long(320) });
ok(near(S.earned.bounty, cfg.bountyRateUsd) && near(S.wallet, 50) && S.bountiesToday === 1,
  "bounty abate divida sem tocar a carteira");
await apply(S, { type: "bounty", reason: "", text: long(320) });
ok(S.bountiesToday === 1, "bounty recusa sem `reason`");

console.log("\n5) rollDay reseta contadores e decai recentEarned em 0.75");
reset(S);
S.recentEarned.trade = 10;
S.rugchecksToday = 2;
rollDay();
ok(near(S.recentEarned.trade, 7.5), `recentEarned.trade 10 -> ${S.recentEarned.trade} (0.75x)`);
ok(S.rugchecksToday === 0, "rugchecksToday zerou na virada");

console.log("\n6) incomeMix: piso, concentracao e mix saudavel");
ok(incomeMix({ trade: 1, work: 0.5 }) === null, "abaixo do piso ($2) -> null");
const conc = incomeMix({ trade: 8, work: 1, sell: 1 });
ok(conc && conc.topName === "trade" && conc.share >= 0.6, `concentrado: top=trade share=${conc && conc.share.toFixed(2)} (>=0.6)`);
const spread = incomeMix({ trade: 3, work: 3, sell: 3 });
ok(spread && spread.share < 0.6, `diversificado: share=${spread && spread.share.toFixed(2)} (<0.6)`);

console.log(`\n${fails === 0 ? "TODOS VERDES" : fails + " FALHA(S)"}\n`);
process.exit(fails === 0 ? 0 : 1);
