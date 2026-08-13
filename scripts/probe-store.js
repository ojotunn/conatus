// ============================================================================
// Teste OFFLINE da loja x402. Sem rede*, sem arena, sem tocar nos arquivos
// reais (pieces/purchases apontam pra descartaveis via env; o unico efeito
// colateral: nenhum — o state.json real tem override proprio desde 12/08/2026).
//
// (*) o unico caminho que tocaria rede — verifyPayment — e testado pela funcao
// pura _evalTransfer com fixtures, e no fluxo HTTP com assinatura invalida,
// que e rejeitada ANTES de qualquer chamada de RPC.
// Rodar: node scripts/probe-store.js
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Descartaveis ANTES de qualquer import dos modulos.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "arena-store-"));
process.env.PIECES_FILE = path.join(TMP, "pieces.json");
process.env.CHECKPOINT_FILE = path.join(TMP, "checkpoint.json");
process.env.STATE_FILE = path.join(TMP, "state.json");
process.env.ARCHIVE_FILE = path.join(TMP, "archive.jsonl");
process.env.TOTALS_FILE = path.join(TMP, "totals.json");
process.env.PURCHASES_FILE = path.join(TMP, "purchases.json");
process.env.COMMISSIONS_FILE = path.join(TMP, "commissions.json");
process.env.COMMISSIONS_DONE_FILE = path.join(TMP, "commissions-done.json");
process.env.PORT = "8462"; // nao colidir com o painel real

const pieces = await import("../src/lib/pieces.js");
const { _evalTransfer, USDC_MINT } = await import("../src/lib/wallet.js");

