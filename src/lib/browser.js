// ============================================================================
// Navegador de verdade. Chromium via Puppeteer.
//
// Motivo de existir: fetch cru nao e como gente navega. Site moderno renderiza
// com JavaScript, e CDN devolve {"error":"not found"} para qualquer coisa que
// nao pareca navegador. Aqui o agente ve a MESMA pagina que o Michel veria no
// Chrome dele — e o palco tira screenshot disso para o espectador conferir.
//
// UM NAVEGADOR POR AGENTE, com perfil em disco. Nao e capricho: cada agente tem
// a propria carteira, entao sao identidades diferentes na mesma internet. Um
// Chromium compartilhado significa um cookie jar compartilhado — logar a Sable
// logaria o Rook como a mesma pessoa, e o segundo login sobrescreveria o
// primeiro. O perfil em disco tambem faz a sessao sobreviver a um restart.
//
// O navegador ANONIMO (sem perfil) continua existindo para leitura avulsa
// (`readPage`, `searchPage`): sem identidade, sem rastro, e mais barato.
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const PROFILES = path.join(ROOT, "src", "data", "profiles");

const SHARED = "__anon__"; // chave do navegador sem identidade
const browsers = new Map(); // chave -> Browser
const launching = new Map(); // chave -> Promise<Browser>

// ------------------------------- Browserbase ---------------------------------
// Navegadores REMOTOS (Chromium num datacenter dos EUA): IP americano de
// verdade, menos parede de anti-bot, e a maquina do Michel livre dos Chromium.
// LIGA quando as duas chaves existem no .env; sem elas (ou se a API deles
// falhar) cai SEMPRE no Chromium local — o show nunca para por causa disso.
//
// Identidade: cada agente ganha um "context" persistente (id guardado em
// src/data/browserbase-contexts.json) — cookies/sessoes sobrevivem entre
// sessoes remotas, o papel que o userDataDir cumpre no local. O navegador
// anonimo nao persiste nada, igual ao local.

const BB_API = "https://api.browserbase.com/v1";
const CTX_FILE = path.join(ROOT, "src", "data", "browserbase-contexts.json");
const bbEnabled = () =>
  !!(process.env.BROWSERBASE_API_KEY && process.env.BROWSERBASE_PROJECT_ID);

