// ============================================================================
// SONDA do login da pump.fun. Observa, nao entra.
//
// Usa keypair DESCARTAVEL e a carteira em modo "observe": o site pode pedir
// assinatura a vontade, que nunca recebe uma. Sem assinatura nao ha verificacao,
// e sem verificacao nenhuma conta e criada. Esta sonda e de leitura.
//
// Responde quatro perguntas que hoje sao chute:
//   1. A nossa carteira aparece na lista de carteiras do site?
//      (se nao aparecer, o wallet-adapter esta filtrando quem nao anuncia
//       assinatura de transacao — e ai ha uma decisao a tomar)
//   2. Qual a mensagem EXATA que ele manda assinar? SIWS ou texto livre?
//   3. Qual endpoint recebe a verificacao, e onde volta o token?
//   4. Como fica o handshake 40{...} do socket quando ha sessao?
//
// Rodar: node scripts/probe-login.js [mint]
// ============================================================================

import crypto from "node:crypto";
import puppeteer from "puppeteer";
import { b58encode, load } from "../src/lib/signer.js";
import { attachWallet } from "../src/lib/pumpwallet.js";

const MINT = process.argv[2] || "Ewbioo9ykibVrZAiHzKjbXYuZMeuUfDtnwzzDDGZ5rhV";
const URL = `https://pump.fun/coin/${MINT}`;

// Keypair descartavel. Nenhuma chave real e tocada.
const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const seed = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
const pub = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
process.env.PROBE_KEYPAIR = b58encode(Buffer.concat([seed, pub]));
const wallet = load("PROBE_KEYPAIR");
console.log(`endereco descartavel: ${wallet.address}\n`);

const pedidos = [];   // mensagens que o site pediu para assinar
const authHits = [];  // chamadas de rede que cheiram a autenticacao
const wsFrames = [];  // frames do websocket

const browser = await puppeteer.launch({
  headless: false,
  args: [
    "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run",
    "--disable-blink-features=AutomationControlled",
    "--window-position=-32000,-32000", "--window-size=1400,950",
  ],
  protocolTimeout: 60000,
});

// Espera curta que NAO usa evaluate — serve para saber se o renderer morreu.
async function vivo(page, ms = 3000) {
  return Promise.race([
    page.evaluate(() => 1).then(() => true).catch(() => false),
    new Promise((r) => setTimeout(() => r(false), ms)),
  ]);
}

