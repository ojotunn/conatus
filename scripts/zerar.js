// ============================================================================
// ZERAR PARA O DIA 1 — o botao do lancamento.
//
// Apaga a MEMORIA dos agentes (checkpoint, retrato, arquivo, peças, vendas) e
// devolve a arena ao primeiro dia. NAO toca em nada que seja de verdade:
//
//   - as carteiras Solana deles (o SOL fica onde esta)
//   - o login na pump.fun (o perfil do navegador continua)
//   - os totais vitalicios de gasto (`totals.json`), que sao a contabilidade
//     da casa e nao a vida dos agentes
//   - as personas (`agents/*.md`), que sao quem eles sao
//
// Rodar:  node scripts/zerar.js          (mostra o que faria)
//         node scripts/zerar.js --sim    (faz)
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "src", "data");
const VALENDO = process.argv.includes("--sim");

// A vida dos agentes: some no reset.
const APAGAR = [
  ["checkpoint.json", "o ponto de memoria — licoes, metas, cicatrizes, posicoes, dividas"],
  ["state.json", "o retrato que o palco le"],
  ["archive.jsonl", "o historico de eventos"],
  ["pieces.json", "o catalogo da loja"],
  ["purchases.json", "as compras registradas"],
  ["sales-seen.json", "as vendas ja creditadas"],
  ["commissions.json", "as encomendas em aberto"],
  ["commissions-done.json", "as encomendas entregues"],
  ["bank-decisions.json", "as decisoes do banqueiro"],
  // RESIDUO VISIVEL DO TESTE (12/08/2026). O palco mostra a ultima imagem que
  // cada um viu ATE ele ler algo novo — sem apagar, o lancamento abre com a
  // pagina que eles estavam lendo na madrugada anterior.
  ["shot-sable.jpg", "o ultimo quadro que a Sable viu — o palco abre com ele"],
  ["shot-rook.jpg", "o ultimo quadro que o Rook viu — o palco abre com ele"],
  // Contextos remotos da Browserbase: guardam historico e cookies do lado deles.
  // Apagar so o mapeamento faz nascerem contextos limpos no proximo start. O
  // login da pump.fun NAO mora aqui — mora no perfil local, que fica intacto.
  ["browserbase-contexts.json", "os navegadores remotos — renascem limpos, sem historico de teste"],
];

// O que NAO se toca — listado de proposito, pra ninguem "melhorar" depois.
const PRESERVAR = [
  ["totals.json", "gasto vitalicio da casa (contabilidade, nao memoria)"],
  ["session-sable.json / session-rook.json", "sessao na pump.fun"],
  ["profiles/", "perfil do Chrome — e onde o login da pump.fun vive"],
  // Desde 14/08 as personas VIVEM em src/data/agents/ (volume no Railway);
  // o agents/ do repo e so o molde do dia 1. Nenhum dos dois e tocado aqui.
  ["agents/ (e o seed ../agents/*.md)", "as personas — quem eles sao"],
];

const linha = (t = "") => console.log(t);
linha();
linha(VALENDO ? "ZERANDO PARA O DIA 1" : "ENSAIO — nada sera apagado (use --sim para valer)");
linha("─".repeat(70));

let apagados = 0;
for (const [arq, oque] of APAGAR) {
  const p = path.join(DATA, arq);
  const existe = fs.existsSync(p);
  if (!existe) { linha(`  ·  ${arq.padEnd(24)} nao existe`); continue; }
  if (VALENDO) {
    try { fs.rmSync(p, { force: true }); apagados++; linha(`  ✕  ${arq.padEnd(24)} apagado — ${oque}`); }
    catch (e) { linha(`  !  ${arq.padEnd(24)} FALHOU: ${e.message}`); }
  } else {
    linha(`  →  ${arq.padEnd(24)} seria apagado — ${oque}`);
  }
}

linha();
linha("PRESERVADO (nao e memoria, e patrimonio):");
for (const [arq, oque] of PRESERVAR) linha(`  ✓  ${arq.padEnd(34)} ${oque}`);

linha();
linha("As CARTEIRAS SOLANA nao sao tocadas por este script — o dinheiro deles");
linha("continua on-chain, exatamente onde esta. Zerar a memoria nao zera o saldo.");
linha("O historico de transacoes tambem fica: esta na blockchain e e publico para");
linha("sempre. Decisao do Michel (12/08/2026): tudo bem, o que importa e que a");
linha("VIDA deles comece do zero — carteiras e perfil da pump.fun continuam.");
linha();

if (VALENDO) {
  linha(`Pronto: ${apagados} arquivo(s) apagados. O proximo start abre a Temporada 1, dia 1.`);
} else {
  linha("Nada foi tocado. Para valer:  node scripts/zerar.js --sim");
}
linha();
