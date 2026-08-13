// ============================================================================
// Login do agente na pump.fun, com a carteira dele.
//
// O agente entra como uma pessoa entra: abre a pagina, clica em "Sign in",
// escolhe a carteira na lista, e assina a mensagem de login. Nada de API
// interna, nada de credencial de terceiro.
//
// A mensagem que a pump manda assinar (capturada da propria pagina) e:
//     "Sign in to pump.fun: <timestamp>"
// Texto simples — passa no filtro do `signer`, que so assina texto legivel.
// Se um dia virar outra coisa que nao seja texto, a assinatura e recusada e o
// login falha: e o comportamento desejado, nao um bug.
//
// RECEITA (descoberta na marra, cada passo importa):
//   - o banner de cookies fica POR CIMA e engole o clique -> dispensar primeiro
//   - clique tem que ser REAL (CDP), nao `el.click()` dentro de evaluate:
//     clique sintetico nao abre o modal
//   - o item da carteira e um BUTTON com um SPAN dentro; clicar por coordenada
//     no span e o que funciona
//   - a aba precisa estar em primeiro plano (`bringToFront`)
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as browser from "./browser.js";
import { load } from "./signer.js";
import { attachWallet } from "./pumpwallet.js";
import { addRuntimeSecret, redact } from "./secrets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const DATA = path.join(ROOT, "src", "data");

const KEYPAIR_ENV = { sable: "SABLE_SOL_KEYPAIR", rook: "ROOK_SOL_KEYPAIR" };
const sessions = new Map(); // agentId -> { address, at, cookies }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sessionFile(agentId) {
  return path.join(DATA, `session-${agentId}.json`);
}

// Clique de verdade num botao achado por texto. Devolve false se nao existe.
async function clickByText(page, re, { tags = "button,[role=button]" } = {}) {
  const h = await page.evaluateHandle((src, sel) => {
    const rx = new RegExp(src, "i");
    return [...document.querySelectorAll(sel)]
      .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .find((b) => rx.test((b.innerText || "").trim())) ?? null;
  }, re.source, tags);
  const el = h.asElement();
  if (!el) return false;
  await el.click().catch(() => {});
  return true;
}

// Onde esta o item de uma carteira no modal? Devolve o ponto de clique.
async function walletSpot(page, nome) {
  return page.evaluate((n) => {
    const rx = new RegExp(n, "i");
    const achados = [];
    const anda = (raiz) => {
      let els = [];
      try { els = [...raiz.querySelectorAll("*")]; } catch { return; }
      for (const el of els) {
        const t = (el.textContent || "").trim();
        if (rx.test(t) && t.length < 60) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            achados.push({ folha: el.children.length === 0, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
          }
        }
        if (el.shadowRoot) anda(el.shadowRoot);
      }
    };
    anda(document);
    // O alvo bom e a folha (o SPAN com o nome), nao o container.
    return achados.find((a) => a.folha) ?? achados[achados.length - 1] ?? null;
  }, nome);
}

// A aba morreu? A tela de erro do Chrome tem praticamente so "Reload"/"Back" e
// quase nenhum texto — e, pra quem assiste, a janela ao vivo fica PRETA. Isso
// aconteceu logo apos o clique em "Sign in" em 12/08/2026: a carteira estava
// injetada certinho e nao havia lista de carteira nenhuma porque nao havia
// pagina. Detectar isso e o que separa "nao achei a carteira" de "a pagina
// caiu" — dois problemas que exigem respostas opostas.
export async function pareceMorta(page) {
  return page.evaluate(() => {
    const btns = [...document.querySelectorAll("button,[role=button]")]
      .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .map((b) => (b.innerText || "").trim().toLowerCase());
    const texto = (document.body?.innerText ?? "").trim();
    const soErro = btns.length > 0 &&
      btns.every((t) => /^(reload|back|recarregar|voltar|details|detalhes)$/.test(t));
    return soErro || texto.length < 40;
  }).catch(() => true); // se nem da pra perguntar, esta morta
}

export async function isLoggedIn(page) {
  return page.evaluate(() => {
    const botoes = [...document.querySelectorAll("button,[role=button]")]
      .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .map((b) => (b.innerText || "").trim().toLowerCase());
    // Enquanto deslogado existe "Sign in". Logado, ele some.
    return !botoes.some((t) => t === "sign in" || t === "log in");
  });
}

/**
 * A RECEITA, numa funcao so — em QUALQUER aba que ja tenha a carteira presa.
 *
 * Existe porque o `livetrade` tinha reimplementado isto por conta propria, pior:
 * sem dispensar o banner, clicando a carteira por texto em vez de coordenada,
 * sem varrer shadow DOM, com esperas curtas demais, e confirmando sucesso por
 * uma flag NOSSA (`window.__arenaConnected`) em vez de um fato da PAGINA. Em
 * 12/08/2026 isso reprovou as quatro tentativas de trade na tela. Uma receita
 * so, dois chamadores.
 *
 * Pressupoe que `attachWallet` ja rodou nesta aba — nao mexe na carteira, pra
 * nao rebaixar uma carteira armada para assinar transacao.
 *
 * @returns { ok, alreadyLoggedIn, error }
 */
