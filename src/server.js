// ============================================================================
// Palco local do Agent Arena — http://localhost:8432
//
// Mesmo padrao dos irmaos: so modulos nativos do Node, config num .env local,
// motor como processo filho, atualizacao por polling, aceita conexao apenas da
// propria maquina. As linhas "@STATE {json}" do motor viram a tela; o resto do
// stdout vira log.
// ============================================================================

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, exec } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
// Mesmo arquivo (e mesmo override) que o motor usa para publicar o snapshot.
const STATE_FILE = process.env.STATE_FILE || path.join(ROOT, "src", "data", "state.json");
// ENV_FILE configuravel: no Railway aponta pro VOLUME (ex.: /app/src/data/.env)
// para o que o painel salvar sobreviver a redeploy. Local: .env na raiz, como sempre.
const ENV_FILE = process.env.ENV_FILE || path.join(ROOT, ".env");
const ENV_EXAMPLE = path.join(ROOT, ".env.example");
const PANEL_HTML = path.join(ROOT, "public", "index.html"); // sala de controle (/console)
const STAGE_HTML = path.join(ROOT, "public", "stage.html"); // o palco publico
const STORE_HTML = path.join(ROOT, "public", "store.html"); // a loja (x402)
const SITE_HTML = path.join(ROOT, "public", "site.html");   // o SITE publico (/)
const JOURNAL_HTML = path.join(ROOT, "public", "journal.html"); // arquivo dos journals
const MEMORY_HTML = path.join(ROOT, "public", "memory.html");   // memoria publica
// PURCHASES_FILE: override para testes (probe usa arquivo descartavel).
const PURCHASES_FILE = process.env.PURCHASES_FILE || path.join(ROOT, "src", "data", "purchases.json");
// Configuravel so para poder subir uma instancia de teste em paralelo sem
// derrubar a que voce esta usando. O padrao continua sendo 8432.
const PORT = Number(process.env.PORT) || 8432;

import { SECRET_KEYS as SECRET_LIST, PUBLIC_AGENT_KEYS, redact } from "./lib/secrets.js";
import * as pieces from "./lib/pieces.js";
import { verifyPayment, USDC_MINT } from "./lib/wallet.js";
import * as market from "./lib/market.js";

const KEYS = [
  "PROJECT_NAME", "PROJECT_TAGLINE",
  "ANTHROPIC_API_KEY", "MODEL", "EFFORT", "SHIFTS",
  ...SECRET_LIST.filter((k) => k !== "ANTHROPIC_API_KEY"),
  ...PUBLIC_AGENT_KEYS,
  "TICK_SECONDS", "TICKS_PER_DAY",
  "DAY_HOURS", "REST_ENABLED", "ACTIVE_START_HOUR", "ACTIVE_END_HOUR", "TRADING_ENABLED",
  "WORK_RATE_USD", "WORK_GIGS_PER_DAY",
  "RUGCHECK_RATE_USD", "RUGCHECK_PER_DAY",
  "SELL_RATE_USD", "SELL_PER_DAY",
  "BOUNTY_RATE_USD", "BOUNTY_PER_DAY",
  "COMMISSION_RUGCHECK_USD", "COMMISSION_ANALYSIS_USD",
  "LIVE_CHAT_MINT", "OWNER_WALLET", "CHAT_MSGS_PER_TURN",
  "ROOM_POST_ENABLED", "ROOM_POST_COOLDOWN_TICKS",
  "TREASURY_USD", "SEASON_START_USD", "RENT_ENABLED", "RENT_MULTIPLIER",
  "HOUSE_BASE_DAILY_USD", "SCHEDULE", "WORLD_EVENT_EVERY_TICKS", "WORK_HOURS_PER_DAY",
  "MAX_TRADE_PCT_SABLE", "MAX_TRADE_PCT_ROOK",
  "DAILY_LOSS_LIMIT_PCT",
  "INTERVENTIONS_PER_DAY", "CONVICTION_OVERRIDE", "REBUTTAL_TICKS",
  "MIN_POOL_USD", "MAX_POOL_PCT", "X_ENABLED",
  "SOLANA_RPC", // ADMIN_TOKEN e BROWSERBASE_* ja entram via SECRET_LIST acima
  // EXECUCAO REAL e o RECADO DA CASA. Nao ha campo no formulario para eles (sao
  // decisao de .env, nao botao de tela), mas PRECISAM estar aqui: writeConfig
  // regrava o arquivo inteiro a partir desta lista, entao chave de fora e chave
  // APAGADA no primeiro Save. Sem isto, salvar qualquer coisa no painel
  // desligava o trade real em silencio no proximo start (REAL_TRADING volta ao
  // padrao false) e apagava a voz da casa.
  "REAL_TRADING", "LIVE_TRADE", "MAX_REAL_TRADE_USD", "HOUSE_NOTE",
];
// Campo secreto nunca volta em texto no /api/state — vira "__set__" ou "".
// Vazio no POST significa "mantenha o valor atual", entao dá para salvar o
// resto do formulario sem redigitar chave nenhuma.
const SECRET_KEYS = new Set(SECRET_LIST);