async function bbFetch(pathname, body) {
  const r = await fetch(`${BB_API}${pathname}`, {
    method: "POST",
    headers: {
      "x-bb-api-key": process.env.BROWSERBASE_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`browserbase ${pathname}: HTTP ${r.status} ${detail}`.slice(0, 240));
  }
  return r.json();
}

function loadCtxIds() {
  try { return JSON.parse(fs.readFileSync(CTX_FILE, "utf8")); } catch { return {}; }
}
function saveCtxIds(map) {
  try {
    fs.mkdirSync(path.dirname(CTX_FILE), { recursive: true });
    fs.writeFileSync(CTX_FILE, JSON.stringify(map, null, 2));
  } catch { /* sem disco, contexto novo na proxima — só perde login */ }
}

// Nome da variavel que crava o context de um agente: BROWSERBASE_CTX_SABLE etc.
const ctxEnvKey = (key) => `BROWSERBASE_CTX_${String(key).toUpperCase()}`;

async function bbContextId(key) {
  if (key === SHARED) return null; // leitura avulsa nao persiste identidade
  // CONTEXT CRAVADO POR VARIAVEL (13/08/2026). O id vinha so do arquivo em
  // src/data — que no Railway nasce vazio, entao o servidor criava um context
  // NOVO e o login feito aqui nunca chegava la. Com a variavel, a mesma
  // identidade (e os mesmos cookies) valem nas duas pontas: loga uma vez, de
  // onde for, e o navegador remoto sobe logado em qualquer lugar.
  const cravado = String(process.env[ctxEnvKey(key)] ?? "").trim();
  if (cravado) return cravado;
  const ids = loadCtxIds();
  if (ids[key]) return ids[key];
  const ctx = await bbFetch("/contexts", { projectId: process.env.BROWSERBASE_PROJECT_ID });
  ids[key] = ctx.id;
  saveCtxIds(ids);
  return ctx.id;
}

// Sessao remota por chave + a URL de LIVE VIEW dela (o navegador transmitido
// ao vivo, que o palco embute — e o "assistir navegar em tempo real" do
// claudius). Cache sincrono: publish() le sem await.
const bbSessions = new Map(); // key -> { id, liveUrl }

async function bbLaunch(key) {
  const ctxId = await bbContextId(key);
  const session = await bbFetch("/sessions", {
    projectId: process.env.BROWSERBASE_PROJECT_ID,
    ...(ctxId ? { browserSettings: { context: { id: ctxId, persist: true } } } : {}),
  });
  const ws = session.connectUrl ??
    `wss://connect.browserbase.com?apiKey=${process.env.BROWSERBASE_API_KEY}&sessionId=${session.id}`;
  const browser = await puppeteer.connect({ browserWSEndpoint: ws });
  bbSessions.set(key, { id: session.id, liveUrl: null });
  // Busca a URL do live view ja na criacao (uma chamada por sessao). Falhar
  // aqui nao derruba nada — o palco cai no screenshot.
  try {
    const r = await fetch(`${BB_API}/sessions/${session.id}/debug`, {
      headers: { "x-bb-api-key": process.env.BROWSERBASE_API_KEY },
    });
    if (r.ok) {
      const j = await r.json();
      const s = bbSessions.get(key);
      if (s) s.liveUrl = j.debuggerFullscreenUrl ?? j.debuggerUrl ?? null;
    }
  } catch { /* sem live view, com screenshot */ }
  return browser;
}

// O id do context em uso por este agente — e ele que carrega o login entre
// sessoes remotas. Serve ao `scripts/login-remoto.js`, que precisa dizer qual
// valor cravar no Railway depois que a pessoa logou.
export function contextIdFor(key) {
  return String(process.env[ctxEnvKey(key)] ?? "").trim() || loadCtxIds()[key] || null;
}

// URL de live view da sessao ATIVA desta chave (null = sem live: local, sessao
// morta ou dormindo). Sincrono de proposito — publish() chama a cada snapshot.
export function liveViewFor(key) {
  const b = browsers.get(key);
  if (!b || !b.connected) return null;
  return bbSessions.get(key)?.liveUrl ?? null;
}

// Mira o live view NA ABA DO AGENTE. O link da sessao aponta pro primeiro alvo
// (aba em branco) — dava tela branca no palco. O /debug lista as paginas; a
// gente casa pela URL atual da aba e guarda o link DAQUELA pagina. O id da
// pagina e estavel entre navegacoes da mesma aba, entao o iframe nao remonta.
async function updateLiveView(key) {
  if (!bbEnabled()) return;
  const s = bbSessions.get(key);
  const page = agentPages.get(key);
  if (!s || !page || page.isClosed()) return;
  const atual = page.url();
  try {
    const r = await fetch(`${BB_API}/sessions/${s.id}/debug`, {
      headers: { "x-bb-api-key": process.env.BROWSERBASE_API_KEY },
    });
    if (!r.ok) return;
    const j = await r.json();
    const pages = j.pages ?? [];
    // 1) a aba com a URL exata do agente; 2) QUALQUER aba que nao seja a
    // about:blank inicial. O passo 2 e o que salva: a URL do Puppeteer e a do
    // /debug divergem por um instante durante a navegacao, e antes disso a
    // falha era permanente — o link ficava preso na aba em branco (tela PRETA)
    // porque o fallback so agia quando ainda nao havia link nenhum.
    const hit = pages.find((p) => p.url === atual)
      ?? pages.find((p) => p.url && p.url !== "about:blank");
    if (hit?.debuggerFullscreenUrl) s.liveUrl = hit.debuggerFullscreenUrl;
    else if (!s.liveUrl) s.liveUrl = j.debuggerFullscreenUrl ?? null;
  } catch { /* live view e cosmetico — nunca derruba a acao */ }
}

function profileDir(key) {
  return path.join(PROFILES, key.replace(/[^a-z0-9_-]/gi, "_"));
}

// O stop do painel mata a arvore com `taskkill /T /F`. Isso deixa o perfil
// marcado como "Crashed" e um SingletonLock pendurado — o proximo launch ou
// recusa, ou abre a barra de "restaurar paginas". Limpar antes de subir.
function sanitizeProfile(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      fs.rmSync(path.join(dir, f), { force: true });
    }
    const prefs = path.join(dir, "Default", "Preferences");
    if (fs.existsSync(prefs)) {
      const j = JSON.parse(fs.readFileSync(prefs, "utf8"));
      if (j?.profile?.exit_type && j.profile.exit_type !== "Normal") {
        j.profile.exit_type = "Normal";
        j.profile.exited_cleanly = true;
        fs.writeFileSync(prefs, JSON.stringify(j));
      }
    }
  } catch { /* perfil novo ou Preferences ilegivel: seguir e deixar o Chromium decidir */ }
}