export async function ensureLoggedIn(page, { timeoutMs = 120000, onEvent = null } = {}) {
  const say = (m) => { if (onEvent) { try { onEvent(m); } catch {} } };

  await page.bringToFront().catch(() => {});

  // PAGINA MORTA PRIMEIRO — antes de qualquer outra pergunta.
  //
  // `isLoggedIn` so procura o botao "Sign in" e conclui "logado" quando nao o
  // encontra. Numa tela de erro do Chrome nao existe botao nenhum, entao ela
  // responde LOGADO para um cadaver. Em 12/08/2026 isso fez o trade seguir
  // feliz para um painel inexistente e falhar la na frente como "nao achei o
  // campo de valor" — tres sintomas (palco preto, falso "already signed in",
  // campo sumido) que eram uma coisa so: a pagina nao carregou.
  if (await pareceMorta(page)) {
    say("the page is blank — reloading it");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await sleep(8000);
    if (await clickByText(page, /^(reject all|recusar tudo)$/)) await sleep(1500);
    if (await pareceMorta(page)) return { ok: false, error: "a pagina nao carrega" };
    say("the page came back");
  }

  if (await isLoggedIn(page).catch(() => false)) return { ok: true, alreadyLoggedIn: true };

  // O banner de cookies engole o proximo clique se nao sair da frente.
  if (await clickByText(page, /^(reject all|recusar tudo)$/)) await sleep(2000);

  if (!(await clickByText(page, /^(sign in|log in)$/))) {
    return { ok: false, error: "nao achei o botao de login" };
  }
  say("abriu o modal de login");
  await sleep(6000);

  // Pagina caida depois do clique: recarrega e tenta UMA vez. Vale sempre, seja
  // qual for a causa — deixar o espectador diante de uma tela preta e pior do
  // que qualquer erro que a gente possa mostrar.
  if (await pareceMorta(page)) {
    say("the page went blank — reloading it");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await sleep(8000);
    if (await clickByText(page, /^(reject all|recusar tudo)$/)) await sleep(1500);
    if (await isLoggedIn(page).catch(() => false)) return { ok: true, alreadyLoggedIn: false };
    if (!(await clickByText(page, /^(sign in|log in)$/))) {
      return { ok: false, error: "a pagina caiu e nao voltou" };
    }
    await sleep(6000);
  }

  // O item da carteira e um BUTTON com um SPAN dentro: clicar por COORDENADA na
  // folha e o que funciona. Clique por texto no container nao abre nada.
  const spot = await walletSpot(page, "phantom");
  if (!spot) {
    // A falha tem que se explicar sozinha. Sem isto, "wallet-not-detected" vira
    // uma rodada de adivinhacao por vez: da pra saber se a carteira foi
    // injetada, se o registro estourou, e o que o modal ESTA oferecendo.
    const d = await page.evaluate(() => ({
      solana: typeof window.solana !== "undefined",
      phantom: typeof window.phantom !== "undefined",
      registrada: typeof window.__arenaWallet !== "undefined",
      erroRegistro: window.__arenaRegisterError ?? null,
      // A primeira versao disto so listou os botoes e a resposta foi
      // ["Reload","Back"] — a tela de ERRO do Chrome, nao um modal. Ou seja: a
      // carteira estava certa e a PAGINA e que tinha morrido depois do clique.
      // Sem url/titulo/texto nao da pra saber qual erro; com, da.
      url: location.href,
      titulo: document.title,
      texto: (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 300),
      opcoes: [...document.querySelectorAll("button,[role=button],li,[role=option]")]
        .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
        .map((b) => (b.innerText || "").trim().replace(/\s+/g, " "))
        .filter((t) => t && t.length < 40).slice(0, 25),
    })).catch((e) => ({ evaluateFalhou: String(e).slice(0, 200) }));
    // O diagnostico e para o OPERADOR, no terminal — nunca para o palco. Quem
    // assiste ve uma pessoa tentando entrar numa conta, nao um dump de JSON.
    console.log(`[diag ${new Date().toISOString()}] carteira nao apareceu no modal: ${JSON.stringify(d)}`);
    say("the wallet did not show up in the list");
    return { ok: false, error: "wallet-not-detected", diag: d };
  }
  await page.mouse.click(spot.x, spot.y);
  say("escolheu a carteira");

  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    await sleep(2000);
    if (await isLoggedIn(page).catch(() => false)) return { ok: true, alreadyLoggedIn: false };
  }
  return { ok: false, error: "login-nao-concluiu" };
}

/**
 * Garante que o agente esta logado na pump.fun. Idempotente: se a sessao do
 * perfil ainda vale, so confirma e volta.
 *
 * @returns { ok, address, alreadyLoggedIn, signedMessage, error }
 */
