// ============================================================================
// TESTE DO TRADE REAL — ida e volta de ~$1 na carteira da Sable.
//
// Sem argumento: ENSAIO. Monta a transacao, passa pela lista branca e SIMULA
// contra o RPC, mostrando quanto sairia da carteira. Nao assina, nao envia,
// nao gasta nada.
//
// Com `--live`: executa de verdade — compra ~$1, confere o token chegando, e
// VENDE de volta. A volta e a parte que importa: comprar o que nao se consegue
// vender e o unico erro irreversivel aqui.
//
//   node scripts/teste-trade-real.js            (ensaio)
//   node scripts/teste-trade-real.js --live     (vale dinheiro)
// ============================================================================

import "dotenv/config";
import * as market from "../src/lib/market.js";
import * as onchain from "../src/lib/wallet.js";
import { trade, inspectTx, checkWhitelist, simulateAndCheck } from "../src/lib/executor.js";

const LIVE = process.argv.includes("--live");
const USD = Number(process.env.TESTE_USD || 1);
const AGENT = { id: "sable", key: "SABLE_SOL_KEYPAIR", pub: process.env.SABLE_SOL_PUBKEY };

const line = (t = "") => console.log(t);
const hr = (t) => { line(); line("─".repeat(66)); line(t); line("─".repeat(66)); };
const sol = (n) => `${n.toFixed(6)} SOL`;

hr(LIVE ? "MODO LIVE — ISTO GASTA DINHEIRO DE VERDADE" : "ENSAIO — nada e assinado nem enviado");

// ---------------------------------------------------- 1. estado inicial
const mercados = await market.jupMarkets();
const solUsd = mercados.find((m) => m.coin === "SOL")?.mark ?? 0;
const antes = await onchain.getBalances(AGENT.pub);
line(`Carteira da Sable : ${AGENT.pub}`);
line(`Saldo             : ${sol(antes.sol)}  (SOL a $${solUsd.toFixed(2)} = $${(antes.sol * solUsd).toFixed(2)})`);
line(`Tamanho do teste  : $${USD.toFixed(2)} ≈ ${sol(USD / solUsd)}`);

// ------------------------------------------- 2. escolhe um token que passa
hr("ESCOLHENDO O TOKEN (tem que passar no raio-x do mint)");
// So token NA CURVA: o PumpPortal esta devolvendo Bad Request no caminho
// "pump-amm" (graduado) — verificado em 12/08/2026. A curva e a experiencia
// central da pump.fun de qualquer jeito; graduado fica pendente.
const recentes = await market.pumpRecent(30);
let alvo = null;
for (const t of recentes) {
  if (t.complete) continue;
  const ficha = await market.pumpCoin(t.mint).catch(() => null);
  if (!ficha) continue;
  const poolUsd = ficha.virtualSol * solUsd;
  if (poolUsd < 3000) continue; // pool com algum fundo
  if (USD / poolUsd > 0.02) continue; // ordem pequena perto da pool
  const raiox = await onchain.inspectMint(t.mint).catch(() => null);
  if (!raiox) continue;
  if (!raiox.ok) {
    line(`  reprovado ${(ficha.symbol || "?").padEnd(10)} — ${raiox.dangers[0]}`);
    continue;
  }
  alvo = { ...ficha, poolUsd, raiox };
  break;
}
if (!alvo) { line("Nenhum token passou agora. Tente de novo em alguns minutos."); process.exit(1); }

line(`  ESCOLHIDO: ${alvo.symbol} (${alvo.name})`);
line(`  mint      : ${alvo.mint}`);
line(`  estado    : ${alvo.complete ? "graduado (pump-amm)" : "na curva (pump)"}`);
line(`  market cap: $${Math.round(alvo.usdMarketCap).toLocaleString("en-US")}`);
line(`  pool      : $${Math.round(alvo.poolUsd).toLocaleString("en-US")}`);
line(`  raio-x    : LIMPO · ${alvo.raiox.isToken2022 ? "Token-2022" : "SPL"} · ext: ${alvo.raiox.extensions?.join(", ") || "nenhuma"}`);

