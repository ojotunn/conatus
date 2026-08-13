// ============================================================================
// Teste OFFLINE do ALUGUEL FIXO (o piso da casa).
//
// O que ele prova:
//   1. A conta e lancada na ABERTURA do dia, como divida.
//   2. O lancamento e IDEMPOTENTE — restart no meio do dia nao cobra duas vezes.
//   3. Trabalhar abate a divida (e pode passar dela: a casa fica devendo).
//   4. O fechamento com piso ligado NAO cobra de novo — so faz o acerto.
//   5. Consumo de API nao entra na conta do agente com o piso ligado.
//   6. Com o piso em ZERO, o modelo antigo (cobranca por consumo) continua igual.
//   7. Despejo ainda acontece: dois dias devendo mais do que se tem.
//
// Sem rede, sem API, sem tocar em nenhum arquivo real.
// Rodar: node scripts/probe-rent.js
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "arena-rent-"));
// TODO arquivo que o motor escreve aponta pra um descartavel. O checkpoint
// entrou nesta lista porque a prova NAO pode encostar em dado real.
process.env.CHECKPOINT_FILE = path.join(TMP, "checkpoint.json");
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.ARCHIVE_FILE = path.join(TMP, "archive.jsonl");
process.env.TOTALS_FILE = path.join(TMP, "totals.json");
process.env.PIECES_FILE = path.join(TMP, "pieces.json");
process.env.BANK_DECISIONS_FILE = path.join(TMP, "bank-decisions.json");

// Config do teste: piso de $10/dia, multiplicador 1, dois inquilinos.
process.env.HOUSE_BASE_DAILY_USD = "10";
process.env.RENT_MULTIPLIER = "1";
process.env.RENT_ENABLED = "1";
process.env.WORK_RATE_USD = "2";
process.env.WORK_GIGS_PER_DAY = "0";

const { state, cfg, apply, postDailyBill, collectRent, rollDay } =
  await import("../src/engine.js");

// O `.env` do projeto vence process.env no readConfig, entao a prova crava a
// config na mao — ela testa a MECANICA, nao o valor que o Michel escolheu.
cfg.houseBaseDaily = 10;
cfg.rentMultiplier = 1;
cfg.rentEnabled = true;
cfg.workRateUsd = 2;
cfg.workGigsPerDay = 0;

let fails = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  PASS  ${msg}`);
  else { console.log(`  FAIL  ${msg}`); fails++; }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const sable = () => state.agents.sable;
const rook = () => state.agents.rook;

console.log("\n1. A conta e lancada na abertura do dia");
state.day = 1;
state.billPostedDay = 0;
sable().arrears = 0; rook().arrears = 0;
sable().spent.rent = 0; rook().spent.rent = 0;
postDailyBill();
ok(near(sable().arrears, 5), `Sable deve $5.00 (metade de $10) — deu ${sable().arrears}`);
ok(near(rook().arrears, 5), `Rook deve $5.00 — deu ${rook().arrears}`);
ok(near(sable().spent.rent, 5), "o aluguel vitalicio registrou os $5.00");

console.log("\n2. Lancar de novo no mesmo dia nao cobra duas vezes");
postDailyBill();
postDailyBill();
ok(near(sable().arrears, 5), `continua $5.00 depois de 3 chamadas — deu ${sable().arrears}`);

console.log("\n3. Trabalhar abate a divida");
sable().worksToday = 0;
await apply(sable(), { type: "work", text: "x".repeat(420), reason: "peca publicada" });
ok(near(sable().arrears, 3), `$5.00 - $2.00 de work = $3.00 — deu ${sable().arrears}`);
sable().worksToday = 0;
await apply(sable(), { type: "work", text: "y".repeat(420), reason: "outra peca" });
sable().worksToday = 0;
await apply(sable(), { type: "work", text: "z".repeat(420), reason: "mais uma" });
ok(near(sable().arrears, -1), `trabalhou alem do aluguel: divida -$1.00 (a casa deve) — deu ${sable().arrears}`);

console.log("\n4. O fechamento do dia NAO cobra de novo com o piso ligado");
const antesS = sable().arrears, antesR = rook().arrears;
sable().dayConsumed = 0.5; rook().dayConsumed = 0.5; // consumo de API do dia
sable().wallet = 40; rook().wallet = 40;
collectRent();
ok(near(sable().arrears, antesS), `Sable continua em ${antesS} apos o fechamento — deu ${sable().arrears}`);
ok(near(rook().arrears, antesR), `Rook continua em ${antesR} apos o fechamento — deu ${rook().arrears}`);

console.log("\n5. Consumo de API nao vira conta do agente (piso ligado)");
ok(near(rook().spent.rent, 5), `aluguel vitalicio do Rook segue $5.00, sem o $0.50 consumido — deu ${rook().spent.rent}`);

console.log("\n6. Virar o dia lanca a conta do dia seguinte, uma vez so");
const diaAntes = state.day;
rollDay();
ok(state.day === diaAntes + 1, "o dia virou");
ok(near(rook().arrears, antesR + 5), `Rook acumulou mais $5.00 no dia novo — deu ${rook().arrears}`);
ok(state.billPostedDay === state.day, "billPostedDay acompanha o dia corrente");

console.log("\n7. Despejo continua funcionando (dois dias devendo mais do que tem)");
rook().wallet = 1;        // tem $1
rook().arrears = 30;      // deve $30
rook().status = "solvent";
collectRent();
ok(rook().status === "arrears", `1o dia submerso: status arrears — deu ${rook().status}`);
collectRent();
ok(rook().status === "evicted", `2o dia submerso: despejado — deu ${rook().status}`);

console.log("\n8. Com o piso em ZERO, o modelo antigo volta inteiro");
cfg.houseBaseDaily = 0;
state.day = 9; state.billPostedDay = 0;
sable().arrears = 0; sable().spent.rent = 0; sable().status = "solvent"; sable().wallet = 40;
rook().arrears = 0; rook().spent.rent = 0; rook().status = "solvent"; rook().wallet = 40;
postDailyBill();
ok(near(sable().arrears, 0), "piso zero: nada e lancado na abertura");
sable().dayConsumed = 0.4; rook().dayConsumed = 0.6; // conta de $1.00 no total
collectRent();
ok(near(sable().arrears, 0.5), `piso zero: cobra o consumo dividido no meio ($0.50) — deu ${sable().arrears}`);
ok(near(rook().arrears, 0.5), "piso zero: o Rook paga a mesma metade, nao o que ele gastou");

fs.rmSync(TMP, { recursive: true, force: true });
console.log(fails === 0 ? "\nTUDO VERDE\n" : `\n${fails} FALHA(S)\n`);
process.exitCode = fails ? 1 : 0;
