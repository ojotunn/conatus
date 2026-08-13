// ============================================================================
// Teste OFFLINE da JORNADA — o teto de trabalho pago por dia.
//
// O que ele prova:
//   1. O teto e COMPARTILHADO entre os canais (nao adianta trocar de bounty
//      para sell para work — a jornada e uma so).
//   2. Estourada a jornada, a acao e RECUSADA e nao credita nada.
//   3. Entrega ralinha NAO queima hora (o gate de substancia vem antes) —
//      escrever mal nao pode custar o dia.
//   4. Virar o dia devolve a jornada inteira.
//   5. WORK_HOURS_PER_DAY=0 volta ao modelo antigo (sem jornada).
//   6. O excedente do dia continua virando reserva (arrears negativo) — o
//      pedido do Michel era que eles conseguissem POUPAR, so nao imprimir.
//
// Sem rede, sem API, sem tocar em arquivo real. Rodar: node scripts/probe-hours.js
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "arena-hours-"));
for (const k of ["CHECKPOINT_FILE", "STATE_FILE", "TOTALS_FILE", "PIECES_FILE", "BANK_DECISIONS_FILE"])
  process.env[k] = path.join(TMP, k.toLowerCase());
process.env.ARCHIVE_FILE = path.join(TMP, "archive.jsonl");

const { state, cfg, apply, rollDay } = await import("../src/engine.js");

// A prova crava a config: ela testa a MECANICA, nao o numero escolhido no .env.
cfg.workHoursPerDay = 3;
cfg.workRateUsd = 1;   cfg.workGigsPerDay = 0;
cfg.sellRateUsd = 6;   cfg.sellsPerDay = 0;
cfg.bountyRateUsd = 2; cfg.bountiesPerDay = 0;
cfg.rugcheckRateUsd = 6; cfg.rugchecksPerDay = 0;
cfg.rentEnabled = true; cfg.houseBaseDaily = 12;

let fails = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  PASS  ${msg}`);
  else { console.log(`  FAIL  ${msg}`); fails++; }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const S = () => state.agents.sable;
const longo = (n) => "x".repeat(n);
const zerar = () => { S().hoursToday = 0; S().arrears = 0; S().worksToday = 0; S().sellsToday = 0; S().bountiesToday = 0; S().rugchecksToday = 0; };

console.log("\n1. A jornada e COMPARTILHADA entre os canais");
zerar();
await apply(S(), { type: "work", text: longo(420), reason: "peca" });
ok(S().hoursToday === 1, `work gastou 1 hora — deu ${S().hoursToday}`);
await apply(S(), { type: "sell", text: longo(420), reason: "analise" });
ok(S().hoursToday === 2, `sell gastou a 2a — deu ${S().hoursToday}`);
await apply(S(), { type: "bounty", reason: "tarefa do mural", text: longo(320) });
ok(S().hoursToday === 3, `bounty gastou a 3a — deu ${S().hoursToday}`);
ok(near(S().arrears, -(1 + 6 + 2)), `abateu $9 de divida — deu ${S().arrears}`);

console.log("\n2. Estourada a jornada, recusa e nao credita");
const antes = S().arrears;
await apply(S(), { type: "rugcheck", market: "ABC123pump", text: longo(320) });
ok(S().hoursToday === 3, "a 4a tentativa nao adiciona hora");
ok(near(S().arrears, antes), `nao creditou nada — divida segue em ${S().arrears}`);
await apply(S(), { type: "bounty", reason: "outra tarefa", text: longo(320) });
ok(near(S().arrears, antes), "trocar de canal tambem nao burla a jornada");

console.log("\n3. Entrega ralinha NAO queima hora");
zerar();
await apply(S(), { type: "work", text: longo(50), reason: "curto demais" });
ok(S().hoursToday === 0, `texto ralo nao custou hora — deu ${S().hoursToday}`);
await apply(S(), { type: "bounty", reason: "x", text: longo(320) });
ok(S().hoursToday === 0, "bounty sem dizer qual tarefa tambem nao custa hora");

console.log("\n4. Virar o dia devolve a jornada");
S().hoursToday = 3;
rollDay();
ok(S().hoursToday === 0, `jornada zerada no dia novo — deu ${S().hoursToday}`);

console.log("\n5. Poupanca: o excedente vira reserva");
zerar();
S().arrears = 6; // aluguel do dia lancado de manha
await apply(S(), { type: "sell", text: longo(420), reason: "analise" });
ok(near(S().arrears, 0), `sell de $6 quitou o aluguel — deu ${S().arrears}`);
await apply(S(), { type: "sell", text: longo(420), reason: "outra" });
ok(near(S().arrears, -6), `a 2a virou reserva de $6 (arrears negativo) — deu ${S().arrears}`);
ok(S().hoursToday === 2, "e custou 2 das 3 horas");

console.log("\n6. WORK_HOURS_PER_DAY=0 volta ao modelo antigo");
cfg.workHoursPerDay = 0;
zerar();
for (let i = 0; i < 6; i++) await apply(S(), { type: "bounty", reason: `tarefa ${i}`, text: longo(320) });
ok(near(S().arrears, -12), `6 bounties sem jornada = -$12 — deu ${S().arrears}`);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(fails === 0 ? "\nTUDO VERDE\n" : `\n${fails} FALHA(S)\n`);
process.exitCode = fails ? 1 : 0;
