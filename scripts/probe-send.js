// ============================================================================
// Descobre COMO a pump.fun envia mensagem no chat da live.
//
// Abre o navegador ja logado do agente e grava os frames do websocket. Voce
// digita uma mensagem na interface do proprio site; o frame que sai revela o
// nome do evento e o formato do payload — que e o que falta para o agente
// mandar mensagem por conta propria.
//
// Nao envia nada sozinho: quem digita e a pessoa.
//
// Rodar: node scripts/probe-send.js [agente] [mint]
// ============================================================================

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(ROOT, ".env.example") });
dotenv.config({ path: path.join(ROOT, ".env"), override: true });

const { load } = await import("../src/lib/signer.js");
const { attachWallet } = await import("../src/lib/pumpwallet.js");

const AGENTE = (process.argv[2] || "sable").toLowerCase();
const MINT = process.argv[3] || "62JZuoYsXt9USyxrenubxGN5j1tffch6qTaYHhF2pump";
const ENVKEY = { sable: "SABLE_SOL_KEYPAIR", rook: "ROOK_SOL_KEYPAIR" }[AGENTE];
const wallet = load(ENVKEY);
const PERFIL = path.join(ROOT, "src", "data", "profiles", AGENTE);

console.log(`\nnavegador de ${AGENTE} (${wallet.address})`);
console.log("gravando os frames do chat...\n");

const browser = await puppeteer.launch({
  headless: false,
  userDataDir: PERFIL,
  defaultViewport: null,
  args: [
    "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run",
    "--no-default-browser-check", "--disable-session-crashed-bubble",
    "--disable-blink-features=AutomationControlled",
    "--window-position=40,60", "--window-size=760,940",
  ],
  protocolTimeout: 600000,
});

const page = (await browser.pages())[0] ?? (await browser.newPage());
await page.setUserAgent((await browser.userAgent()).replace("HeadlessChrome", "Chrome"));
page.on("dialog", (d) => d.dismiss().catch(() => {}));
await attachWallet(page, wallet, { mode: "sign" });

const cdp = await page.createCDPSession();
await cdp.send("Network.enable");
const socks = new Map();
cdp.on("Network.webSocketCreated", ({ requestId, url }) => {
  socks.set(requestId, url);
  if (/livechat/i.test(url)) console.log(`[socket do chat aberto]`);
});
const capt = (dir) => ({ requestId, response }) => {
  const url = socks.get(requestId) || "";
  const p = String(response?.payloadData ?? "");
  if (!/livechat/i.test(url) || p === "2" || p === "3") return;
  // O handshake mostra onde entra o token de sessao.
  if (p.startsWith("40")) console.log(`${dir} HANDSHAKE ${p.slice(0, 260)}`);
  else console.log(`${dir} ${p.slice(0, 260)}`);
};
cdp.on("Network.webSocketFrameSent", capt("ENVIOU >>"));
cdp.on("Network.webSocketFrameReceived", capt("RECEBEU <<"));

await page.goto(`https://pump.fun/coin/${MINT}`, { waitUntil: "domcontentloaded", timeout: 60000 });

console.log("=".repeat(64));
console.log("  DIGITE UMA MENSAGEM NO CHAT DA JANELA E APERTE ENTER");
console.log("  (qualquer coisa curta, tipo 'teste')");
console.log("  Eu registro o frame que sair. Depois pode fechar a janela.");
console.log("=".repeat(64) + "\n");

const inicio = Date.now();
while (Date.now() - inicio < 15 * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 2000));
  if (!browser.connected) break;
}
await browser.close().catch(() => {});
process.exit(0);
