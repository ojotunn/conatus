// ============================================================================
// Teste OFFLINE da MEMORIA DA CONVERSA (13/08/2026).
//
// O que ele prova:
//   1. A fala entra no registro; fala vazia ou so espaco nao entra.
//   2. O registro poda pelo teto e mantem as MAIS RECENTES.
//   3. `push` nao muta a lista recebida (modulo puro de verdade).
//   4. Falar com a SALA nao apaga a fala dirigida ao colega — que era o defeito
//      do `lastSaid` unico, e o motivo de frases sumirem sem serem lidas.
//   5. O prompt ve a TROCA em ordem, mais recente por ultimo, com "You" para o
//      proprio agente e o nome do outro para o colega.
//   6. Sem conversa, nao entra cabecalho orfao no prompt.
//   7. O empurrao de resposta so aparece quando quem falou por ultimo foi o
//      OUTRO (nao se cutuca alguem por causa da propria fala).
//   8. O corte de tamanho e aplicado (linha longa nao estoura o turno).
//   9. Conversa de terceiros nao vaza para o par.
//
// Sem rede, sem API, sem tocar em arquivo. Rodar: node scripts/probe-dialogue.js
// ============================================================================

import { push, between, render, KEEP, SHOW } from "../src/lib/dialogue.js";

let fails = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  PASS  ${msg}`);
  else { console.log(`  FAIL  ${msg}`); fails++; }
};
const trim = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

console.log("\n1. A fala entra; vazia nao entra");
let d = push([], { from: "sable", to: "rook", text: "you are early again", tick: 1 });
ok(d.length === 1 && d[0].text === "you are early again", "fala normal entra");
ok(push(d, { from: "rook", to: "sable", text: "", tick: 2 }).length === 1, "string vazia nao entra");
ok(push(d, { from: "rook", to: "sable", text: "   ", tick: 2 }).length === 1, "so espaco nao entra");
ok(push(d, { from: "rook", to: "sable", text: null, tick: 2 }).length === 1, "null nao entra");
d = push(d, { from: "rook", to: "sable", text: "  espaco nas pontas  ", tick: 2 });
ok(d[1].text === "espaco nas pontas", "apara espaco das pontas");

console.log("\n2. Poda pelo teto, mantendo as mais recentes");
let cheio = [];
for (let i = 1; i <= KEEP + 5; i++) {
  cheio = push(cheio, { from: "sable", to: "rook", text: `linha ${i}`, tick: i });
}
ok(cheio.length === KEEP, `guarda no maximo ${KEEP} — guardou ${cheio.length}`);
ok(cheio[cheio.length - 1].text === `linha ${KEEP + 5}`, "a ultima e a mais recente");
ok(cheio[0].text === "linha 6", "as antigas caem primeiro (FIFO)");

console.log("\n3. push nao muta a lista recebida");
const original = [{ from: "sable", to: "rook", text: "a", tick: 1 }];
const copia = push(original, { from: "rook", to: "sable", text: "b", tick: 2 });
ok(original.length === 1, "lista original intacta");
ok(copia.length === 2, "a nova lista tem a fala nova");
ok(push(undefined, { from: "s", to: "r", text: "x", tick: 1 }).length === 1, "aceita lista indefinida");

console.log("\n4. A SALA nao apaga a fala para o colega (o defeito do lastSaid)");
let mix = [];
mix = push(mix, { from: "sable", to: "rook", text: "check this mint before you buy", tick: 1 });
mix = push(mix, { from: "sable", to: "room", text: "hey chat, we are looking at it", tick: 2 });
const paraRook = between(mix, "rook", "sable");
ok(paraRook.length === 1, "a fala a sala nao entra na conversa do par");
ok(paraRook[0].text === "check this mint before you buy",
   "a frase dirigida ao colega SOBREVIVEU a fala para a sala");
ok(mix.length === 2, "mas a fala a sala continua registrada");

console.log("\n5. O prompt ve a troca, em ordem, com os nomes certos");
let conversa = [];
conversa = push(conversa, { from: "rook", to: "sable", text: "primeira", tick: 1 });
conversa = push(conversa, { from: "sable", to: "rook", text: "segunda", tick: 2 });
conversa = push(conversa, { from: "rook", to: "sable", text: "terceira", tick: 3 });
const linhas = render(conversa, { agentId: "sable", foeId: "rook", foeName: "Rook", trim });
ok(linhas[0].startsWith("BETWEEN THE TWO OF YOU LATELY"), "cabecalho presente");
ok(linhas[1].includes('Rook: "primeira"'), "a mais antiga vem primeiro");
ok(linhas[2].includes('You: "segunda"'), "a propria fala aparece como You");
ok(linhas[3].includes('Rook: "terceira"'), "a mais recente vem por ultimo");
const doOutroLado = render(conversa, { agentId: "rook", foeId: "sable", foeName: "Sable", trim });
ok(doOutroLado[1].includes('You: "primeira"'), "do outro lado, os papeis invertem");
ok(doOutroLado[2].includes('Sable: "segunda"'), "e o nome do colega aparece certo");

console.log("\n6. Sem conversa, nada entra no prompt");
ok(render([], { agentId: "sable", foeId: "rook", foeName: "Rook", trim }).length === 0,
   "lista vazia nao gera cabecalho orfao");
ok(render(undefined, { agentId: "sable", foeId: "rook", foeName: "Rook", trim }).length === 0,
   "lista indefinida idem");
const soSala = push([], { from: "sable", to: "room", text: "oi plateia", tick: 1 });
ok(render(soSala, { agentId: "rook", foeId: "sable", foeName: "Sable", trim }).length === 0,
   "so fala para a sala tambem nao gera bloco");

console.log("\n7. O empurrao de resposta so vem quando o OUTRO falou por ultimo");
const ultimaDoOutro = render(conversa, { agentId: "sable", foeId: "rook", foeName: "Rook", trim });
ok(ultimaDoOutro[ultimaDoOutro.length - 1].includes("spoke last"),
   "Rook falou por ultimo: Sable e cutucada");
const ultimaMinha = render(conversa, { agentId: "rook", foeId: "sable", foeName: "Sable", trim });
ok(!ultimaMinha[ultimaMinha.length - 1].includes("spoke last"),
   "quem falou por ultimo nao e cutucado pela propria fala");

console.log("\n8. Corte de tamanho aplicado");
const longa = push([], { from: "rook", to: "sable", text: "x".repeat(500), tick: 1 });
const cortada = render(longa, { agentId: "sable", foeId: "rook", foeName: "Rook", trim });
ok(cortada[1].length < 300, `linha longa cortada — ficou com ${cortada[1].length} chars`);

console.log("\n9. So mostra o que se mostra, e so do par");
let muitas = [];
for (let i = 1; i <= 12; i++) {
  muitas = push(muitas, { from: i % 2 ? "sable" : "rook", to: i % 2 ? "rook" : "sable", text: `t${i}`, tick: i }, 50);
}
ok(between(muitas, "sable", "rook").length === SHOW, `mostra no maximo ${SHOW} trocas`);
const comTerceiro = push(muitas, { from: "outro", to: "terceiro", text: "nao e com voces", tick: 99 }, 50);
ok(!between(comTerceiro, "sable", "rook").some((x) => x.from === "outro"),
   "conversa de terceiros nao vaza para o par");

console.log(fails ? `\n${fails} FALHA(S)\n` : "\nTUDO VERDE\n");
process.exit(fails ? 1 : 0);
