// ============================================================================
// Teste da integracao Browserbase: cria uma sessao remota DE VERDADE, navega,
// confirma IP/pais (deve ser US) e idioma, e fecha (sessao aberta = cobranca).
//
// Consome ~1-2 minutos de browser-hours do plano. Exige as chaves no .env:
// BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID.
// Rodar: node scripts/probe-browserbase.js
// ============================================================================

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(ROOT, ".env.example") });
dotenv.config({ path: path.join(ROOT, ".env"), override: true });

if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) {
  console.log("SKIP — chaves do Browserbase ausentes no .env");
  process.exit(0);
}

const b = await import("../src/lib/browser.js");

let fails = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  PASS  ${msg}`);
  else { console.log(`  FAIL  ${msg}`); fails++; }
};

console.log("\n1) sessao remota + navegacao real");
const t0 = Date.now();
// readPage usa o navegador anonimo — com as chaves setadas, deve sair REMOTO.
const geo = await b.readPage("https://ipinfo.io/json", { maxChars: 800 });
console.log(`  (sessao + pagina em ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
ok(geo.status === 200, `pagina respondeu (${geo.status})`);
const country = /"country"\s*:\s*"([A-Z]{2})"/.exec(geo.text)?.[1] ?? "?";
const ip = /"ip"\s*:\s*"([0-9a-f.:]+)"/i.exec(geo.text)?.[1] ?? "?";
console.log(`  IP de saida: ${ip} · pais: ${country}`);
ok(country === "US", `IP de saida e AMERICANO (country=${country})`);

console.log("\n2) idioma continua en-US no remoto");
const nav = await b.readPage(
  "data:text/html,<body><script>document.body.textContent=navigator.language+' | '+Intl.DateTimeFormat().resolvedOptions().timeZone</script></body>",
  { maxChars: 200 });
console.log(`  ${nav.text}`);
ok(/en-US/.test(nav.text), "navigator.language = en-US");

console.log("\n3) info e encerramento (sessao aberta = cobranca)");
const info = b.browserInfo();
ok(info.length > 0 && info[0].connected, "navegador registrado e conectado");
await b.closeBrowser();
ok(b.browserInfo().every((x) => !x.connected) || b.browserInfo().length === 0, "sessao encerrada");

console.log(`\n${fails === 0 ? "TODOS VERDES — Browserbase operacional" : fails + " FALHA(S)"}\n`);
process.exit(fails === 0 ? 0 : 1);