// ----------------------------- helpers do .env -------------------------------

function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function readConfig() {
  // Ordem: .env.example < variaveis de AMBIENTE < .env. No Railway nao existe
  // .env no deploy — as chaves chegam por variavel de ambiente; o .env (no
  // volume, via ENV_FILE) e o que o painel escreve, entao ajuste ao vivo vence.
  const fromEnv = {};
  for (const k of KEYS) {
    const v = process.env[k];
    if (v !== undefined && String(v).trim() !== "") fromEnv[k] = v;
  }
  return { ...parseEnvFile(ENV_EXAMPLE), ...fromEnv, ...parseEnvFile(ENV_FILE) };
}

function writeConfig(updates) {
  const current = readConfig();
  for (const k of KEYS) {
    if (!(k in updates)) continue;
    const v = String(updates[k] ?? "").trim();
    // Campo secreto vazio = "manter o valor atual"
    if (SECRET_KEYS.has(k) && v === "") continue;
    current[k] = v;
  }
  fs.writeFileSync(ENV_FILE, KEYS.map((k) => `${k}=${current[k] ?? ""}`).join("\n") + "\n", { mode: 0o600 });
  return current;
}

// ----------------------------- processo do motor -----------------------------

let child = null;
let logLines = [];
let logSeq = 0;
let lastState = null;

function pushLog(text) {
  // Cinto e suspensario: o engine ja redige o que escreve, mas ele e um processo
  // filho que pode ser trocado, e este log e o que aparece na tela do painel.
  // O `.env` daqui e a fonte dos valores — o engine tem os mesmos mais os de
  // runtime, que ele proprio ja mascarou antes de imprimir.
  const secrets = [];
  const cfg = readConfig();
  for (const k of SECRET_KEYS) {
    const v = String(cfg[k] ?? "").trim();
    if (v.length >= 12) secrets.push({ key: k, value: v });
  }

  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const i = line.indexOf("@STATE ");
    if (i >= 0) {
      try { lastState = JSON.parse(line.slice(i + 7)); } catch { /* linha cortada */ }
      continue;
    }
    logLines.push({ n: ++logSeq, t: redact(line, secrets) });
  }
  if (logLines.length > 800) logLines = logLines.slice(-500);
}

function startEngine() {
  if (child) return { ok: false, error: "The arena is already running. Stop it first." };
  const cfg = readConfig();
  if (!cfg.ANTHROPIC_API_KEY) return { ok: false, error: "Set your Anthropic API key first." };

  logLines = [];
  lastState = null;
  child = spawn(process.execPath, [path.join(ROOT, "src", "engine.js")], {
    cwd: ROOT,
    env: { ...process.env, ...cfg },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => pushLog(d.toString()));
  child.stderr.on("data", (d) => pushLog(d.toString()));
  child.on("exit", (code) => {
    pushLog(`— arena stopped (exit ${code}) —`);
    child = null;
  });
  pushLog("— arena starting —");
  return { ok: true };
}

function stopEngine() {
  if (!child) return { ok: false, error: "Not running." };
  // O engine agora carrega um Chromium filho (navegacao real). No Windows,
  // kill() derruba so o node e deixaria o Chromium orfao — mata a arvore toda.
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill();
  }
  return { ok: true };
}

// -------------------------------- servidor -----------------------------------

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
  });
}

// ------------------------------- loja (x402) --------------------------------
// O comprador paga da carteira DELE direto pro endereco do agente; aqui so se
// verifica a transacao on-chain (leitura pura) e entrega o conteudo. O ledger
// purchases.json e escrito SO por este processo; o engine apenas le.

// O server nao carrega dotenv; o RPC configurado no .env precisa chegar ao
// wallet.js (que le process.env a cada chamada — por isso funciona pos-import).
{
  const rpcCfg = (readConfig().SOLANA_RPC || "").trim();
  if (rpcCfg && !process.env.SOLANA_RPC) process.env.SOLANA_RPC = rpcCfg;
}