let fails = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  PASS  ${msg}`);
  else { console.log(`  FAIL  ${msg}`); fails++; }
};

// ------------------------------------------------------------- 1. catalogo
console.log("\n1) pieces: add / listPublic / getFull");
const longText = "x".repeat(500);
const id1 = pieces.add({ agent: "sable", kind: "rugcheck", title: "Rug-check: ABC", text: longText, priceUsd: 3 });
const pub = pieces.listPublic();
ok(pub.length === 1 && pub[0].id === id1, "peca listada");
ok(!("text" in pub[0]), "listPublic NAO expoe o texto");
ok(pub[0].preview.length <= 181 && pub[0].preview.endsWith("…"), "preview curto com reticencias");
ok(pieces.getFull(id1)?.text === longText, "getFull entrega o texto inteiro");

// ------------------------------------------------------- 2. _evalTransfer
console.log("\n2) _evalTransfer: fixtures de getTransaction");
const PAYTO = "AHF8N7asQhTwh1MMiq46PvKguRp9XXWhPyzCxGvcasQa";
const now = Date.now();
const bt = Math.floor(now / 1000) - 60; // 1 min atras
const usdcTx = (amount) => ({
  blockTime: bt, meta: {
    err: null,
    preTokenBalances: [{ mint: USDC_MINT, owner: PAYTO, uiTokenAmount: { uiAmount: 0 } }],
    postTokenBalances: [{ mint: USDC_MINT, owner: PAYTO, uiTokenAmount: { uiAmount: amount } }],
  }, transaction: { message: { accountKeys: [] } },
});
ok(_evalTransfer(usdcTx(3), { payTo: PAYTO, minUsd: 3, solUsd: 150, now }).ok === true, "USDC exato passa");
ok(_evalTransfer(usdcTx(1), { payTo: PAYTO, minUsd: 3, solUsd: 150, now }).ok === false, "USDC insuficiente falha");

const solTx = {
  blockTime: bt, meta: {
    err: null,
    preBalances: [5e9, 1e9], postBalances: [4.97e9, 1e9 + 0.0205e9],
    preTokenBalances: [], postTokenBalances: [],
  },
  transaction: { message: { accountKeys: ["buyerAddr111", PAYTO] } },
};
// 0.0205 SOL * $150 = $3.075 >= $3*0.98
ok(_evalTransfer(solTx, { payTo: PAYTO, minUsd: 3, solUsd: 150, now }).method === "sol", "SOL com tolerancia passa");
ok(_evalTransfer(solTx, { payTo: "outroEndereco", minUsd: 3, solUsd: 150, now }).ok === false, "destinatario errado falha");
const oldTx = { ...usdcTx(3), blockTime: Math.floor(now / 1000) - 25 * 3600 };
ok(_evalTransfer(oldTx, { payTo: PAYTO, minUsd: 3, solUsd: 150, now }).reason === "transaction too old", "tx de 25h atras falha");
ok(_evalTransfer({ ...usdcTx(3), meta: { ...usdcTx(3).meta, err: { code: 1 } } }, { payTo: PAYTO, minUsd: 3, solUsd: 150, now }).ok === false, "tx que falhou on-chain falha");
ok(_evalTransfer(null, { payTo: PAYTO, minUsd: 3, solUsd: 150, now }).ok === false, "tx inexistente falha");

// ------------------------------------------------- 3. leak fix no publish()
console.log("\n3) feed publico so com preview de peca paga");
const engine = await import("../src/engine.js");
engine.state.feed.push({ n: 9001, t: now, tick: 1, kind: "sell", agent: "sable", text: longText, paid: 1 });
engine.state.feed.push({ n: 9002, t: now, tick: 1, kind: "work", agent: "sable", text: longText, paid: 2 });
engine.publish();
// Le o snapshot DESCARTAVEL: desde 12/08/2026 o engine respeita STATE_FILE,
// entao a prova nao toca (nem depende) do estado real da arena.
const snap = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8"));
const fSell = snap.feed.find((e) => e.n === 9001);
const fWork = snap.feed.find((e) => e.n === 9002);
ok(fSell && fSell.text.length <= 181 && fSell.paywalled === true, "sell sai truncado + paywalled");
ok(fWork && fWork.text.length === 500, "work (gratuito) sai inteiro");
ok(engine.state.feed.find((e) => e.n === 9001).text.length === 500, "o feed INTERNO mantem o texto (so o snapshot corta)");

// ------------------------------------------------------- 4. rotas da loja
console.log("\n4) HTTP: list / buy 402 / claim dedup");
await import("../src/server.js"); // sobe em PORT=8462
await new Promise((r) => setTimeout(r, 300));
const base = "http://127.0.0.1:8462";

const list = await (await fetch(`${base}/api/store/list`)).json();
ok(list.pieces?.length === 1 && !("text" in list.pieces[0]), "/api/store/list: 1 peca, sem texto");

const buyRes = await fetch(`${base}/api/store/buy?id=${id1}`);
const buy = await buyRes.json();
ok(buyRes.status === 402, "/api/store/buy devolve HTTP 402");
ok(buy.payTo === PAYTO, "payTo = carteira publica da Sable");
ok(buy.accepts?.usdc?.amount === 3 && buy.accepts.usdc.mint === USDC_MINT, "aceita USDC no preco da peca");

const bad = await fetch(`${base}/api/store/claim?id=${id1}&tx=abc`);
ok(bad.status === 402 && (await bad.json()).error.includes("signature"), "assinatura invalida rejeitada sem RPC");

// dedup: semeia uma compra existente com txSig T para id1
const T = "5".repeat(88);
fs.writeFileSync(process.env.PURCHASES_FILE, JSON.stringify({
  purchases: [{ txSig: T, pieceId: id1, agent: "sable", title: "Rug-check: ABC", paidUsd: 3, method: "usdc", at: now }],
}, null, 2));
const re = await fetch(`${base}/api/store/claim?id=${id1}&tx=${T}`);
const reJ = await re.json();
ok(re.status === 200 && reJ.alreadyClaimed === true && reJ.piece.text === longText, "re-claim da MESMA peca e idempotente");
const id2 = pieces.add({ agent: "rook", kind: "sell", title: "Other", text: longText, priceUsd: 1 });
const cross = await fetch(`${base}/api/store/claim?id=${id2}&tx=${T}`);
ok(cross.status === 409, "mesma tx pra OUTRA peca e recusada (409)");

// ------------------------------------------------- 5. ENCOMENDAS (comissoes)
console.log("\n5) encomendas: info / validacao / status / unlock");
const MINT = "So11111111111111111111111111111111111111112"; // wSOL, base58 valido

const info = await (await fetch(`${base}/api/store/commission-info?agent=sable&kind=rugcheck`)).json();
ok(info.payTo === PAYTO && info.priceUsd > 0, "commission-info: payTo + preco");

// mint invalido no rug-check -> 400 antes de qualquer pagamento
const badBrief = await fetch(`${base}/api/store/commission`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ agent: "sable", kind: "rugcheck", brief: "nope", txSig: "5".repeat(88) }),
});
ok(badBrief.status === 400, "rug-check sem mint valido recusado (400)");

// assinatura invalida -> 402 "signature", sem tocar RPC
const badSig = await fetch(`${base}/api/store/commission`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ agent: "sable", kind: "rugcheck", brief: MINT, txSig: "abc" }),
});
ok(badSig.status === 402 && (await badSig.json()).error.includes("signature"), "assinatura invalida recusada sem RPC");

// semeia encomenda paga (T2) + peca entregue apontando pra ela -> unlock direto
const T2 = "7".repeat(88);
const cmId = "cm-test1";
fs.writeFileSync(process.env.COMMISSIONS_FILE, JSON.stringify({
  commissions: [{ id: cmId, agent: "sable", kind: "rugcheck", brief: MINT, txSig: T2, paidUsd: 5, method: "usdc", at: now }],
}, null, 2));
const cmPieceId = pieces.add({ agent: "sable", kind: "rugcheck", title: `Rug-check: ${MINT}`, text: longText, priceUsd: 5, commissionId: cmId });

// status: pendente ate o engine marcar como entregue
const stPend = await (await fetch(`${base}/api/store/commission-status?tx=${T2}`)).json();
ok(stPend.status === "pending", "status = pending antes da entrega");

// o comprador desbloqueia com a assinatura do pagamento adiantado, sem RPC
const cmClaim = await fetch(`${base}/api/store/claim?id=${cmPieceId}&tx=${T2}`);
const cmClaimJ = await cmClaim.json();
ok(cmClaim.status === 200 && cmClaimJ.commissioned === true && cmClaimJ.piece.text === longText,
  "peca encomendada desbloqueia com a tx do pagamento (sem RPC)");

// assinatura errada NAO desbloqueia a peca encomendada
const cmWrong = await fetch(`${base}/api/store/claim?id=${cmPieceId}&tx=${"8".repeat(88)}`);
ok(cmWrong.status === 402, "peca encomendada com tx errada nao abre");

// entrega marcada -> status vira delivered com a peca
fs.writeFileSync(process.env.COMMISSIONS_DONE_FILE, JSON.stringify({
  done: [{ commissionId: cmId, pieceId: cmPieceId, at: now }],
}, null, 2));
const stDone = await (await fetch(`${base}/api/store/commission-status?tx=${T2}`)).json();
ok(stDone.status === "delivered" && stDone.piece?.text === longText, "status = delivered depois da entrega");

// ------------------------------------------------------- 6. API x402 (maquinas)
console.log("\n6) API x402: doc / catalog / piece 402 -> entrega");
const doc = await (await fetch(`${base}/api/x402`)).json();
ok(Array.isArray(doc.how) && doc.currency?.usdcMint === USDC_MINT, "/api/x402 documenta o fluxo");

const cat = await (await fetch(`${base}/api/x402/catalog`)).json();
ok(cat.items?.length >= 1 && cat.items[0].payTo && cat.items[0].accepts?.usdc, "catalog: itens com payTo + accepts");
ok(!("text" in cat.items[0]), "catalog NAO expoe o texto");

const p402 = await fetch(`${base}/api/x402/piece/${id1}`);
ok(p402.status === 402 && (await p402.json()).payTo === PAYTO, "piece sem tx devolve 402 + payTo");

const pBadSig = await fetch(`${base}/api/x402/piece/${id1}?tx=abc`);
ok(pBadSig.status === 402, "piece com assinatura invalida continua 402 (sem RPC)");

// header x-payment-signature reaproveita compra ja registrada (T, id1) -> idempotente
const pHeader = await fetch(`${base}/api/x402/piece/${id1}`, { headers: { "x-payment-signature": T } });
const pHeaderJ = await pHeader.json();
ok(pHeader.status === 200 && pHeaderJ.piece?.text === longText, "piece entrega via header de compra ja verificada");

console.log(`\n${fails === 0 ? "TODOS VERDES" : fails + " FALHA(S)"}\n`);
process.exit(fails === 0 ? 0 : 1);