function launchOptions(key) {
  const args = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    // Tira o sinal mais obvio de automacao. Nao e disfarce: e nao carregar
    // uma bandeira que faz CDN tratar o agente como ataque.
    "--disable-blink-features=AutomationControlled",
    // Os agentes vivem em INGLES (publico-alvo e anglofono): a maquina do
    // Michel e pt-BR e sem isto sites e desafios de verificacao vinham em
    // portugues no palco. Define UI do Chromium e navigator.language.
    "--lang=en-US",
  ];

  // Perfil de identidade: janela de verdade (headless leva desafio de CDN com
  // muito mais frequencia), posicionada fora da area visivel do monitor —
  // decisao do Michel: autonomo, e sem janela na cara dele.
  const headful = key !== SHARED && process.env.BROWSER_HEADLESS !== "1";
  if (headful) args.push("--window-position=-32000,-32000", "--window-size=1280,900");

  return {
    headless: !headful,
    args,
    ...(key === SHARED ? {} : { userDataDir: profileDir(key) }),
  };
}

// Uma instancia por chave, ligada sob demanda. Se o Chromium (ou a sessao
// remota) morrer, religa — com Browserbase, sessao nova + mesmo context.
async function getBrowser(key = SHARED) {
  const cur = browsers.get(key);
  if (cur && cur.connected) return cur;
  if (!launching.has(key)) {
    const boot = async () => {
      if (bbEnabled()) {
        try {
          return await bbLaunch(key);
        } catch (e) {
          // Browserbase fora do ar nao pode parar o show: cai pro local e avisa.
          console.error(`[browser] browserbase falhou (${String(e.message).slice(0, 160)}) — usando Chromium local`);
        }
      }
      if (key !== SHARED) sanitizeProfile(profileDir(key));
      return puppeteer.launch(launchOptions(key));
    };
    const p = boot()
      .then((b) => {
        browsers.set(key, b);
        launching.delete(key);
        return b;
      })
      .catch((e) => {
        launching.delete(key);
        // Erro tipico: outro engine ja rodando com o mesmo perfil.
        if (/ProcessSingleton|SingletonLock|profile/i.test(String(e.message))) {
          throw new Error(
            `perfil "${key}" ja esta em uso — ha outro engine rodando? (${e.message})`
          );
        }
        throw e;
      });
    launching.set(key, p);
  }
  return launching.get(key);
}

async function newPage(key = SHARED) {
  const b = await getBrowser(key);
  const page = await b.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  // O UA do Chromium headless anuncia "HeadlessChrome" — troca pelo normal,
  // senao metade dos sites trata como bot e volta o problema que viemos resolver.
  const ua = (await b.userAgent()).replace("HeadlessChrome", "Chrome");
  await page.setUserAgent(ua);
  // en-US de verdade: o Accept-Language e o sinal que a maioria dos sites usa
  // pra escolher o idioma (a flag --lang sozinha nao muda o header), e o fuso
  // americano reforca o sinal "EUA" pra quem geolocaliza pelo relogio.
  // Ressalva: o IP continua brasileiro — site teimoso que geolocaliza por IP
  // (ex.: Google) ainda pode servir pt; a cura completa e proxy/hospedagem nos
  // EUA, decisao de launch.
  await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
  await page.emulateTimezone("America/New_York").catch(() => {});
  // Um `alert`/`confirm` trava o renderer inteiro e o Puppeteer NAO dispensa
  // sozinho — todo `evaluate` seguinte estoura em timeout. Ja custou um debug.
  page.on("dialog", (d) => { d.dismiss().catch(() => {}); });
  return page;
}

async function gotoAndSettle(page, url) {
  // domcontentloaded + janela curta de rede ociosa, em vez de networkidle2:
  // pagina com websocket/grafico ao vivo NUNCA assenta e estourava os 25s de
  // timeout — cada leitura levava meio minuto e o show ficava lento.
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 12000 });
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 3500 }).catch(() => {});
  // Respiro curto para a SPA pintar o que acabou de chegar.
  await new Promise((r) => setTimeout(r, 600));
  return resp ? resp.status() : 200;
}