function loadPurchases() {
  try {
    const j = JSON.parse(fs.readFileSync(PURCHASES_FILE, "utf8"));
    return Array.isArray(j.purchases) ? j.purchases : [];
  } catch { return []; }
}
function savePurchases(list) {
  try {
    fs.mkdirSync(path.dirname(PURCHASES_FILE), { recursive: true });
    fs.writeFileSync(PURCHASES_FILE, JSON.stringify({ purchases: list.slice(-500) }, null, 2));
  } catch { /* disco cheio nao pode derrubar a loja */ }
}

// ------------------------------ encomendas ----------------------------------
// O espectador PAGA ADIANTADO (cripto real, direto pro agente) e encomenda um
// trabalho sob medida. O ledger e escrito SO por este processo; o engine le e
// marca entregas em commissions-done.json (arquivo proprio dele).

const COMMISSIONS_FILE = process.env.COMMISSIONS_FILE || path.join(ROOT, "src", "data", "commissions.json");
const COMMISSIONS_DONE_FILE = process.env.COMMISSIONS_DONE_FILE || path.join(ROOT, "src", "data", "commissions-done.json");

function loadCommissions() {
  try {
    const j = JSON.parse(fs.readFileSync(COMMISSIONS_FILE, "utf8"));
    return Array.isArray(j.commissions) ? j.commissions : [];
  } catch { return []; }
}
function saveCommissions(list) {
  try {
    fs.mkdirSync(path.dirname(COMMISSIONS_FILE), { recursive: true });
    fs.writeFileSync(COMMISSIONS_FILE, JSON.stringify({ commissions: list.slice(-300) }, null, 2));
  } catch { /* disco cheio nao pode derrubar o balcao */ }
}
function loadCommissionsDone() {
  try {
    const j = JSON.parse(fs.readFileSync(COMMISSIONS_DONE_FILE, "utf8"));
    return Array.isArray(j.done) ? j.done : [];
  } catch { return []; }
}
function commissionPriceUsd(kind) {
  const cfg = readConfig();
  const n = (k, d) => { const v = Number(cfg[k]); return Number.isFinite(v) && v > 0 ? v : d; };
  return kind === "rugcheck" ? n("COMMISSION_RUGCHECK_USD", 5) : n("COMMISSION_ANALYSIS_USD", 3);
}

// Preco do SOL para converter pagamento em SOL -> USD. Cache de 5 min, mesmo
// padrao do engine.
let solCache = { usd: 0, at: 0 };
async function solPriceUsd() {
  if (Date.now() - solCache.at < 300000 && solCache.usd > 0) return solCache.usd;
  try {
    const mercados = await market.jupMarkets();
    const sol = mercados.find((m) => m.coin === "SOL");
    if (sol?.mark > 0) solCache = { usd: sol.mark, at: Date.now() };
  } catch { /* fica com o ultimo preco conhecido */ }
  return solCache.usd || 0;
}

// Endereco publico de quem RECEBE a venda: a carteira do agente autor.
function agentPayAddress(agentId) {
  const cfg = readConfig();
  return agentId === "sable" ? (cfg.SABLE_SOL_PUBKEY || "").trim()
    : agentId === "rook" ? (cfg.ROOK_SOL_PUBKEY || "").trim()
    : "";
}

