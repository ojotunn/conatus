// ============================================================================
// Loga os agentes na pump.fun com as carteiras deles e ajusta o nome do perfil.
//
// Passo IRREVERSIVEL: cria conta de verdade, com a carteira de verdade. Estas
// sao as carteiras que serao usadas no lancamento do token.
//
// Rodar:  node scripts/login-agents.js [mint] [agente]
//   mint   — sala/moeda usada para abrir a pagina (padrao: a live de teste)
//   agente — "sable" | "rook" | "todos" (padrao: todos)
// ============================================================================

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(ROOT, ".env.example") });
dotenv.config({ path: path.join(ROOT, ".env"), override: true });

const { login, setProfileName } = await import("../src/lib/pumpauth.js");
const browser = await import("../src/lib/browser.js");

const MINT = process.argv[2] || "Ewbioo9ykibVrZAiHzKjbXYuZMeuUfDtnwzzDDGZ5rhV";
const QUEM = (process.argv[3] || "todos").toLowerCase();
const NOMES = { sable: "Sable", rook: "Rook" };
const ALVOS = QUEM === "todos" ? ["sable", "rook"] : [QUEM];

for (const id of ALVOS) {
  console.log(`\n${"=".repeat(60)}\n${id.toUpperCase()}\n${"=".repeat(60)}`);

  const r = await login(id, { mint: MINT, onEvent: (m) => console.log(`   · ${m}`) });

  if (!r.ok) {
    console.log(`FALHOU: ${r.error}`);
    if (r.address) console.log(`   endereco: ${r.address}`);
    if (r.signedMessage) console.log(`   assinou: ${JSON.stringify(r.signedMessage)}`);
    continue;
  }

  console.log(r.alreadyLoggedIn ? "JA ESTAVA LOGADO" : "LOGADO AGORA");
  console.log(`   endereco: ${r.address}`);
  if (r.signedMessage) console.log(`   mensagem assinada: ${JSON.stringify(r.signedMessage)}`);

  const p = await setProfileName(id, NOMES[id], { onEvent: (m) => console.log(`   · ${m}`) });
  console.log(p.ok ? `   perfil renomeado para "${NOMES[id]}"` : `   perfil nao mudou: ${p.error}`);
}

await browser.closeBrowser();
console.log("\npronto.");
process.exit(0);