// Quando o renderer trava, isto diz ONDE. Transforma "a pagina travou" em
// "a pagina esta em loop no chunk X".
async function ondeTravou(page) {
  try {
    const cdp = await page.createCDPSession();
    await cdp.send("Debugger.enable");
    const p = new Promise((res) => cdp.once("Debugger.paused", (e) => res(e.callFrames.slice(0, 8))));
    await cdp.send("Debugger.pause");
    const frames = await Promise.race([p, new Promise((r) => setTimeout(() => r(null), 5000))]);
    if (!frames) return "nao consegui pausar o debugger";
    return frames.map((f) => `${f.functionName || "(anon)"} @ ${f.url?.split("/").pop()}:${f.location?.lineNumber}`).join("\n      ");
  } catch (e) { return `falhou: ${e.message}`; }
}

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 950 });
  await page.setUserAgent((await browser.userAgent()).replace("HeadlessChrome", "Chrome"));

  // INSTRUMENTACAO ANTES DE QUALQUER CLIQUE.
  // Um dialog nativo trava o renderer inteiro e o Puppeteer nao dispensa
  // sozinho — era a hipotese principal do travamento da primeira tentativa.
  page.on("dialog", (d) => { console.log(`   [dialog] ${d.type()}: ${d.message().slice(0, 80)}`); d.dismiss().catch(() => {}); });
  page.on("pageerror", (e) => console.log(`   [erro na pagina] ${String(e.message).slice(0, 120)}`));
  browser.on("targetcreated", (t) => console.log(`   [alvo novo] ${t.type()} ${t.url().slice(0, 80)}`));
  page.on("response", (r) => {
    const u = r.url();
    if (/auth|challenge|verify|login|nonce|session|token/i.test(u) && !/\.js|\.css|\.png|\.svg/i.test(u)) {
      authHits.push({ status: r.status(), method: r.request().method(), url: u.slice(0, 160) });
    }
  });

  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable");
  const socks = new Map();
  cdp.on("Network.webSocketCreated", ({ requestId, url }) => socks.set(requestId, url));
  const frame = (dir) => ({ requestId, response }) => {
    const url = socks.get(requestId) || "";
    const p = String(response?.payloadData ?? "");
    if (!/livechat/i.test(url) || p === "2" || p === "3") return;
    wsFrames.push(`${dir} ${p.slice(0, 300)}`);
  };
  cdp.on("Network.webSocketFrameSent", frame(">>"));
  cdp.on("Network.webSocketFrameReceived", frame("<<"));

  // Carteira em modo OBSERVE: registra o pedido, nunca devolve assinatura.
  await attachWallet(page, wallet, {
    mode: "observe",
    onSignRequest: (texto, bytes) => {
      pedidos.push(texto);
      console.log(`\n   >>> O SITE PEDIU ASSINATURA (${bytes} bytes) <<<`);
      console.log(`   ${JSON.stringify(texto)}\n`);
    },
  });

  console.log("abrindo a pagina da moeda...");
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await new Promise((r) => setTimeout(r, 12000));

  const cf = await page.evaluate(() => document.body?.innerText?.slice(0, 200) ?? "");
  if (/just a moment|checking your browser|verify you are human/i.test(cf)) {
    console.log("\n!! CLOUDFLARE barrou a pagina. Texto:", cf.slice(0, 120));
    throw new Error("cloudflare");
  }

  // A carteira foi registrada?
  const reg = await page.evaluate(() => ({
    nossa: !!window.__arenaWallet,
    erroRegistro: window.__arenaRegisterError ?? null,
    legado: typeof window.solana?.connect,
  }));
  console.log(`\n1) carteira injetada presente: ${reg.nossa}, provider legado: ${reg.legado}, erro: ${reg.erroRegistro}`);

  // Banner de cookies por cima de tudo intercepta o clique. Recusar o que nao e
  // essencial e a opcao correta aqui (e a mais privada).
  const cookie = await page.evaluateHandle(() => [...document.querySelectorAll("button,[role=button]")]
    .find((b) => /^(reject all|recusar tudo|decline)$/i.test((b.innerText || "").trim())) ?? null);
  if (cookie.asElement()) {
    console.log("   dispensando banner de cookies (Reject all)...");
    await cookie.asElement().click().catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Achar e clicar em "Sign in" — com clique REAL, nao evaluate.
  const botao = await page.evaluateHandle(() => {
    const alvos = [...document.querySelectorAll("button,[role=button],a")];
    return alvos.find((b) => /^(sign in|log in|login|connect wallet|connect)$/i.test((b.innerText || "").trim())) ?? null;
  });
  const el = botao.asElement();
  if (!el) {
    console.log("\n!! nenhum botao de login visivel. Botoes na tela:");
    const btns = await page.evaluate(() => [...document.querySelectorAll("button,[role=button]")]
      .map((b) => (b.innerText || "").replace(/\s+/g, " ").trim()).filter((t) => t && t.length < 40).slice(0, 25));
    console.log("   " + btns.join(" | "));
    throw new Error("sem botao de login");
  }
  // Onde exatamente esta esse botao? Elemento fora da tela ou coberto por
  // overlay faz o clique "funcionar" sem efeito nenhum.
  const caixa = await el.boundingBox().catch(() => null);
  const cobertura = await page.evaluate((e) => {
    const r = e.getBoundingClientRect();
    const topo = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      tag: e.tagName, texto: (e.innerText || "").trim().slice(0, 30),
      noTopo: topo === e || e.contains(topo),
      quemEstaEmCima: topo ? `${topo.tagName}.${String(topo.className).slice(0, 40)}` : null,
    };
  }, el);
  console.log(`2) botao: ${cobertura.tag} "${cobertura.texto}" caixa=${caixa ? `${Math.round(caixa.x)},${Math.round(caixa.y)}` : "sem caixa"}`);
  console.log(`   clicavel de verdade: ${cobertura.noTopo}${cobertura.noTopo ? "" : ` (coberto por ${cobertura.quemEstaEmCima})`}`);
  await el.click().catch((e) => console.log("   clique falhou:", e.message));

  if (!(await vivo(page, 4000))) {
    console.log("\n!! O RENDERER TRAVOU. Pilha:\n      " + (await ondeTravou(page)));
    throw new Error("renderer travado");
  }
  await new Promise((r) => setTimeout(r, 8000));

  await page.screenshot({ path: "scripts/probe-apos-clique.jpg", type: "jpeg", quality: 60 }).catch(() => {});
  const naTela = await page.evaluate(() => (document.body?.innerText ?? "").replace(/\n{2,}/g, "\n").slice(0, 700));
  console.log("\n   texto na tela apos o clique:\n   " + naTela.split("\n").slice(0, 20).join("\n   "));

  // O modal do Privy vive em SHADOW DOM: `querySelectorAll` normal nao
  // atravessa, entao a varredura "nao via" um modal que estava na tela.
  // Esta funcao desce em toda shadow root aberta.
  const DEEP = `(() => {
    const achados = [];
    const anda = (raiz) => {
      for (const el of raiz.querySelectorAll("*")) {
        achados.push(el);
        if (el.shadowRoot) anda(el.shadowRoot);
      }
    };
    anda(document);
    return achados;
  })()`;

  // O que apareceu no modal? A pump.fun usa Privy, que renderiza o modal DENTRO
  // DE UM IFRAME — olhar so o frame principal nao ve nada.
  const varrer = async (f, rotulo) => {
    try {
      const itens = await f.evaluate((deepSrc) => {
        const todos = eval(deepSrc);
        const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        return [...new Set(todos
          .filter((e) => /^(BUTTON|A|LI)$/.test(e.tagName) || e.getAttribute?.("role") === "button")
          .filter(vis).map((e) => (e.innerText || "").replace(/\s+/g, " ").trim())
          .filter((t) => t && t.length < 45))].slice(0, 30);
      }, DEEP);
      if (itens.length) {
        console.log(`\n   [${rotulo}]`);
        for (const t of itens) console.log("   -", t);
      }
      return itens;
    } catch { return []; }
  };

  console.log("\n3) itens visiveis apos o clique, por frame:");
  let modal = await varrer(page.mainFrame(), "pagina principal");
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    const itens = await varrer(f, `iframe: ${f.url().slice(0, 70)}`);
    modal = modal.concat(itens);
  }

  const temPhantom = modal.some((t) => /phantom/i.test(t));
  console.log(`\n   >>> NOSSA CARTEIRA APARECE NA LISTA: ${temPhantom ? "SIM" : "NAO"} <<<`);

  if (temPhantom) {
    console.log("4) clicando em Phantom (atravessando shadow DOM)...");
    const ph = await page.evaluateHandle((deepSrc) => {
      const todos = eval(deepSrc);
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      // O alvo clicavel e o elemento mais interno que contem so "Phantom".
      const cands = todos.filter((e) => vis(e) && /phantom/i.test(e.innerText || "") &&
        (e.tagName === "BUTTON" || e.getAttribute?.("role") === "button" || e.tagName === "LI" || e.tagName === "DIV"));
      return cands.sort((a, b) => (a.innerText || "").length - (b.innerText || "").length)[0] ?? null;
    }, DEEP);
    const phEl = ph.asElement();
    if (phEl) {
      await phEl.click().catch((e) => console.log("   clique falhou:", e.message));
      console.log("   cliquei. esperando o pedido de assinatura...");
    } else {
      console.log("   nao achei o alvo clicavel do Phantom");
    }
    // Esperar o pedido de assinatura chegar (ou nao).
    for (let i = 0; i < 30 && pedidos.length === 0; i++) await new Promise((r) => setTimeout(r, 1000));
    await page.screenshot({ path: "scripts/probe-apos-phantom.jpg", type: "jpeg", quality: 60 }).catch(() => {});
  }

  await new Promise((r) => setTimeout(r, 4000));
} catch (e) {
  console.log(`\n[sonda interrompida: ${e.message}]`);
} finally {
  console.log("\n" + "=".repeat(70));
  console.log("RELATORIO");
  console.log("=".repeat(70));
  console.log(`\nP1 — pedidos de assinatura recebidos: ${pedidos.length}`);
  for (const p of pedidos) console.log(`   ${JSON.stringify(p)}`);
  console.log(`\nP2 — chamadas de autenticacao vistas: ${authHits.length}`);
  for (const a of authHits.slice(0, 12)) console.log(`   ${a.method} ${a.status} ${a.url}`);
  console.log(`\nP3 — frames do livechat: ${wsFrames.length}`);
  for (const f of wsFrames.slice(0, 10)) console.log(`   ${f}`);
  await browser.close().catch(() => {});
  process.exit(0);
}