// Rotas de ADMIN (config/start/stop/proxy): quando ADMIN_TOKEN esta setado,
// exigem o header x-admin-token. OBRIGATORIO antes de expor o server na
// internet — hoje o bind e loopback, mas a loja nasce pronta pro publico.
function adminBlocked(req, res) {
  const token = (readConfig().ADMIN_TOKEN || "").trim();
  if (!token) return false; // sem token configurado = comportamento local atual
  if (req.headers["x-admin-token"] === token) return false;
  send(res, 401, { error: "admin token required" });
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // A porta da frente e o SITE (descricao + docs + transmissao). O painel de
  // controle mudou pra /console — a home de um projeto publico nao pode ser a
  // sala de comando.
  if (url.pathname === "/" || url.pathname === "/index.html") {
    if (fs.existsSync(SITE_HTML)) {
      // og:image e og:url precisam de URL ABSOLUTA (robo de rede social nao
      // roda JS nem resolve caminho relativo). Em vez de cravar o dominio no
      // HTML, trocamos __ORIGIN__ pelo host de onde a pagina foi pedida — assim
      // o cartao continua certo quando o dominio proprio entrar no lugar do
      // *.up.railway.app, sem tocar no arquivo.
      const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
      const host = (req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`).split(",")[0].trim();
      const html = fs.readFileSync(SITE_HTML, "utf8").replaceAll("__ORIGIN__", `${proto}://${host}`);
      return send(res, 200, html, "text/html; charset=utf-8");
    }
    return send(res, 200, fs.readFileSync(PANEL_HTML, "utf8"), "text/html; charset=utf-8");
  }

  if (url.pathname === "/console") {
    return send(res, 200, fs.readFileSync(PANEL_HTML, "utf8"), "text/html; charset=utf-8");
  }

  // O ARQUIVO PUBLICO (estilo claudius): /journal = tudo que eles escreveram,
  // /memory = o que carregam (licoes, metas, persona). Paginas estaticas que
  // leem /api/archive e /api/state.
  if (url.pathname === "/journal") {
    return send(res, 200, fs.readFileSync(JOURNAL_HTML, "utf8"), "text/html; charset=utf-8");
  }
  if (url.pathname === "/memory") {
    return send(res, 200, fs.readFileSync(MEMORY_HTML, "utf8"), "text/html; charset=utf-8");
  }

  // A vida arquivada (JSONL que o engine appenda). Filtros: kinds=say,aside,…
  // agent=sable|rook · limit (max 500, das mais recentes). Le do DISCO —
  // funciona com o engine parado; o arquivo e a memoria que sobrevive.
  if (url.pathname === "/api/archive") {
    const file = process.env.ARCHIVE_FILE || path.join(ROOT, "src", "data", "archive.jsonl");
    const kinds = (url.searchParams.get("kinds") ?? "").split(",").filter(Boolean);
    const agent = url.searchParams.get("agent") ?? "";
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200));
    let lines = [];
    try { lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean); } catch { /* sem arquivo ainda */ }
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      let e; try { e = JSON.parse(lines[i]); } catch { continue; }
      if (kinds.length && !kinds.includes(e.kind)) continue;
      if (agent && e.agent !== agent) continue;
      out.push(e);
    }
    return send(res, 200, { total: lines.length, entries: out });
  }

  // O palco: mesma fonte de dados, sem nenhum controle. E esta pagina que o
  // OBS captura — por isso nao expoe config nem botao de parar.
  if (url.pathname === "/stage") {
    return send(res, 200, fs.readFileSync(STAGE_HTML, "utf8"), "text/html; charset=utf-8");
  }

  // A LOJA. Vitrine publica; conteudo completo so depois de pagamento
  // verificado on-chain. Nenhuma rota daqui exige admin — e feita pro publico.
  if (url.pathname === "/store") {
    return send(res, 200, fs.readFileSync(STORE_HTML, "utf8"), "text/html; charset=utf-8");
  }

  if (url.pathname === "/api/store/list") {
    // Le do DISCO via pieces.js (cache por mtime) — funciona com engine parado.
    return send(res, 200, { pieces: pieces.listPublic() });
  }

  // Passo 1 da compra: HTTP 402 com as instrucoes de pagamento.
  if (url.pathname === "/api/store/buy") {
    const piece = pieces.getFull(url.searchParams.get("id") ?? "");
    if (!piece) return send(res, 404, { error: "piece not found" });
    const payTo = agentPayAddress(piece.agent);
    if (!payTo) return send(res, 500, { error: "agent wallet not configured" });
    const solUsd = await solPriceUsd();
    return send(res, 402, {
      pieceId: piece.id,
      agent: piece.agent,
      title: piece.title,
      priceUsd: piece.priceUsd,
      payTo,
      accepts: {
        usdc: { mint: USDC_MINT, amount: piece.priceUsd },
        // +1% de folga sobre o preco spot para nao esbarrar na tolerancia de 2%
        // se o SOL oscilar entre a compra e a verificacao.
        sol: solUsd > 0 ? { amount: Number(((piece.priceUsd / solUsd) * 1.01).toFixed(6)), priceUsd: solUsd } : null,
      },
      how: "send the amount to payTo from your wallet, then claim with the transaction signature",
      claim: `/api/store/claim?id=${piece.id}&tx=<signature>`,
    });
  }

  // Info pro balcao: endereco do agente + preco (USDC/SOL) do servico escolhido.
  if (url.pathname === "/api/store/commission-info") {
    const agent = ["sable", "rook"].includes(url.searchParams.get("agent")) ? url.searchParams.get("agent") : "sable";
    const kind = ["rugcheck", "analysis"].includes(url.searchParams.get("kind")) ? url.searchParams.get("kind") : "rugcheck";
    const payTo = agentPayAddress(agent);
    const priceUsd = commissionPriceUsd(kind);
    const solUsd = await solPriceUsd();
    return send(res, 200, {
      agent, kind, payTo, priceUsd,
      accepts: {
        usdc: { mint: USDC_MINT, amount: priceUsd },
        sol: solUsd > 0 ? { amount: Number(((priceUsd / solUsd) * 1.01).toFixed(6)), priceUsd: solUsd } : null,
      },
    });
  }

  // ENCOMENDA: paga adiantado, o agente entrega no palco, desbloqueia com a
  // mesma assinatura. POST {agent, kind: rugcheck|analysis, brief, txSig}.
  if (url.pathname === "/api/store/commission" && req.method === "POST") {
    const b = await readBody(req);
    const agent = ["sable", "rook"].includes(b.agent) ? b.agent : null;
    const kind = ["rugcheck", "analysis"].includes(b.kind) ? b.kind : null;
    const brief = String(b.brief ?? "").trim().slice(0, 240);
    const txSig = String(b.txSig ?? "").trim();
    if (!agent || !kind) return send(res, 400, { error: "pick an agent and a service" });
    if (kind === "rugcheck" && !/^[1-9A-HJ-NP-Za-km-z]{25,50}$/.test(brief))
      return send(res, 400, { error: "rug-check needs the mint address as the brief" });
    if (kind === "analysis" && brief.length < 8)
      return send(res, 400, { error: "describe what you want analyzed (8+ chars)" });
    if (!txSig) return send(res, 400, { error: "missing tx signature" });

    const ledger = loadCommissions();
    if (ledger.some((c) => c.txSig === txSig) || loadPurchases().some((p) => p.txSig === txSig))
      return send(res, 409, { error: "this transaction was already used" });

    const payTo = agentPayAddress(agent);
    if (!payTo) return send(res, 500, { error: "agent wallet not configured" });
    const priceUsd = commissionPriceUsd(kind);
    const v = await verifyPayment({ txSig, payTo, minUsd: priceUsd, solUsd: await solPriceUsd() });
    if (!v.ok) return send(res, 402, { error: v.reason, priceUsd, payTo });

    const c = {
      id: `cm-${Date.now().toString(36)}`,
      agent, kind, brief, txSig,
      paidUsd: Number(v.paidUsd.toFixed(4)), method: v.method, at: Date.now(),
    };
    ledger.push(c);
    saveCommissions(ledger);
    return send(res, 200, {
      ok: true, commissionId: c.id, paidUsd: c.paidUsd,
      note: "paid and queued — the agent delivers it live on stage; check status with your tx signature",
    });
  }

  // Status da encomenda pela assinatura (e desbloqueio quando entregue).
  if (url.pathname === "/api/store/commission-status") {
    const txSig = (url.searchParams.get("tx") ?? "").trim();
    if (!txSig) return send(res, 400, { error: "missing tx signature" });
    const c = loadCommissions().find((x) => x.txSig === txSig);
    if (!c) return send(res, 404, { error: "no commission under this transaction" });
    const done = loadCommissionsDone().find((d) => d.commissionId === c.id);
    if (!done) return send(res, 200, { status: "pending", commissionId: c.id, agent: c.agent, kind: c.kind });
    const piece = pieces.getFull(done.pieceId);
    return send(res, 200, {
      status: "delivered", commissionId: c.id, pieceId: done.pieceId,
      piece: piece ? { ...piece } : null,
    });
  }

  // Passo 2: verificacao on-chain e entrega. Uma assinatura so reivindica UMA
  // peca (re-claim da mesma peca com a mesma tx e idempotente e re-entrega).
  // Peca ENCOMENDADA: a assinatura do pagamento adiantado desbloqueia direto.
  if (url.pathname === "/api/store/claim") {
    const piece = pieces.getFull(url.searchParams.get("id") ?? "");
    const txSig = (url.searchParams.get("tx") ?? "").trim();
    if (!piece) return send(res, 404, { error: "piece not found" });
    if (!txSig) return send(res, 400, { error: "missing tx signature" });

    if (piece.commissionId) {
      const c = loadCommissions().find((x) => x.id === piece.commissionId);
      if (c && c.txSig === txSig)
        return send(res, 200, { ok: true, commissioned: true, piece: { ...piece } });
    }

    const ledger = loadPurchases();
    const prev = ledger.find((p) => p.txSig === txSig);
    if (prev) {
      if (prev.pieceId === piece.id)
        return send(res, 200, { ok: true, alreadyClaimed: true, piece: { ...piece } });
      return send(res, 409, { error: "this transaction already paid for a different piece" });
    }

    const payTo = agentPayAddress(piece.agent);
    if (!payTo) return send(res, 500, { error: "agent wallet not configured" });
    const v = await verifyPayment({ txSig, payTo, minUsd: piece.priceUsd, solUsd: await solPriceUsd() });
    if (!v.ok) return send(res, 402, { error: v.reason });

    ledger.push({
      txSig, pieceId: piece.id, agent: piece.agent, title: piece.title,
      paidUsd: Number(v.paidUsd.toFixed(4)), method: v.method, at: Date.now(),
    });
    savePurchases(ledger);
    pieces.recordSale(piece.id);
    return send(res, 200, { ok: true, paidUsd: v.paidUsd, piece: { ...piece } });
  }

  // ------------------------- API x402 (para maquinas) -----------------------
  // Agentes/scripts de fora compram os dados sem UI: catalogo gratis, conteudo
  // atras de HTTP 402, pagamento = transferencia on-chain + assinatura da tx
  // (no query `tx` ou no header `x-payment-signature`). A carteira e a conta.

  if (url.pathname === "/api/x402") {
    return send(res, 200, {
      service: "conatus store — machine access",
      how: [
        "1. GET /api/x402/catalog — free JSON list of items (id, kind, title, preview, priceUsd, payTo, accepts)",
        "2. Pay priceUsd to the item's payTo (USDC exact, or SOL at accepts.sol.amount) from your wallet",
        "3. GET /api/x402/piece/<id> with ?tx=<signature> (or header x-payment-signature) — returns the full item",
      ],
      commissions: {
        how: "POST /api/store/commission {agent, kind: rugcheck|analysis, brief, txSig} after paying the commission price to the agent's wallet",
        prices: { rugcheck: commissionPriceUsd("rugcheck"), analysis: commissionPriceUsd("analysis") },
      },
      currency: { usdcMint: USDC_MINT, chain: "solana-mainnet" },
    });
  }

  if (url.pathname === "/api/x402/catalog") {
    const solUsd = await solPriceUsd();
    const items = pieces.listPublic().map((p) => ({
      ...p,
      payTo: agentPayAddress(p.agent),
      accepts: {
        usdc: { mint: USDC_MINT, amount: p.priceUsd },
        sol: solUsd > 0 ? { amount: Number(((p.priceUsd / solUsd) * 1.01).toFixed(6)), priceUsd: solUsd } : null,
      },
    }));
    return send(res, 200, { items });
  }

  if (url.pathname.startsWith("/api/x402/piece/")) {
    const id = path.basename(url.pathname);
    const piece = pieces.getFull(id);
    if (!piece) return send(res, 404, { error: "unknown item" });
    const txSig = (url.searchParams.get("tx") ?? req.headers["x-payment-signature"] ?? "").toString().trim();
    const payTo = agentPayAddress(piece.agent);
    if (!txSig) {
      const solUsd = await solPriceUsd();
      return send(res, 402, {
        error: "payment required",
        pieceId: piece.id, priceUsd: piece.priceUsd, payTo,
        accepts: {
          usdc: { mint: USDC_MINT, amount: piece.priceUsd },
          sol: solUsd > 0 ? { amount: Number(((piece.priceUsd / solUsd) * 1.01).toFixed(6)), priceUsd: solUsd } : null,
        },
        then: `retry with ?tx=<signature> or header x-payment-signature`,
      });
    }
    // Mesma regra do claim humano: dedup por assinatura, idempotente por peca.
    const ledger = loadPurchases();
    const prev = ledger.find((p) => p.txSig === txSig);
    if (prev) {
      if (prev.pieceId === piece.id) return send(res, 200, { ok: true, alreadyClaimed: true, piece: { ...piece } });
      return send(res, 409, { error: "this transaction already paid for a different item" });
    }
    const v = await verifyPayment({ txSig, payTo, minUsd: piece.priceUsd, solUsd: await solPriceUsd() });
    if (!v.ok) return send(res, 402, { error: v.reason });
    ledger.push({
      txSig, pieceId: piece.id, agent: piece.agent, title: piece.title,
      paidUsd: Number(v.paidUsd.toFixed(4)), method: v.method, at: Date.now(), via: "x402",
    });
    savePurchases(ledger);
    pieces.recordSale(piece.id);
    return send(res, 200, { ok: true, paidUsd: v.paidUsd, piece: { ...piece } });
  }

  // A PAGINA DE VERDADE. O agente le a web; o espectador tem que ver o que ele
  // esta vendo, nao um resumo. Quase todo site recusa ser posto em iframe
  // (X-Frame-Options / CSP), entao servimos o HTML pela nossa origem.
  //
  // O <script> sai fora: nao e censura, e que a pagina nao precisa executar nada
  // para ser vista, e codigo de terceiro rodando na nossa origem seria burrice.
  // O <base> faz CSS e imagens continuarem resolvendo contra o site original.
  if (url.pathname === "/proxy") {
    if (adminBlocked(req, res)) return; // proxy aberto na internet seria SSRF
    const target = url.searchParams.get("url") ?? "";
    if (!/^https?:\/\//i.test(target)) return send(res, 400, { error: "bad url" });
    try {
      const r = await fetch(target, {
        headers: { "user-agent": "Mozilla/5.0 (agent-arena stage viewer)" },
        redirect: "follow",
      });
      let html = await r.text();
      html = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<script[^>]*\/?>/gi, "")
        .replace(/ on[a-z]+\s*=\s*"[^"]*"/gi, "")
        .replace(/ on[a-z]+\s*=\s*'[^']*'/gi, "");
      const base = `<base href="${new URL(target).origin}${new URL(target).pathname}">`;
      html = /<head[^>]*>/i.test(html)
        ? html.replace(/<head[^>]*>/i, (m) => m + base)
        : base + html;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(html);
    } catch (e) {
      return send(res, 200,
        `<body style="background:#0c0f14;color:#7d8899;font:13px system-ui;padding:18px">
           could not load ${target.replace(/[<>&]/g, "")} — ${String(e.message).slice(0, 120)}
         </body>`, "text/html; charset=utf-8");
    }
  }

  // Screenshot do que o agente acabou de ler no Chromium dele. E a "pagina de
  // verdade" agora: pixel por pixel o que ele viu, sem reconstrucao por proxy.
  if (url.pathname.startsWith("/shot/")) {
    const name = path.basename(url.pathname); // basename corta qualquer ../
    if (!/^shot-[a-z0-9_-]+\.jpg$/i.test(name)) return send(res, 404, { error: "not found" });
    const file = path.join(ROOT, "src", "data", name);
    if (!fs.existsSync(file)) return send(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" });
    return res.end(fs.readFileSync(file));
  }

  if (url.pathname.startsWith("/assets/")) {
    const name = path.basename(url.pathname); // basename corta qualquer ../
    const file = path.join(ROOT, "public", "assets", name);
    if (!fs.existsSync(file)) return send(res, 404, { error: "not found" });
    const type = name.endsWith(".png") ? "image/png"
      : name.endsWith(".svg") ? "image/svg+xml"
      : name.endsWith(".webp") ? "image/webp" : "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=3600" });
    return res.end(fs.readFileSync(file));
  }

  if (url.pathname === "/api/state") {
    const since = Number(url.searchParams.get("since") ?? 0);
    const cfg = readConfig();
    // Na internet (ADMIN_TOKEN setado), log e config sao so do console: o palco
    // e o site vivem de `running`+`state`. Sem o token, o resto nao sai.
    const adminToken = (cfg.ADMIN_TOKEN || "").trim();
    const isAdmin = !adminToken || req.headers["x-admin-token"] === adminToken;
    // O palco NAO pode depender de quem iniciou o motor.
    //
    // `lastState` so existe quando o servidor foi quem abriu o processo (ele le
    // as linhas "@STATE" do filho). Rodar `node src/engine.js` na mao — que e o
    // caminho normal de teste — deixava o palco congelado com dados velhos
    // enquanto a arena operava normalmente, e a tela ficava mentindo pro
    // espectador (12/08/2026). O motor ja grava `state.json`; na falta do
    // filho, e dali que a tela vem.
    // Sem filho rodando, `lastState` e um FOSSIL: ele sobrevive a morte do
    // processo e continua sendo servido como se fosse o agora. Foi assim que o
    // palco mostrou o tick 3 enquanto a arena ja estava no 6. Sem filho, a
    // verdade e o disco.
    let estado = child ? lastState : null;
    if (!estado) {
      try { estado = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
      catch { /* sem arquivo ainda: a arena nunca rodou nesta maquina */ }
    }
    const pub = { running: !!child, state: estado };
    if (!isAdmin) return send(res, 200, pub);
    return send(res, 200, {
      ...pub,
      log: logLines.filter((l) => l.n > since),
      logSeq,
      config: Object.fromEntries(
        KEYS.map((k) => [k, SECRET_KEYS.has(k) ? (cfg[k] ? "__set__" : "") : (cfg[k] ?? "")])
      ),
    });
  }

  if (url.pathname === "/api/persona") {
    const id = url.searchParams.get("id");
    if (!["sable", "rook"].includes(id)) return send(res, 400, { error: "unknown agent" });
    const histDir = path.join(ROOT, "agents", "history");
    const versions = fs.existsSync(histDir)
      ? fs.readdirSync(histDir).filter((f) => f.startsWith(`${id}.v`) && f.endsWith(".md")).sort()
      : [];
    return send(res, 200, {
      current: fs.readFileSync(path.join(ROOT, "agents", `${id}.md`), "utf8"),
      versions,
    });
  }

  if (url.pathname === "/api/config" && req.method === "POST") {
    if (adminBlocked(req, res)) return;
    writeConfig(await readBody(req));
    return send(res, 200, { ok: true });
  }

  // O BANQUEIRO decide. A peticao conjunta dos agentes (state.loanRequests,
  // status with_bank) aparece no console; aqui o Michel aprova/nega. A decisao
  // vai pra bank-decisions.json (escritor unico: o server) e o engine aplica no
  // proximo turno. `amount` opcional = contra-oferta; `note` vai pros agentes.
  if (url.pathname === "/api/bank" && req.method === "POST") {
    if (adminBlocked(req, res)) return;
    const b = await readBody(req);
    const requestId = String(b.requestId ?? "").trim();
    if (!requestId) return send(res, 400, { error: "requestId required" });
    const file = process.env.BANK_DECISIONS_FILE || path.join(ROOT, "src", "data", "bank-decisions.json");
    let db = { decisions: [] };
    try { db = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* primeiro uso */ }
    if (!Array.isArray(db.decisions)) db = { decisions: [] };
    if (db.decisions.some((d) => d.requestId === requestId))
      return send(res, 409, { error: "that petition was already decided" });
    db.decisions.push({
      requestId,
      approve: !!b.approve,
      amount: Number(b.amount) > 0 ? Number(b.amount) : null,
      note: String(b.note ?? "").slice(0, 300),
      at: Date.now(),
    });
    db.decisions = db.decisions.slice(-200);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(db, null, 2));
    } catch (e) { return send(res, 500, { error: `could not record the decision: ${e.message}` }); }
    return send(res, 200, { ok: true });
  }

  if (url.pathname === "/api/start" && req.method === "POST") {
    if (adminBlocked(req, res)) return;
    return send(res, 200, startEngine());
  }
  if (url.pathname === "/api/stop" && req.method === "POST") {
    if (adminBlocked(req, res)) return;
    return send(res, 200, stopEngine());
  }

  send(res, 404, { error: "not found" });
});