// Abre a pagina como um navegador abre, espera a rede assentar e devolve o
// texto RENDERIZADO (innerText, nao HTML cru). Se shotPath vier, salva um
// screenshot do que estava na tela — e isso que o palco mostra.
export async function readPage(url, { maxChars = 6000, shotPath = null } = {}) {
  const page = await newPage();
  try {
    const status = await gotoAndSettle(page, url);
    const text = (await page.evaluate(() => document.body?.innerText ?? ""))
      .replace(/\s+/g, " ")
      .trim();
    if (shotPath) {
      await page.screenshot({ path: shotPath, type: "jpeg", quality: 70 }).catch(() => {});
    }
    return { url: page.url(), status, text: text.slice(0, maxChars) };
  } finally {
    await page.close().catch(() => {});
  }
}

// ------------------------- Sessao de navegacao por agente ---------------------
//
// Cada agente tem UMA aba de navegacao que fica aberta entre turnos — como uma
// pessoa deixa a aba aberta. E o que permite scrollar, clicar e voltar em vez de
// so "abrir e fotografar". Essa aba e RENAVEGADA todo turno.
//
// E tem uma SEGUNDA aba, a de identidade, que o agente nunca dirige: e onde a
// sessao logada fica parada. Se a sessao morasse na aba de navegacao, o proximo
// `research` a destruiria.

const agentPages = new Map();
const identityPages = new Map();

// Exportada: o `livetrade` precisa da MESMA aba que o palco transmite — se ele
// abrisse outra, o espectador veria a aba antiga enquanto a compra acontece
// fora da tela, que e exatamente o que nao pode acontecer.
export async function getAgentPage(id) {
  const cur = agentPages.get(id);
  if (cur && !cur.isClosed() && cur.browser().connected) return cur;
  const page = await newPage(id); // navegador do proprio agente
  agentPages.set(id, page);
  return page;
}

// A aba de identidade do agente. Mesmo perfil da aba de navegacao (mesmo cookie
// jar), mas separada: quem loga aqui continua logado enquanto o agente navega.
export async function identityPage(id) {
  const cur = identityPages.get(id);
  if (cur && !cur.isClosed() && cur.browser().connected) return cur;
  const page = await newPage(id);
  identityPages.set(id, page);
  return page;
}

// O que o agente VE agora: texto do viewport (nao da pagina inteira — rolar e
// que revela o resto), o que da pra clicar na tela, e onde o scroll esta.
async function view(page, { maxChars = 3000, shotPath = null } = {}) {
  await new Promise((r) => setTimeout(r, 350));
  const data = await page.evaluate(() => {
    const vh = innerHeight, vw = innerWidth;
    const inView = (r) =>
      r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw && r.width > 0 && r.height > 0;
    const parts = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = n.textContent.replace(/\s+/g, " ").trim();
      if (!t) continue;
      const el = n.parentElement;
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      if (inView(el.getBoundingClientRect())) parts.push(t);
    }
    const links = [];
    for (const el of document.querySelectorAll("a, button, [role=button], [role=link], [role=tab]")) {
      if (!inView(el.getBoundingClientRect())) continue;
      const t = (el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      if (t && t.length <= 60 && !links.includes(t)) links.push(t);
      if (links.length >= 30) break;
    }
    const max = Math.max(document.documentElement.scrollHeight - vh, 1);
    return {
      text: parts.join(" "),
      links,
      scrollPct: Math.min(100, Math.round((scrollY / max) * 100)),
      atEnd: scrollY >= max - 4,
    };
  });
  if (shotPath) {
    await page.screenshot({ path: shotPath, type: "jpeg", quality: 70 }).catch(() => {});
  }
  return {
    url: page.url(),
    text: data.text.slice(0, maxChars),
    links: data.links,
    scrollPct: data.scrollPct,
    atEnd: data.atEnd,
  };
}

// Abre uma URL na aba do agente e devolve a primeira vista.
export async function openPage(id, url, opts = {}) {
  const page = await getAgentPage(id);
  const status = await gotoAndSettle(page, url);
  updateLiveView(id).catch(() => {});
  return { status, ...(await view(page, opts)) };
}

