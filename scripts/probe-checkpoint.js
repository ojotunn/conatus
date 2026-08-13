// ============================================================================
// O PONTO DE MEMORIA — prova que uma queda nao apaga a vida deles.
//
// Ate 12/08/2026 o motor gravava o estado e NUNCA o lia: todo restart era o
// primeiro dia de vida deles. Licoes, metas, cicatrizes, dividas e — pior — as
// POSICOES ABERTAS sumiam do registro enquanto o token continuava na carteira
// on-chain. O motor caiu duas vezes so naquele dia, e todo deploy reinicia o
// processo. Esta prova existe para que isso nao volte.
//
// Rodar: node scripts/probe-checkpoint.js
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Descartaveis ANTES de qualquer import dos modulos — nada toca o estado real.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "arena-ckpt-"));
process.env.CHECKPOINT_FILE = path.join(TMP, "checkpoint.json");
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.ARCHIVE_FILE = path.join(TMP, "archive.jsonl");
process.env.TOTALS_FILE = path.join(TMP, "totals.json");
process.env.PIECES_FILE = path.join(TMP, "pieces.json");

const { state, saveCheckpoint, loadCheckpoint, newAgent } = await import("../src/engine.js");

let fails = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  PASS  ${msg}`);
  else { console.log(`  FAIL  ${msg}`); fails++; }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ------------------------------------------------- 1. uma vida acontece
console.log("\n1) eles vivem: aprendem, declaram metas, devem, e abrem posicao");
const S = state.agents.sable;
const R = state.agents.rook;

state.day = 4;
state.season = 2;
state.tick = 137;
state.seq = 9;
state.treasury = 7.25;

S.lessons = [{ text: "thin pools eat the entry", day: 3 }];
S.goals = ["stop re-reading the same chart"];
S.scars = [{ day: 3, text: "took a real hit on ABC" }];
S.arrears = 1.75;
S.bankDebt = 12;
S.wallet = 38.4;
S.stats.trades = 6;
R.goals = ["understand one narrative before it is obvious"];
R.arrears = -4; // trabalhou mais do que devia: a casa deve a ele

state.positions.push({
  id: "pos9", agent: "sable", venue: "pump", market: "ABC123pump", side: "buy",
  sizeUsd: 5, entry: 1e6, openedTick: 130, feePaid: 0.05, unrealized: 0,
  real: { signature: "sigABC", spentSol: 0.066 },
});

saveCheckpoint();
ok(fs.existsSync(process.env.CHECKPOINT_FILE), "o checkpoint foi gravado em disco");

// ------------------------------------------------- 2. a queda
console.log("\n2) o motor cai e sobe do zero (deploy, 529, restart do Railway)");
// Zera exatamente como um processo novo faria.
state.day = 1; state.season = 1; state.tick = 0; state.seq = 0;
state.treasury = 12; state.positions = [];
state.agents.sable = newAgent("sable", "Sable", 10);
state.agents.rook = newAgent("rook", "Rook", 40);
ok(state.agents.sable.lessons.length === 0, "depois do restart, a memoria comeca vazia");
ok(state.positions.length === 0, "e sem posicoes");

// ------------------------------------------------- 3. o retorno
console.log("\n3) o ponto de memoria devolve a vida");
const r = loadCheckpoint();
ok(r !== null, "o checkpoint foi encontrado e lido");
ok(state.day === 4 && state.season === 2 && state.tick === 137, "dia, temporada e tick voltaram");
ok(state.seq === 9, "o contador de posicoes voltou (senao dois trades nasceriam com o mesmo id)");
ok(near(state.treasury, 7.25), "o tesouro voltou");

const S2 = state.agents.sable;
const R2 = state.agents.rook;
ok(S2.lessons.length === 1 && /thin pools/.test(S2.lessons[0].text), "as licoes voltaram");
ok(S2.goals.length === 1 && S2.scars.length === 1, "metas e cicatrizes voltaram");
ok(near(S2.arrears, 1.75) && near(S2.bankDebt, 12), "as dividas voltaram");
ok(near(S2.wallet, 38.4) && S2.stats.trades === 6, "carteira e historico voltaram");
ok(near(R2.arrears, -4), "credito com a casa (arrears negativo) tambem volta");

// A que mais importa: sem ela o token fica na carteira sem registro nenhum.
ok(state.positions.length === 1 && state.positions[0].id === "pos9",
  "A POSICAO ABERTA sobreviveu — nao ha token orfao");
ok(state.positions[0].real?.signature === "sigABC",
  "com a assinatura on-chain junto, entao da pra auditar e fechar");

// ------------------------------------------------- 4. deploy que muda o codigo
console.log("\n4) um deploy adiciona campo novo — o retrato antigo nao pode quebrar");
const antigo = JSON.parse(fs.readFileSync(process.env.CHECKPOINT_FILE, "utf8"));
delete antigo.agents.sable.goals;       // versao antiga nao tinha metas
delete antigo.counters;                  // nem contadores
antigo.campoQueNaoExisteMais = "lixo";   // e tinha coisa que sumiu
fs.writeFileSync(process.env.CHECKPOINT_FILE, JSON.stringify(antigo));

state.agents.sable = newAgent("sable", "Sable", 10);
const r2 = loadCheckpoint();
ok(r2 !== null, "retrato de versao antiga ainda carrega");
ok(Array.isArray(state.agents.sable.goals), "campo ausente fica com o padrao (nao vira undefined)");
ok(near(state.agents.sable.arrears, 1.75), "e o que existia no retrato continua vencendo");

// ------------------------------------------------- 5. sem checkpoint
console.log("\n5) primeira vez na vida: sem arquivo, comeca do zero sem estourar");
fs.rmSync(process.env.CHECKPOINT_FILE, { force: true });
ok(loadCheckpoint() === null, "sem arquivo devolve null (e o motor abre temporada nova)");

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fails === 0 ? "TODOS VERDES" : fails + " FALHA(S)"}\n`);
process.exitCode = fails === 0 ? 0 : 1;
setTimeout(() => process.exit(process.exitCode), 200).unref();