// Porta ocupada e o erro mais comum de todos: quase sempre e a propria arena ja
// aberta noutra janela. Stack trace do Node nao ajuda ninguem a entender isso.
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.log("");
    console.log("  ============================================================");
    console.log(`   Port ${PORT} is already in use.`);
    console.log("");
    console.log("   The arena is probably already open in another window.");
    console.log(`   Try your browser first:  http://localhost:${PORT}`);
    console.log("");
    console.log("   If not, close the other window (or any leftover Node");
    console.log("   process) and start this again.");
    console.log("  ============================================================");
    console.log("");
    process.exit(1);
  }
  console.log(`Server error: ${e.message}`);
  process.exit(1);
});

// Em casa: somente loopback (sala de ensaio). No Railway (ou HOST=0.0.0.0):
// bind publico — e ai o ADMIN_TOKEN e OBRIGATORIO (console/config/start/stop).
const HOST = process.env.HOST || (process.env.RAILWAY_ENVIRONMENT ? "0.0.0.0" : "127.0.0.1");
if (HOST !== "127.0.0.1" && !(readConfig().ADMIN_TOKEN || "").trim()) {
  console.log("");
  console.log("  ============================================================");
  console.log("   REFUSING to bind publicly without ADMIN_TOKEN set.");
  console.log("   Anyone could reconfigure the arena or stop the show.");
  console.log("   Set ADMIN_TOKEN in the environment and start again.");
  console.log("  ============================================================");
  console.log("");
  process.exit(1);
}
server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Agent Arena — ${url}${HOST !== "127.0.0.1" ? ` (public bind ${HOST})` : ""}`);
  if (process.env.NO_OPEN === "1" || HOST !== "127.0.0.1") return;
  const open = process.platform === "win32" ? `start "" "${url}"`
    : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(open, () => {});
});

process.on("SIGINT", () => { if (child) stopEngine(); process.exit(0); });
