// ============================================================================
// Teste do EXECUTOR REAL. NAO assina e NAO envia nada — exercita as defesas:
// leitura da transacao serializada, lista branca de programas, e a recusa
// quando a transacao nao e do agente. Usa transacao DE VERDADE montada pelo
// PumpPortal (rede so pra montar; nenhuma chave e tocada).
//
// Rodar: node scripts/probe-executor.js
// ============================================================================

import { inspectTx, checkWhitelist, _allowedPrograms } from "../src/lib/executor.js";
import { b58decode, b58encode } from "../src/lib/signer.js";

let fails = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  PASS  ${msg}`);
  else { console.log(`  FAIL  ${msg}`); fails++; }
};

const SABLE = "AHF8N7asQhTwh1MMiq46PvKguRp9XXWhPyzCxGvcasQa";

// O pool depende de o token ter GRADUADO ou nao — token na curva usa "pump",
// token migrado usa "pump-amm" (o executor decide pelo campo `complete`).
// Pega um vivo de cada tipo agora, pra testar os DOIS caminhos de verdade.
const market = await import("../src/lib/market.js");
let onCurve = null, graduated = null;
try {
  const rec = await market.pumpRecent(25);
  onCurve = rec.find((t) => !t.complete)?.mint ?? null;
  graduated = rec.find((t) => t.complete)?.mint ?? null;
} catch { /* sem rede */ }

// ------------------------------------------------- 1. lista branca
console.log("\n1) a lista branca");
const allow = _allowedPrograms();
ok(allow.includes("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"), "pump.fun esta na lista (dono da bonding curve)");
ok(allow.includes("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"), "pump-amm (graduado) esta na lista");
ok(allow.length <= 10, "lista curta — cada programa a mais e superficie de ataque");
// O que NAO pode entrar de jeito nenhum: qualquer coisa fora do conjunto.
for (const intruso of [
  "4MangoMjqJ2firMokCjjGgoK8d4MXcrgL7XJaL3w6fVg", // outro protocolo qualquer
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",  // ate o Jupiter: nao e daqui
]) ok(!allow.includes(intruso), `fora da lista: ${intruso.slice(0, 10)}…`);

// ------------------------------------------------- 2. transacoes reais
console.log("\n2) transacoes reais do PumpPortal: leitura + peneira");
async function build(mint, pool) {
  try {
    const r = await fetch("https://pumpportal.fun/api/trade-local", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publicKey: SABLE, action: "buy", mint, amount: 0.001,
        denominatedInSol: "true", slippage: 10, priorityFee: 0.00001, pool,
      }),
    });
    if (!r.ok) return null;
    const b = Buffer.from(await r.arrayBuffer());
    return b.length > 200 ? b : null;
  } catch { return null; }
}

for (const [nome, mint, pool] of [["curva", onCurve, "pump"], ["graduado", graduated, "pump-amm"]]) {
  if (!mint) { console.log(`  SKIP  sem token ${nome} disponivel agora`); continue; }
  const tx = await build(mint, pool);
  if (!tx) { console.log(`  SKIP  PumpPortal nao montou o caso ${nome}`); continue; }
  const info = inspectTx(tx);
  ok(info.nSigs === 1, `[${nome}] exige exatamente 1 assinatura`);
  ok(info.signer === SABLE, `[${nome}] o assinante e o proprio agente`);
  ok(checkWhitelist(info, SABLE).ok === true, `[${nome}] transacao legitima PASSA na peneira`);
  ok(checkWhitelist(info, "Cnfv1Y1FjMsmkobwGjBZgkZWGFsH7kAqgwSwx5D8jmXg").ok === false,
    `[${nome}] transacao de OUTRO assinante e recusada`);
  ok(tx.subarray(info.sigOffset, info.sigOffset + 64).every((b) => b === 0),
    `[${nome}] chega com o slot de assinatura ZERADO`);
  console.log(`        ${nome}: ${[...new Set(info.programs)].map((p) => p.slice(0, 8)).join(", ")}`);
}

// ------------------------------------------------- 3. transacao adulterada
console.log("\n3) transacao com programa fora da lista e RECUSADA");
{
  // Monta uma mensagem minima na mao: 1 assinatura, 1 instrucao, programa
  // desconhecido (um endereco qualquer que nao esta na lista branca).
  const fake = Buffer.from("F".repeat(64), "hex"); // 32 bytes de pubkey falsa
  const signerKey = b58decode(SABLE);
  const msg = Buffer.concat([
    Buffer.from([0x80]),          // v0
    Buffer.from([1, 0, 1]),       // header
    Buffer.from([2]),             // 2 contas estaticas
    Buffer.from(signerKey),       // [0] o agente
    fake,                         // [1] o "programa" desconhecido
    Buffer.alloc(32),             // blockhash
    Buffer.from([1]),             // 1 instrucao
    Buffer.from([1]),             // programIdIndex = 1 (o desconhecido)
    Buffer.from([0]),             // 0 contas
    Buffer.from([0]),             // 0 bytes de dado
    Buffer.from([0]),             // 0 lookups
  ]);
  const bad = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), msg]);
  const info = inspectTx(bad);
  const v = checkWhitelist(info, SABLE);
  ok(v.ok === false && /lista branca/.test(v.reason), "programa desconhecido recusado pela lista branca");
  ok(info.signer === SABLE, "mesmo assim leu o assinante certo");
}

// ------------------------------------------------- 4. transacao malformada
console.log("\n4) lixo nao passa por transacao");
{
  const casos = [
    [Buffer.from([0]), "zero assinaturas"],
    [Buffer.from([2, ...new Array(128).fill(0)]), "duas assinaturas (multisig)"],
    [Buffer.from([1, ...new Array(64).fill(0)]), "sem mensagem"],
  ];
  for (const [buf, nome] of casos) {
    let recusou = false;
    try { inspectTx(buf); } catch { recusou = true; }
    ok(recusou, `recusa: ${nome}`);
  }
}

// ------------------------------------------------- 5. raio-x do mint
console.log("\n5) raio-x do mint: julga por EXTENSAO, nao por programa");
{
  const { inspectMint } = await import("../src/lib/wallet.js");
  // Token-2022 de verdade da pump.fun (metadata benigna) TEM que passar —
  // a regra velha ("Token-2022 = recusa") bloquearia o mercado inteiro.
  if (onCurve) {
    const rep = await inspectMint(onCurve).catch(() => null);
    if (!rep) console.log("  SKIP  RPC indisponivel");
    else {
      ok(rep.dangers.length === 0 || rep.dangers.every((d) => typeof d === "string"),
        "devolve a lista de perigos legivel");
      console.log(`        ${onCurve.slice(0, 8)}… | 2022: ${rep.isToken2022} | ext: ${rep.extensions?.join(", ") || "nenhuma"} | ok: ${rep.ok}`);
      if (rep.isToken2022 && rep.extensions?.every((e) => /metadata/i.test(e)))
        ok(rep.ok === true, "Token-2022 so com metadata PASSA (nao e honeypot)");
    }
  }
  // USDC: SPL classico, sem freeze pra nos... na verdade USDC TEM freeze
  // authority (a Circle pode congelar) — entao tem que reprovar, e isso e
  // exatamente o risco que a regra velha nao via.
  const usdc = await inspectMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").catch(() => null);
  if (usdc) {
    ok(usdc.ok === false && usdc.dangers.some((d) => /freeze/.test(d)),
      "USDC reprova por freeze authority (risco que a regra antiga NAO pegava)");
  }
  // Mint que nao existe: reprova em vez de estourar.
  const fantasma = await inspectMint("11111111111111111111111111111112").catch(() => null);
  ok(fantasma && fantasma.ok === false, "mint inexistente reprova (nao compro o que nao auditei)");
}

console.log(`\n${fails === 0 ? "TODOS VERDES" : fails + " FALHA(S)"}\n`);
process.exit(fails === 0 ? 0 : 1);
