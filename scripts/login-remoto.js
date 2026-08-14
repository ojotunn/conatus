// ============================================================================
// LOGIN NA PUMP.FUN NO NAVEGADOR REMOTO — para o Michel clicar, como sempre.
//
// O `abrir-navegador.js` abre um Chromium LOCAL e o login fica no perfil daqui.
// No Railway o navegador e outro (Browserbase, num datacenter dos EUA), e ele
// sobe sem sessao nenhuma — por isso os agentes nao conseguiam falar na sala.
//
// Este script abre a MESMA sessao remota que o motor usa, com a carteira do
// agente injetada, e imprime o link do live view. Voce clica no link, dispensa
// o banner, clica em Sign in -> Phantom, e a assinatura acontece sozinha (e
// mensagem de texto; o `signer` assina texto e recusa transacao). O script fica
// olhando os cookies e avisa na hora em que a sessao aparece.
//
// O login mora no CONTEXT do Browserbase, que e persistente: feito uma vez,
// vale para as proximas sessoes remotas — inclusive as do Railway, desde que
// as duas pontas usem o mesmo context (e para isso serve a variavel
// BROWSERBASE_CTX_<AGENTE>, que este script imprime no fim).
//
// Nao automatiza login nenhum. So abre a porta; quem entra e voce.
//
// Rodar:  node scripts/login-remoto.js [agente]
//   agente — "sable" | "rook"   (padrao: sable)
// ============================================================================

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(ROOT, ".env.example") });
dotenv.config({ path: path.join(ROOT, ".env"), override: true });

const chrome = await import("../src/lib/browser.js");

const AGENTE = (process.argv[2] || "sable").toLowerCase();
if (!["sable", "rook"].includes(AGENTE)) {
  console.error(`agente desconhecido: ${AGENTE} (use sable ou rook)`);
  process.exit(1);
}
if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) {
  console.error("BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID nao configuradas — sem elas o navegador e local e o login nao serve para o Railway.");
  process.exit(1);
}

const linha = "=".repeat(70);
console.log(`\n${linha}\n  LOGIN REMOTO — ${AGENTE.toUpperCase()}\n${linha}`);

// A pagina do agente: mesma funcao que o motor usa, entao e o mesmo navegador,
// o mesmo context e a mesma carteira injetada.
const page = await chrome.getAgentPage(AGENTE);
await page.goto("https://pump.fun", { waitUntil: "domcontentloaded", timeout: 60000 });

const live = chrome.liveViewFor(AGENTE);
console.log(`
  ABRA ESTE LINK E FACA O LOGIN (e um navegador de verdade, da para clicar):

  ${live ?? "(live view indisponivel — veja o painel do Browserbase)"}

  Passo a passo, na ordem que funciona:
    1. dispense o banner de cookies (Reject all) — ele fica POR CIMA e engole o clique
    2. Sign in
    3. escolha Phantom — a assinatura acontece sozinha, sem popup
`);
console.log(`${linha}\n  esperando a sessao aparecer... (Ctrl+C para desistir)\n`);

// Espera ativa: olha o cookie a cada 3s por ate 10 minutos.
const ate = Date.now() + 10 * 60 * 1000;
let logado = false;
while (Date.now() < ate) {
  await new Promise((r) => setTimeout(r, 3000));
  let cookies = null;
  try { cookies = await chrome.cookiesFor(AGENTE); } catch { /* aba ocupada */ }
  if (cookies && /auth|privy|session|token/i.test(cookies)) {
    logado = true;
    break;
  }
}

if (!logado) {
  console.log("  Nao vi sessao nenhuma em 10 minutos. O navegador remoto continua de pe —");
  console.log("  rode de novo e termine o login, ou lance com ROOM_POST_ENABLED=0.\n");
} else {
  console.log("  SESSAO ENCONTRADA — o agente esta logado no navegador remoto.\n");
}

// O id do context e o que precisa ir para o Railway: e ele que carrega o login.
const ctxId = chrome.contextIdFor(AGENTE);
if (ctxId) {
  console.log(`${linha}`);
  console.log("  Ponha esta variavel no servico do Railway para o login valer la tambem:\n");
  console.log(`    BROWSERBASE_CTX_${AGENTE.toUpperCase()}=${ctxId}\n`);
  console.log(`${linha}\n`);
}

await chrome.closeBrowser().catch(() => {});
process.exit(0);