export async function login(agentId, { mint, timeoutMs = 120000, onEvent = null } = {}) {
  const envKey = KEYPAIR_ENV[agentId];
  if (!envKey) return { ok: false, error: `agente desconhecido: ${agentId}` };
  if (!String(process.env[envKey] ?? "").trim()) {
    return { ok: false, error: `${envKey} nao esta configurada no painel` };
  }

  const say = (m) => { if (onEvent) { try { onEvent(m); } catch {} } };

  let wallet;
  try { wallet = load(envKey); }
  catch (e) { return { ok: false, error: `keypair invalida: ${e.message}` }; }

  const page = await browser.identityPage(agentId);
  const pedidos = [];
  const respostas = [];

  page.on("response", (r) => {
    const u = r.url();
    if (/privy\.io\/api|auth|verify|session|token/i.test(u) && !/\.(js|css|png|svg|woff)/i.test(u)) {
      respostas.push({ status: r.status(), method: r.request().method(), url: u.slice(0, 140) });
    }
  });

  await attachWallet(page, wallet, {
    mode: "sign",
    onSignRequest: (texto) => {
      pedidos.push(texto);
      say(`o site pediu para assinar: ${redact(String(texto)).slice(0, 90)}`);
    },
  });

  const url = `https://pump.fun/coin/${mint}`;
  await page.bringToFront().catch(() => {});
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await sleep(10000);

  const texto = await page.evaluate(() => (document.body?.innerText ?? "").slice(0, 200));
  if (/just a moment|checking your browser|verify you are human/i.test(texto)) {
    return { ok: false, error: "cloudflare", address: wallet.address };
  }

  const conn = await ensureLoggedIn(page, { timeoutMs, onEvent });
  if (conn.ok && conn.alreadyLoggedIn) {
    sessions.set(agentId, { address: wallet.address, at: Date.now() });
    return { ok: true, address: wallet.address, alreadyLoggedIn: true };
  }
  if (!conn.ok) {
    return {
      ok: false,
      address: wallet.address,
      // "login-nao-concluiu" fica mais util com o que a pagina pediu (ou nao):
      // assinou e travou depois e um problema diferente de nem terem pedido.
      error: conn.error === "login-nao-concluiu"
        ? (pedidos.length ? "assinou mas o login nao concluiu" : "o site nao pediu assinatura")
        : conn.error,
      signedMessage: pedidos[0] ?? null,
    };
  }

  // Guarda o token de sessao no cofre de segredos ANTES de qualquer coisa
  // tocar nele — a partir daqui ele nao aparece em log nem em prompt.
  try {
    const token = await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) {
        const v = localStorage.getItem(k) ?? "";
        if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(v) && v.length > 40) return v;
      }
      return null;
    });
    if (token) addRuntimeSecret(token, `PUMP_TOKEN_${agentId.toUpperCase()}`);
  } catch { /* sem token visivel: a sessao vive no cookie do perfil */ }

  sessions.set(agentId, { address: wallet.address, at: Date.now() });
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(
      sessionFile(agentId),
      JSON.stringify({ address: wallet.address, at: Date.now() }, null, 2),
      { mode: 0o600 }
    );
  } catch { /* cache em disco e conveniencia, nao requisito */ }

  return { ok: true, address: wallet.address, signedMessage: pedidos[0] ?? null, respostas };
}

export function cached(agentId) {
  return sessions.get(agentId) ?? null;
}

// Define o nome de exibicao do agente no perfil da pump.fun.
export async function setProfileName(agentId, nome, { onEvent = null } = {}) {
  const say = (m) => { if (onEvent) { try { onEvent(m); } catch {} } };
  const page = await browser.identityPage(agentId);

  await page.bringToFront().catch(() => {});
  await page.goto("https://pump.fun/profile", { waitUntil: "domcontentloaded", timeout: 45000 });
  await sleep(6000);

  if (await clickByText(page, /^(reject all)$/)) await sleep(1500);
  const abriu = await clickByText(page, /^(edit profile|editar perfil|edit)$/);
  if (abriu) { say("abriu a edicao de perfil"); await sleep(3000); }

  // Campo de nome: procura por placeholder/label plausivel.
  const campo = await page.evaluateHandle(() => {
    const inputs = [...document.querySelectorAll("input,textarea")]
      .filter((i) => { const r = i.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    return inputs.find((i) => /name|username|nome|handle/i.test(
      `${i.getAttribute("placeholder") ?? ""} ${i.getAttribute("name") ?? ""} ${i.getAttribute("aria-label") ?? ""}`
    )) ?? inputs[0] ?? null;
  });
  const el = campo.asElement();
  if (!el) return { ok: false, error: "nao achei o campo de nome" };

  await el.click({ clickCount: 3 }).catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await el.type(nome, { delay: 60 }).catch(() => {});
  say(`digitou o nome "${nome}"`);
  await sleep(1000);

  const salvou = await clickByText(page, /^(save|salvar|update|confirm)$/);
  await sleep(4000);
  return { ok: salvou, error: salvou ? null : "nao achei o botao de salvar" };
}
