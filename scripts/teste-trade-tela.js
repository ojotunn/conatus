// ============================================================================
// TESTE DO TRADE NA TELA — sem LLM, sem engine, sem queimar credito.
//
// Dirige o caminho novo direto: arma o portao, abre a pagina da moeda na
// pump.fun, conecta a carteira, digita o valor e clica em comprar. E o mesmo
// codigo que o agente usa; so que aqui QUEM decide o token e voce.
//
// Imprime o LINK DO LIVE VIEW no comeco — abra no navegador e assista o
// robo operando em tempo real, que e exatamente o que o espectador vera.
//
//   node scripts/teste-trade-tela.js                      (ensaio: nao clica em comprar)
//   node scripts/teste-trade-tela.js --live               (compra de verdade, ~$1)
//   node scripts/teste-trade-tela.js --live <MINT>        (num token que voce escolher)
//   node scripts/teste-trade-tela.js --live <MINT> 0.5    (com valor em dolar)
// ============================================================================

import "dotenv/config";
import * as chrome from "../src/lib/browser.js";
import * as market from "../src/lib/market.js";
import * as onchain from "../src/lib/wallet.js";
import * as livetrade from "../src/lib/livetrade.js";

const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const MINT_ARG = args.find((a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) ?? null;
const USD = Number(args.find((a) => /^\d+(\.\d+)?$/.test(a)) ?? 1);
const AGENT = "sable";

const line = (t = "") => console.log(t);
const hr = (t) => { line(); line("─".repeat(68)); line(t); line("─".repeat(68)); };

hr(LIVE ? "MODO LIVE — vai clicar em COMPRAR de verdade" : "ENSAIO — abre e conecta, mas NAO compra");

// ------------------------------------------------------- preco e carteira
const mercados = await market.jupMarkets();
const solUsd = mercados.find((m) => m.coin === "SOL")?.mark ?? 0;
const pub = process.env.SABLE_SOL_PUBKEY;
const antes = await onchain.getBalances(pub);
line(`Agente   : Sable (${pub})`);
line(`Saldo    : ${antes.sol.toFixed(6)} SOL  ($${(antes.sol * solUsd).toFixed(2)})`);
line(`Tamanho  : $${USD.toFixed(2)} ≈ ${(USD / solUsd).toFixed(6)} SOL`);

// ------------------------------------------------------- escolhe o token
let mint = MINT_ARG;
if (!mint) {
  hr("ESCOLHENDO UM TOKEN BARATO (se der errado, perde-se pouco)");
  const rec = await market.pumpRecent(30);
  // De proposito: token na curva, mercado pequeno. E teste de MECANISMO —
  // o que importa e o clique funcionar, nao a tese de investimento.
  const cand = [];
  for (const t of rec) {
    if (t.complete) continue;
    const f = await market.pumpCoin(t.mint).catch(() => null);
    if (!f) continue;
    const raio = await onchain.inspectMint(t.mint).catch(() => null);
    if (!raio?.ok) continue;
    cand.push({ ...f, poolUsd: f.virtualSol * solUsd });
    if (cand.length >= 5) break;
  }
  cand.sort((a, b) => a.usdMarketCap - b.usdMarketCap);
  const alvo = cand[0];
  if (!alvo) { line("nenhum token passou no raio-x agora — tente de novo"); process.exit(1); }
  mint = alvo.mint;
  line(`  ${alvo.symbol} (${alvo.name})`);
  line(`  mint   : ${mint}`);
  line(`  mcap   : $${Math.round(alvo.usdMarketCap).toLocaleString("en-US")}`);
  line(`  pool   : $${Math.round(alvo.poolUsd).toLocaleString("en-US")}`);
}

// ------------------------------------------------------- abre o navegador
// ORDEM IMPORTA: navegar PRIMEIRO, pegar o link DEPOIS. A sessao do
// Browserbase nasce com uma aba `about:blank`, e o link de live view so passa
// a apontar pra aba do agente depois que ela navega (e `openPage` atualiza).
// Pegar o link antes da navegacao = assistir a aba em branco (tela preta,
// "WebSocket disconnected" quando ela morre).
hr("ABRINDO A PAGINA DA MOEDA");
await chrome.openPage(AGENT, `https://pump.fun/coin/${mint}`);
await new Promise((r) => setTimeout(r, 2000));
const liveUrl = chrome.liveViewFor(AGENT);
line(liveUrl
  ? `>>> ASSISTA AQUI (abra no seu navegador):\n\n    ${liveUrl}\n`
  : ">>> sem live view (Browserbase off) — o screenshot do palco ainda vale");
line("    (12 segundos pra voce abrir o link antes de comecar)");
await new Promise((r) => setTimeout(r, 12000));

// ------------------------------------------------------- arma o portao
hr("ARMANDO O PORTAO (lista branca + simulacao + teto)");
const amountSol = USD / solUsd;
await livetrade.armWallet(AGENT, {
  maxSolSpend: amountSol * 1.3 + 0.01,
  onEvent: (m) => line(`  · ${m}`),
});
line(`  portao armado — teto de ${(amountSol * 1.3 + 0.01).toFixed(6)} SOL nesta operacao`);

if (!LIVE) {
  hr("ENSAIO: abrindo a pagina e conectando, sem comprar");
  const page = await chrome.getAgentPage(AGENT);
  await page.goto(`https://pump.fun/coin/${mint}`, { waitUntil: "domcontentloaded", timeout: 20000 });
  await new Promise((r) => setTimeout(r, 3000));
  const visto = await page.evaluate(() => ({
    titulo: document.title,
    temCarteira: !!window.solana,
    anunciaTx: !!(window.solana && window.solana.signTransaction),
    conectado: !!window.__arenaConnected,
  }));
  line(`  pagina    : ${visto.titulo}`);
  line(`  carteira  : ${visto.temCarteira ? "a pump.fun ENXERGA a carteira" : "nao injetou"}`);
  line(`  assina tx : ${visto.anunciaTx ? "SIM (portao armado)" : "nao"}`);
  hr("ENSAIO OK — nada foi comprado");
  line("Para valer:  node scripts/teste-trade-tela.js --live");
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 300).unref();
} else {
  hr("COMPRANDO NA TELA");
  // `solUsd` importa: o painel da pump.fun alterna USD/SOL, e sem o preco nao
  // da pra saber quanto digitar quando o campo esta em dolar.
  const r = await livetrade.buyOnScreen(AGENT, mint, amountSol, { onEvent: (m) => line(`  · ${m}`), solUsd });
  if (r.ok) {
    hr("COMPROU — NA TELA, AO VIVO");
    line(`  assinatura: ${r.signature}`);
    line(`  SOLSCAN   : ${r.url}`);
  } else {
    hr("A COMPRA PELA TELA NAO COMPLETOU");
    line(`  motivo: ${r.reason}`);
    line("  (no show, o agente cairia para o caminho on-chain aqui e o trade sairia assim mesmo)");
  }
  await new Promise((s) => setTimeout(s, 6000));
  const depois = await onchain.getBalances(pub);
  line(`\n  SOL antes : ${antes.sol.toFixed(6)}`);
  line(`  SOL depois: ${depois.sol.toFixed(6)}`);
  line(`  diferenca : ${(depois.sol - antes.sol).toFixed(6)} SOL`);
  process.exitCode = r.ok ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 300).unref();
}
