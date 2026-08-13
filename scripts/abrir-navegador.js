// ============================================================================
// Abre o navegador do agente PARA O MICHEL LOGAR NA MAO.
//
// Nao automatiza login nenhum: so abre a janela, no perfil do agente, com a
// carteira dele injetada e pronta. Quem clica e a pessoa.
//
// O que a carteira injetada faz: quando o site pedir a assinatura de login, ela
// assina com a chave daquele agente — sem popup de extensao, sem senha. O
// filtro do `signer` continua valendo: so texto, nunca transacao.
//
// Depois do login o perfil fica salvo em src/data/profiles/<agente>, entao o
// engine sobe ja logado e os agentes seguem sozinhos daqui em diante.
//
// Rodar:  node scripts/abrir-navegador.js [agente] [mint]
//   agente — "sable" | "rook"   (padrao: sable)
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
const MINT = process.argv[3] || "Ewbioo9ykibVrZAiHzKjbXYuZMeuUfDtnwzzDDGZ5rhV";
const ENVKEY = { sable: "SABLE_SOL_KEYPAIR", rook: "ROOK_SOL_KEYPAIR" }[AGENTE];

if (!ENVKEY) { console.error(`agente desconhecido: ${AGENTE}`); process.exit(1); }
if (!String(process.env[ENVKEY] ?? "").trim()) {
  console.error(`${ENVKEY} nao esta configurada no painel.`); process.exit(1);
}

const wallet = load(ENVKEY);
const PERFIL = path.join(ROOT, "src", "data", "profiles", AGENTE);

console.log(`\n${"=".repeat(64)}`);
console.log(`  NAVEGADOR DE ${AGENTE.toUpperCase()}`);
console.log(`${"=".repeat(64)}`);
console.log(`  carteira : ${wallet.address}`);
console.log(`  perfil   : ${PERFIL}`);
console.log(`${"=".repeat(64)}\n`);

const browser = await puppeteer.launch({
  headless: false,
  userDataDir: PERFIL,
  defaultViewport: null,
  args: [
    "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run",
    "--no-default-browser-check", "--disable-session-crashed-bubble",
    "--disable-blink-features=AutomationControlled",
    // Janela VISIVEL, ao contrario do modo automatico.
    AGENTE === "rook" ? "--window-position=740,60" : "--window-position=40,60",
    "--window-size=700,900",
  ],
  protocolTimeout: 600000,
});

const page = (await browser.pages())[0] ?? (await browser.newPage());
await page.setUserAgent((await browser.userAgent()).replace("HeadlessChrome", "Chrome"));
page.on("dialog", (d) => d.dismiss().catch(() => {}));

await attachWallet(page, wallet, {
  mode: "sign",
  onSignRequest: (texto) => {
    console.log(`\n  >>> o site pediu para assinar: ${JSON.stringify(texto)}`);
    console.log(`  >>> assinando com a carteira de ${AGENTE}...\n`);
  },
});

// Passar "perfil" no lugar do mint abre direto a pagina de perfil.
const DESTINO = MINT === "perfil" ? "https://pump.fun/profile" : `https://pump.fun/coin/${MINT}`;
await page.goto(DESTINO, { waitUntil: "domcontentloaded", timeout: 60000 });

console.log("O QUE FAZER NA JANELA QUE ABRIU:\n");
console.log("  1. Se aparecer o aviso de cookies, clique em 'Reject all'");
console.log("  2. Clique em 'Sign in' (canto superior direito)");
console.log("  3. Na lista de carteiras, clique em 'Phantom' (aparece 'Detected')");
console.log("  4. A assinatura acontece sozinha — nao precisa de senha nem extensao");
console.log("  5. Depois de logado, mude o nome do perfil para " +
  `"${AGENTE === "sable" ? "Sable" : "Rook"}" se quiser fazer isso agora\n`);
console.log("Vou avisar aqui quando detectar que o login entrou.");
console.log("Quando terminar, feche a janela do navegador (ou Ctrl+C aqui).\n");

// Fica observando ate o login entrar. Nao clica em nada.
let logado = false;
const inicio = Date.now();
while (Date.now() - inicio < 30 * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 3000));
  if (!browser.connected) { console.log("\n(janela fechada)"); break; }
  try {
    const agora = await page.evaluate(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const txt = [...document.querySelectorAll("button,[role=button]")].filter(vis)
        .map((b) => (b.innerText || "").trim().toLowerCase());
      return !txt.some((t) => t === "sign in" || t === "log in");
    });
    if (agora && !logado) {
      logado = true;
      console.log(`\n  *** ${AGENTE.toUpperCase()} ESTA LOGADO ***`);
      console.log(`  A sessao ficou salva em ${PERFIL}`);
      console.log(`  Pode fechar a janela — o engine vai subir ja logado.\n`);
    }
  } catch { /* pagina navegando */ }
}

await browser.close().catch(() => {});
process.exit(0);