// ---------------------------------------------------- 3. o ensaio
hr("ENSAIO DA COMPRA (montar → peneirar → simular)");
const amountSol = USD / solUsd;
const r = await fetch("https://pumpportal.fun/api/trade-local", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    publicKey: AGENT.pub, action: "buy", mint: alvo.mint,
    amount: Number(amountSol.toFixed(6)), denominatedInSol: "true",
    slippage: 10, priorityFee: 0.00001, pool: alvo.complete ? "pump-amm" : "pump",
  }),
});
if (!r.ok) { line(`PumpPortal recusou: ${await r.text()}`); process.exit(1); }
const tx = Buffer.from(await r.arrayBuffer());
line(`  transacao montada : ${tx.length} bytes`);

const info = inspectTx(tx);
line(`  assinaturas       : ${info.nSigs} (assinante: ${info.signer.slice(0, 12)}…)`);
line(`  programas tocados : ${[...new Set(info.programs)].map((p) => p.slice(0, 10)).join(", ")}`);
const wl = checkWhitelist(info, AGENT.pub);
line(`  lista branca      : ${wl.ok ? "PASSOU" : "RECUSOU — " + wl.reason}`);
if (!wl.ok) process.exit(1);

const sim = await simulateAndCheck(tx, { owner: AGENT.pub, maxSolSpend: amountSol * 1.2 });
line(`  simulacao         : ${sim.ok ? "PASSOU" : "RECUSOU — " + sim.reason}`);
if (sim.ok) line(`  sairia da carteira: ${sol(sim.spentSol)} (teto: ${sol(amountSol * 1.2 + 0.01)})`);
if (!sim.ok) process.exit(1);

if (!LIVE) {
  hr("ENSAIO OK — nada foi assinado nem enviado");
  line("Para valer dinheiro:  node scripts/teste-trade-real.js --live");
  process.exit(0);
}

// ---------------------------------------------------- 4. A COMPRA REAL
hr("COMPRANDO DE VERDADE");
const compra = await trade({
  owner: AGENT.pub, keypairEnvKey: AGENT.key, action: "buy", mint: alvo.mint,
  usd: USD, solUsd, graduated: alvo.complete, maxRealTradeUsd: Math.max(USD, 2),
});
if (!compra.ok) { line(`FALHOU: ${compra.reason}`); process.exit(1); }
line(`  assinatura : ${compra.signature}`);
line(`  status     : ${compra.status}`);
line(`  gastou     : ${sol(compra.spentSol)}`);
line(`  SOLSCAN    : ${compra.url}`);

// Confere o token chegando na carteira (a prova de que a compra foi real).
await new Promise((r) => setTimeout(r, 6000));
const rpc = async (m, p) => {
  const res = await fetch(process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }),
  });
  return (await res.json()).result;
};
const contas = await rpc("getTokenAccountsByOwner", [AGENT.pub, { mint: alvo.mint }, { encoding: "jsonParsed" }]);
const qtd = contas?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
line(`  token na carteira: ${qtd.toLocaleString("en-US")} ${alvo.symbol}  ${qtd > 0 ? "✓ CHEGOU" : "✗ NAO CHEGOU"}`);
if (!(qtd > 0)) { line("A compra nao entregou o token — PARANDO aqui para investigar."); process.exit(1); }

// ---------------------------------------------------- 5. A VENDA (a volta)
hr("VENDENDO DE VOLTA (a parte que prova que da pra sair)");
const venda = await trade({
  owner: AGENT.pub, keypairEnvKey: AGENT.key, action: "sell", mint: alvo.mint,
  usd: 0, solUsd, graduated: alvo.complete, maxRealTradeUsd: Math.max(USD, 2),
  sellPercent: "100%",
});
if (!venda.ok) { line(`A VENDA FALHOU: ${venda.reason}`); line("O token ficou na carteira — investigar antes de ligar pros agentes."); process.exit(1); }
line(`  assinatura : ${venda.signature}`);
line(`  status     : ${venda.status}`);
line(`  SOLSCAN    : ${venda.url}`);

// ---------------------------------------------------- 6. o balanco
await new Promise((r) => setTimeout(r, 6000));
const depois = await onchain.getBalances(AGENT.pub);
hr("BALANCO DA IDA E VOLTA");
line(`  SOL antes : ${sol(antes.sol)}`);
line(`  SOL depois: ${sol(depois.sol)}`);
const delta = depois.sol - antes.sol;
line(`  diferenca : ${delta >= 0 ? "+" : ""}${sol(delta)}  (= $${(delta * solUsd).toFixed(4)})`);
line(`  o custo da ida e volta e taxa (pump 1% + portal 0,5% + rede) e o spread.`);
line();
line("Se voce esta lendo isto, o caminho real funciona ponta a ponta.");
