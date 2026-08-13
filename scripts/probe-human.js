// ============================================================================
// Teste OFFLINE do pacote "mais humanos": metas (aspire), cicatrizes (scars) e
// a fiacao do interior. Sonho e aside dependem de chamada de API (testados ao
// vivo); aqui vai tudo que e deterministico. Rodar: node scripts/probe-human.js
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "arena-human-"));
process.env.BANK_DECISIONS_FILE = path.join(TMP, "bank-decisions.json");
process.env.CHECKPOINT_FILE = path.join(TMP, "checkpoint.json");
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.ARCHIVE_FILE = path.join(TMP, "archive.jsonl");
process.env.TOTALS_FILE = path.join(TMP, "totals.json");
process.env.PIECES_FILE = path.join(TMP, "pieces.json");

const { state, apply, processBankDecisions } = await import("../src/engine.js");

let fails = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  PASS  ${msg}`);
  else { console.log(`  FAIL  ${msg}`); fails++; }
};

const sable = state.agents.sable, rook = state.agents.rook;

// ------------------------------------------------- 1. aspire (metas)
console.log("\n1) aspire: o horizonte alem do aluguel");
await apply(sable, { type: "aspire", text: "win" });
ok(sable.goals.length === 0, "meta rasa (<10 chars) recusada");
await apply(sable, { type: "aspire", text: "build a $200 reserve before month end\nclear my name with the bank\nbecome the rugcheck desk people trust\na fourth goal that should be cut\n" });
ok(sable.goals.length === 3, "maximo 3 metas (a quarta cai)");
ok(sable.goals[0].includes("$200 reserve"), "meta 1 registrada");
await apply(sable, { type: "aspire", text: "one single new direction that replaces everything" });
ok(sable.goals.length === 1 && sable.goals[0].includes("single new direction"), "aspire novo SUBSTITUI a lista (mudar de meta e informacao)");
ok(state.feed.some((e) => e.kind === "aspire" && e.agent === "sable"), "evento aspire no feed (o palco ve)");

// ------------------------------------------------- 2. cicatriz: banco nega
console.log("\n2) scars: a negativa do banco deixa marca");
await apply(rook, { type: "borrow", sizeUsd: 30, reason: "Rent is due and the SOL long is underwater; 30 covers three nights while I rebuild the desk pipeline that paid twice last week." });
const rq = state.loanRequests.find((r) => r.agent === "rook");
await apply(sable, { type: "borrow", proposalId: rq.id, reason: "He is good for it when the desk runs - I have watched him deliver under pressure twice." });
fs.writeFileSync(process.env.BANK_DECISIONS_FILE, JSON.stringify({ decisions: [
  { requestId: rq.id, approve: false, note: "thirty on an underwater long? no.", at: Date.now() },
]}, null, 2));
processBankDecisions();
ok(rook.scars.some((s) => s.text === "the bank said no"), "cicatriz 'the bank said no' no requerente");
ok(!sable.scars.some((s) => s.text === "the bank said no"), "co-assinante NAO ganha a cicatriz");

// ------------------------------------------------- 3. cicatriz: tombo e vitoria
console.log("\n3) scars: tombo grande e vitoria grande marcam");
// `wallet` agora vem do saldo on-chain (nao ha mais semente de jogo), entao a
// prova precisa dizer quanto ha na carteira antes de medir 15%/25% dela.
rook.wallet = 50; sable.wallet = 50;
const MINT = "Ge87EtsjwRQbHaqQmKRno69RFTwh9bfSsm99XNxTpump";
// Perda acima de 15% da carteira deixa marca (a vista, sem liquidacao).
state.positions.push({ id: "posX", agent: "rook", venue: "pump", market: MINT, side: "buy",
  sizeUsd: 10, entry: 1e6, openedTick: state.tick, feePaid: 0, unrealized: -0.4 * rook.wallet });
await apply(rook, { type: "close", positionId: "posX", reason: "cut it" });
ok(rook.scars.some((s) => s.text.includes("took a real hit")), "cicatriz de tombo grande");
const w = sable.wallet;
state.positions.push({ id: "posY", agent: "sable", venue: "pump", market: MINT, side: "buy",
  sizeUsd: 8, entry: 1e6, openedTick: state.tick, feePaid: 0, unrealized: 0.5 * w });
await apply(sable, { type: "close", positionId: "posY", reason: "take profit" });
ok(sable.scars.some((s) => s.text.includes("win")), "vitoria grande tambem marca (brilha)");

// ------------------------------------------------- 4. cicatrizes envelhecem
console.log("\n4) scars: somem sozinhas (max 4, fade por dia)");
for (let i = 0; i < 6; i++) rook.scars.push({ day: state.day, text: `extra ${i}` });
rook.scars = rook.scars.slice(-4);
ok(rook.scars.length === 4, "teto de 4 cicatrizes");
const antigas = rook.scars.map((s) => ({ ...s, day: state.day - 3 }));
ok(antigas.filter((s) => state.day - s.day <= 2).length === 0, "cicatriz de 3 dias atras nao entra no prompt (fade)");

console.log(`\n${fails === 0 ? "TODOS VERDES" : fails + " FALHA(S)"}\n`);
process.exit(fails === 0 ? 0 : 1);
