// ============================================================================
// Teste OFFLINE da carteira injetada. Zero rede, zero risco, nenhuma conta.
//
// Uma pagina local faz o papel do site: dispara o handshake do Wallet Standard,
// coleta as carteiras que se registrarem, e pede uma assinatura. O Node depois
// confere a assinatura com `signer.verify`.
//
// Este teste existe porque a versao anterior do `pumpwallet.js` estava quebrada
// de duas formas que so apareciam em producao (handshake invertido e ponte de
// assinatura apagada), e o sintoma era "o site trava" — caro de diagnosticar.
// Rodar: node scripts/probe-wallet.js
// ============================================================================

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer";
import { b58encode, verify } from "../src/lib/signer.js";
import { load } from "../src/lib/signer.js";
import { attachWallet } from "../src/lib/pumpwallet.js";

// Keypair DESCARTAVEL, gerada agora. Nenhuma chave real e usada.
const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const seed = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
const pub = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
process.env.PROBE_KEYPAIR = b58encode(Buffer.concat([seed, pub]));
const wallet = load("PROBE_KEYPAIR");

// A pagina que finge ser o site. Faz o handshake do jeito que o spec manda.
//
// Precisa ser NAVEGACAO de verdade (arquivo em disco), nao `setContent`:
// `setContent` usa document.open(), que remove todos os listeners do window —
// mataria o listener de app-ready da carteira e o teste mediria o proprio
// artefato em vez do modulo.
const APP = `<!doctype html><html><body><script>
  window.__encontradas = [];
  const api = { register: (w) => { window.__encontradas.push(w); return () => {}; } };
  // Caminho 1: a carteira ja estava la e escuta o app-ready.
  window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
  // Caminho 2: a carteira chega depois e se anuncia.
  window.addEventListener("wallet-standard:register-wallet", (e) => {
    try { e.detail(api); } catch (err) { window.__appErro = String(err); }
  });
</script></body></html>`;

const APP_FILE = path.join(os.tmpdir(), `arena-probe-app-${process.pid}.html`);
fs.writeFileSync(APP_FILE, APP);
const APP_URL = `file:///${APP_FILE.replace(/\\/g, "/")}`;

let falhas = 0;
const check = (nome, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALHA "} ${nome}${extra ? " — " + extra : ""}`);
  if (!ok) falhas++;
};

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
});

try {
  const page = await browser.newPage();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));

  const pedidos = [];
  await attachWallet(page, wallet, { onSignRequest: (t) => pedidos.push(t) });
  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });

  // 1. O site enxergou a carteira?
  const vista = await page.evaluate(() => ({
    quantas: window.__encontradas.length,
    nome: window.__encontradas[0]?.name ?? null,
    endereco: window.__encontradas[0]?.accounts?.[0]?.address ?? null,
    features: Object.keys(window.__encontradas[0]?.features ?? {}),
    erroApp: window.__appErro ?? null,
    erroRegistro: window.__arenaRegisterError ?? null,
  }));
  check("a carteira foi registrada", vista.quantas > 0, `encontradas=${vista.quantas} erroApp=${vista.erroApp} erroReg=${vista.erroRegistro}`);
  check("endereco correto", vista.endereco === wallet.address, vista.endereco ?? "nenhum");
  check("anuncia signMessage", vista.features.includes("solana:signMessage"), vista.features.join(","));
  check("NAO anuncia assinatura de transacao",
    !vista.features.some((f) => /signTransaction|signAndSend/i.test(f)), vista.features.join(","));

  // 2. Conectar e assinar, pelo caminho do Wallet Standard.
  const MSG = "pump.fun wants you to sign in\nNonce: abc123";
  const assinado = await page.evaluate(async (msg) => {
    const w = window.__encontradas[0];
    await w.features["standard:connect"].connect();
    const enc = new TextEncoder().encode(msg);
    const out = await w.features["solana:signMessage"].signMessage({
      account: w.accounts[0], message: enc,
    });
    return Array.from(out[0].signature);
  }, MSG);
  const sigB58 = b58encode(Uint8Array.from(assinado));
  check("assinatura tem 64 bytes", assinado.length === 64, String(assinado.length));
  check("assinatura confere com a chave publica", verify(MSG, sigB58, wallet.address));
  check("auditoria registrou o pedido", pedidos.length === 1 && pedidos[0] === MSG, JSON.stringify(pedidos[0] ?? null));

  // 3. Provider legado tambem assina.
  const legado = await page.evaluate(async (msg) => {
    await window.solana.connect();
    const r = await window.solana.signMessage(new TextEncoder().encode(msg));
    return Array.from(r.signature);
  }, MSG);
  check("provider legado assina", verify(MSG, b58encode(Uint8Array.from(legado)), wallet.address));
  const semTx = await page.evaluate(() => ({
    signTransaction: typeof window.solana.signTransaction,
    sendTransaction: typeof window.solana.sendTransaction,
  }));
  check("legado nao expoe signTransaction", semTx.signTransaction === "undefined");
  check("legado nao expoe sendTransaction", semTx.sendTransaction === "undefined");

  // 4. A TRAVA: payload binario (formato de transacao) tem que ser recusado.
  const recusa = await page.evaluate(async () => {
    const bin = new Uint8Array([1, 0, 0, 3, 255, 12, 0, 200, 77, 4, 0, 0, 9]);
    try {
      await window.solana.signMessage(bin);
      return "ASSINOU";
    } catch (e) { return `recusou (${e.code ?? "sem codigo"})`; }
  });
  check("recusa payload binario (transacao)", recusa !== "ASSINOU", recusa);

  // 5. Modo observe nunca assina — e o modo da sonda de login.
  const page2 = await browser.newPage();
  page2.on("dialog", (d) => d.dismiss().catch(() => {}));
  await attachWallet(page2, wallet, { mode: "observe" });
  await page2.goto(APP_URL, { waitUntil: "domcontentloaded" });
  const obs = await page2.evaluate(async (msg) => {
    await window.solana.connect();
    try { await window.solana.signMessage(new TextEncoder().encode(msg)); return "ASSINOU"; }
    catch { return "recusou"; }
  }, MSG);
  check("modo observe nao assina", obs === "recusou", obs);

  // 6. Idempotencia: preparar a mesma pagina duas vezes nao pode estourar.
  let doisOk = true;
  try { await attachWallet(page, wallet); } catch (e) { doisOk = false; console.log("   ", e.message); }
  check("attach duas vezes na mesma pagina", doisOk);
} finally {
  await browser.close().catch(() => {});
  fs.rmSync(APP_FILE, { force: true });
}

console.log(falhas === 0 ? "\nFASE 2 OK — carteira injetada funciona e a trava segura" : `\n${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
