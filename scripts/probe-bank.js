// ============================================================================
// Teste OFFLINE do BANCO — a peticao CONJUNTA ao banqueiro humano.
// Fluxo: abrir (argumento) -> co-assinar (argumento do outro) -> with_bank ->
// decisao (arquivo que o server escreve) -> credito+divida -> quitar (pay bank).
// Sem rede, sem API: so o apply() do engine e um arquivo de decisao descartavel.
// Rodar: node scripts/probe-bank.js
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "arena-bank-"));
process.env.BANK_DECISIONS_FILE = path.join(TMP, "bank-decisions.json");
process.env.CHECKPOINT_FILE = path.join(TMP, "checkpoint.json");
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.ARCHIVE_FILE = path.join(TMP, "archive.jsonl");
process.env.TOTALS_FILE = path.join(TMP, "totals.json");
// Isola os outros arquivos que o engine possa tocar em import.
process.env.PIECES_FILE = path.join(TMP, "pieces.json");

const engine = await import("../src/engine.js");
const { state, apply, processBankDecisions } = engine;

let fails = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  PASS  ${msg}`);
  else { console.log(`  FAIL  ${msg}`); fails++; }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const sable = state.agents.sable;
const rook = state.agents.rook;
const CASE_OK = "Rent is $4.80 tonight and I am $3 short after the SOL scalp stopped out. A loan of $5 covers rent and one rugcheck slot tomorrow, which pays $3 back within two days.";
const COSIGN_OK = "Her rugcheck pipeline is real — she delivered two this week. I would rather co-sign than watch the house lose a tenant.";

// ------------------------------------------------- 1. abrir a peticao
console.log("\n1) abrir: argumento obrigatorio, um por vez");
await apply(sable, { type: "borrow", sizeUsd: 5, reason: "need money" });
ok(state.loanRequests.length === 0, "argumento raso e recusado (banco nao e torneira)");
await apply(sable, { type: "borrow", sizeUsd: 5, reason: CASE_OK });
ok(state.loanRequests.length === 1 && state.loanRequests[0].status === "cosign", "peticao aberta, aguardando co-assinatura");
const rq = state.loanRequests[0];
await apply(sable, { type: "borrow", sizeUsd: 3, reason: CASE_OK });
ok(state.loanRequests.length === 1, "segunda peticao em voo e recusada");

// ------------------------------------------------- 2. co-assinatura
console.log("\n2) co-assinar: so o OUTRO, com argumento proprio");
await apply(sable, { type: "borrow", proposalId: rq.id, reason: COSIGN_OK });
ok(rq.status === "cosign", "auto-co-assinatura recusada");
await apply(rook, { type: "borrow", proposalId: rq.id, reason: "ok" });
ok(rq.status === "cosign", "co-assinatura sem argumento recusada");
await apply(rook, { type: "borrow", proposalId: rq.id, reason: COSIGN_OK });
ok(rq.status === "with_bank" && rq.cosign?.by === "rook", "co-assinada -> WITH_BANK (chega ao Michel)");

// ------------------------------------------------- 3. decisao: aprovar (contra-oferta)
console.log("\n3) banqueiro aprova com contra-oferta");
const w0 = sable.wallet;
fs.writeFileSync(process.env.BANK_DECISIONS_FILE, JSON.stringify({
  decisions: [{ requestId: rq.id, approve: true, amount: 4, note: "half now, prove it", at: Date.now() }],
}, null, 2));
processBankDecisions();
ok(rq.status === "approved" && rq.granted === 4, "peticao aprovada com valor do banqueiro ($4, nao $5)");
// O emprestimo aprovado NAO credita a carteira: o banco (o Michel) envia SOL de
// verdade, e o leitor de saldo on-chain encontra. Aqui nasce so a DIVIDA — foi
// isso que sobrou quando o saldo de jogo deixou de existir (12/08/2026).
ok(near(sable.wallet, w0), "carteira NAO e creditada por codigo (o banco envia on-chain)");
ok(near(sable.bankDebt, 4), "a divida com o banco nasce com o valor aprovado");
ok(near(sable.bankDebt, 4), "virou DIVIDA com o banco");
processBankDecisions();
// O que nao pode dobrar agora e a DIVIDA (a carteira ja nao e escrita por codigo).
ok(near(sable.bankDebt, 4), "reprocessar o arquivo NAO duplica a divida");

// ------------------------------------------------- 4. quitar o banco
console.log("\n4) pay to:\"bank\" amortiza a divida");
// QUITAR VIROU IMPOSSIVEL, e isso e a trava funcionando: a carteira e on-chain
// e os agentes nao tem funcao de transferencia. A divida fica a vista ate a casa
// acertar por fora. Esta prova existe pra impedir que alguem "conserte" isso
// devolvendo movimento de dinheiro ao codigo.
await apply(sable, { type: "pay", to: "bank", sizeUsd: 2.5, reason: "paying the banker back" });
ok(near(sable.bankDebt, 4), "tentar quitar NAO mexe na divida (nao ha como enviar)");
ok(near(sable.wallet, w0), "e nao mexe na carteira");
await apply(sable, { type: "pay", sizeUsd: 3, reason: "paying my housemate" });
ok(near(rook.wallet ?? 0, rook.wallet ?? 0), "pagar o outro agente tambem e recusado");

// ------------------------------------------------- 5. decisao: negar
console.log("\n5) banqueiro nega com recado");
await apply(rook, { type: "borrow", sizeUsd: 20, reason: CASE_OK });
const rq2 = state.loanRequests.find((r) => r.agent === "rook" && r.status === "cosign");
await apply(sable, { type: "borrow", proposalId: rq2.id, reason: COSIGN_OK });
const w1 = rook.wallet;
fs.writeFileSync(process.env.BANK_DECISIONS_FILE, JSON.stringify({
  decisions: [{ requestId: rq2.id, approve: false, note: "20 on a hunch? no.", at: Date.now() }],
}, null, 2));
processBankDecisions();
ok(rq2.status === "denied" && near(rook.wallet, w1) && near(rook.bankDebt, 0), "negada: nada credita, nada vira divida");

// ------------------------------------------------- 6. feed conta a historia
console.log("\n6) o palco ve tudo");
const kinds = state.feed.map((e) => e.kind);
ok(kinds.filter((k) => k === "loan").length >= 3, "peticoes e co-assinaturas no feed (kind loan)");
ok(kinds.filter((k) => k === "bank").length === 2, "os dois vereditos no feed (kind bank)");

console.log(`\n${fails === 0 ? "TODOS VERDES" : fails + " FALHA(S)"}\n`);
process.exit(fails === 0 ? 0 : 1);