// Um movimento de navegacao na aba do agente: "scroll down" | "scroll up" |
// "click: <texto do link>" | "back". Devolve a nova vista.
export async function browseMove(id, move, opts = {}) {
  const page = agentPages.get(id);
  if (!page || page.isClosed()) throw new Error("no page open — research a URL first");
  const m = String(move ?? "").trim();

  if (/^scroll\s+(down|up)$/i.test(m)) {
    const dir = /down$/i.test(m) ? 1 : -1;
    await page.evaluate((d) => scrollBy({ top: d * innerHeight * 0.85, behavior: "instant" }), dir);
  } else if (/^back$/i.test(m)) {
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
  } else if (/^click[:\s]/i.test(m)) {
    const label = m.replace(/^click[:\s]+/i, "").trim();
    if (!label) throw new Error("click needs the link text");
    const handle = await page.evaluateHandle((txt) => {
      const want = txt.toLowerCase();
      const all = [...document.querySelectorAll("a, button, [role=button], [role=link], [role=tab]")];
      const vis = all.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const label = (el) => (el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().toLowerCase();
      const el = vis.find((e) => label(e) === want) ?? vis.find((e) => label(e).includes(want));
      // target=_blank abriria outra aba que ninguem esta vendo — navega na mesma.
      if (el && el.tagName === "A") el.target = "";
      return el ?? null;
    }, label);
    const el = handle.asElement();
    if (!el) throw new Error(`nothing on this page reads "${label}"`);
    await page.evaluate((e) => e.scrollIntoView({ block: "center", behavior: "instant" }), el);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {}),
      el.click(),
    ]);
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 3000 }).catch(() => {});
  } else {
    throw new Error(`unknown move "${m}" — use "scroll down", "scroll up", "click: <text>" or "back"`);
  }
  updateLiveView(id).catch(() => {});
  return { status: null, ...(await view(page, opts)) };
}

// Busca no DuckDuckGo pela pagina de resultados de verdade, extraindo os links
// do DOM renderizado. Mesmo formato do search antigo: [{title, url}].
// `key` de agente: a busca roda NA ABA PERSISTENTE dele — e o que o live view
// transmite, e a pagina de resultados FICA aberta (da pra `browse` clicar num
// resultado depois, como gente). Sem key (anonimo): aba descartavel, como antes.
export async function searchPage(query, max = 8, { shotPath = null, key = SHARED } = {}) {
  const isAgent = key !== SHARED && key !== undefined;
  const page = isAgent ? await getAgentPage(key) : await newPage();
  try {
    // kl=us-en trava a REGIAO da busca em EUA/ingles — sem isso o DDG
    // geolocaliza pelo IP (Brasil) e mistura resultado em portugues.
    await page.goto(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&ia=web&kl=us-en`, {
      waitUntil: "domcontentloaded",
      timeout: 12000,
    });
    await page.waitForSelector('a[data-testid="result-title-a"], a.result__a', { timeout: 6000 })
      .catch(() => {});
    // A pagina de resultados E uma pagina — o palco mostra ela como qualquer
    // outra. Buscar era o unico movimento de navegacao que ficava invisivel.
    if (shotPath) {
      await page.screenshot({ path: shotPath, type: "jpeg", quality: 70 }).catch(() => {});
    }
    const hits = await page.evaluate((limit) => {
      const links = document.querySelectorAll('a[data-testid="result-title-a"], a.result__a');
      const out = [];
      for (const a of links) {
        const title = a.textContent.replace(/\s+/g, " ").trim();
        const url = a.href;
        if (title && /^https?:\/\//.test(url)) out.push({ title, url });
        if (out.length >= limit) break;
      }
      return out;
    }, max);
    // Aba do agente: fica ABERTA nos resultados (live view transmite; `browse`
    // pode clicar). E mira a transmissao nesta aba — era a causa da tela branca.
    if (isAgent) updateLiveView(key).catch(() => {});
    return hits;
  } finally {
    if (!isAgent) await page.close().catch(() => {});
  }
}

export async function closeBrowser() {
  for (const [key, b] of browsers) {
    await b.close().catch(() => {});
    browsers.delete(key);
  }
  agentPages.clear();
  identityPages.clear();
}

// Os cookies do perfil do agente para um site. E assim que a sessao logada no
// navegador vira uma conexao autenticada fora dele: a pump.fun guarda o login
// no cookie, nao num token que desse para copiar.
export async function cookiesFor(agentId, url = "https://pump.fun") {
  const page = await identityPage(agentId);
  const cookies = await page.cookies(url);
  if (!cookies?.length) return null;
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

// Quais navegadores estao de pe (diagnostico, e o teste da Fase 1 usa isto).
export function browserInfo() {
  return [...browsers.entries()].map(([key, b]) => ({
    key,
    connected: b.connected,
    profile: key === SHARED ? null : profileDir(key),
  }));
}
