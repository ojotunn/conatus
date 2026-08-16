// ============================================================================
// Teste OFFLINE da recarga de treasury. Zero rede, zero API.
//
// O mecanismo (15/08/2026, nascido com o show parado sem porta pra dinheiro):
// o server escreve treasury-topups.json, o motor aplica via
// processTreasuryTopups() e lembra os ids em state.topupsSeen (checkpoint).
// Este probe prova: credito aplicado, idempotencia (segunda passada nao
// credita de novo), entrada invalida ignorada sem travar as validas, e o
// formato exato que a rota /api/treasury grava.
// Rodar: node scripts/probe-topup.js
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "arena-topup-"));
process.env.TREASURY_TOPUPS_FILE = path.join(TMP, "treasury-topups.json");
process.env.PIECES_FILE = path.join(TMP, "pieces.json");
process.env.CHECKPOINT_FILE = path.join(TMP, "checkpoint.json");
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.ARCHIVE_FILE = path.join(TMP, "archive.jsonl");
process.env.TOTALS_FILE = path.join(TMP, "totals.json");

const { state, processTreasuryTopups } = await import("../src/engine.js");

let fails = 0;
const ok = (cond, msg) => {
  if (cond) { console.log(`  PASS  ${msg}`); }
  else { console.log(`  FAIL  ${msg}`); fails++; }
};
const near = (a, b) => Math.abs(a - b) < 1e-9;

// 1. Sem arquivo nenhum: nao explode, nao muda nada.
state.treasury = 0.5;
processTreasuryTopups();
ok(near(state.treasury, 0.5), "sem arquivo de recargas, treasury fica como esta");

// 2. Uma recarga valida credita e fica lembrada.
const file = process.env.TREASURY_TOPUPS_FILE;
fs.writeFileSync(file, JSON.stringify({ topups: [
  { id: "t1", usd: 40, note: "recarga do Michel", at: 1 },
] }));
processTreasuryTopups();
ok(near(state.treasury, 40.5), "recarga de $40 creditada na treasury");
ok(state.topupsSeen.includes("t1"), "id da recarga lembrado no estado");

// 3. Idempotencia: a MESMA recarga nunca credita duas vezes.
processTreasuryTopups();
ok(near(state.treasury, 40.5), "segunda passada nao credita de novo");

// 4. Entrada invalida e ignorada sem bloquear as validas do mesmo arquivo.
fs.writeFileSync(file, JSON.stringify({ topups: [
  { id: "t1", usd: 40, note: "ja aplicada", at: 1 },
  { id: "t2", usd: -5, note: "negativa — ignora", at: 2 },
  { id: "t3", usd: "abc", note: "nao-numero — ignora", at: 3 },
  { id: "t4", usd: 10, note: "valida", at: 4 },
] }));
processTreasuryTopups();
ok(near(state.treasury, 50.5), "so a recarga valida nova ($10) entrou");
ok(state.topupsSeen.includes("t2") && state.topupsSeen.includes("t3"),
  "invalidas tambem ficam lembradas — nao voltam a cada ciclo");

// 5. Formato da rota: e o que o server grava, entao o probe le como o motor.
const doServidor = { topups: [{ id: `t${1755000000000}-abc123`, usd: 25, note: "", at: 1755000000000 }] };
fs.writeFileSync(file, JSON.stringify(doServidor, null, 2));
processTreasuryTopups();
ok(near(state.treasury, 75.5), "formato gravado pela rota /api/treasury e aceito");

console.log();
console.log(fails === 0 ? "probe-topup: tudo verde" : `probe-topup: ${fails} FALHA(S)`);
process.exit(fails === 0 ? 0 : 1);
