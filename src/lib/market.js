// ============================================================================
// Dados reais, somente leitura. Nada aqui assina nada nem move valor.
//
// Ler e irrestrito de proposito: a "vida na internet" dos agentes acontece
// toda neste arquivo, e ler nao move dinheiro. A fronteira do projeto esta no
// broker, nao aqui.
// ============================================================================

const HL = "https://api.hyperliquid.xyz";
const PUMP = "https://frontend-api-v3.pump.fun";

const UA = "agent-arena/0.1";

async function getJson(url, tries = 3) {
  let wait = 1200;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, wait));
      wait *= 2;
    }
  }
}

async function postJson(url, body, tries = 3) {
  let wait = 1200;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": UA },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, wait));
      wait *= 2;
    }
  }
}

// ----------------------------- Hyperliquid -----------------------------------

// Universo de perps com mark, volume 24h e funding. E o mesmo /info que o
// hyper-scalper usa; aqui so lemos.
export async function hlMarkets() {
  const [meta, ctxs] = await postJson(`${HL}/info`, { type: "metaAndAssetCtxs" });
  return meta.universe
    .map((u, i) => {
      const c = ctxs[i] ?? {};
      return {
        coin: u.name,
        mark: Number(c.markPx ?? 0),
        prevDay: Number(c.prevDayPx ?? 0),
        dayVolumeUsd: Number(c.dayNtlVlm ?? 0),
        funding: Number(c.funding ?? 0),
        openInterest: Number(c.openInterest ?? 0),
        maxLeverage: u.maxLeverage ?? 1,
        changePct:
          Number(c.prevDayPx) > 0
            ? ((Number(c.markPx) - Number(c.prevDayPx)) / Number(c.prevDayPx)) * 100
            : 0,
      };
    })
    .filter((m) => m.mark > 0);
}

// Candles de um par. interval: "1m","5m","15m","1h","4h","1d"
export async function hlCandles(coin, interval = "15m", count = 60) {
  const ms = { "1m": 6e4, "5m": 3e5, "15m": 9e5, "1h": 36e5, "4h": 1.44e7, "1d": 8.64e7 }[interval] ?? 9e5;
  const end = Date.now();
  const start = end - ms * count;
  const rows = await postJson(`${HL}/info`, {
    type: "candleSnapshot",
    req: { coin, interval, startTime: start, endTime: end },
  });
  return (rows ?? []).map((c) => ({
    t: c.t,
    o: Number(c.o),
    h: Number(c.h),
    l: Number(c.l),
    c: Number(c.c),
    v: Number(c.v),
  }));
}

// ------------------------------- Jupiter -------------------------------------
//
// FEED DE PRECO (nao e venue). Perps sairam do projeto em 12/08/2026 — a API do
// Jupiter Perps nao existe ("work in progress"; so programa Anchor), e o unico
// venue de execucao agora e a pump.fun, a vista.
//
// Isto continua aqui porque o preco do SOL e necessario em toda parte: valorar
// a carteira real, converter gorjeta, e calcular a liquidez da pool na pump
// (virtualSol x solUsd). Preco real (`usdPrice`) do price API keyless do
// proprio Jupiter — nenhuma chave, so leitura.
const JUP_PRICE = "https://lite-api.jup.ag/price/v3";
const JUP_PERP_ASSETS = [
  { coin: "SOL", mint: "So11111111111111111111111111111111111111112" },
  { coin: "ETH", mint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs" }, // ETH (Wormhole)
  { coin: "BTC", mint: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh" }, // wBTC (Wormhole)
];
// Teto real de alavancagem do Jupiter. O agente escolhe quanto usar; isto e so
// o teto fisico do venue — a casa nao impoe cap proprio (decisao do Michel).
const JUP_MAX_LEVERAGE = 100;

export async function jupMarkets() {
  const ids = JUP_PERP_ASSETS.map((a) => a.mint).join(",");
  const data = await getJson(`${JUP_PRICE}?ids=${ids}`);
  return JUP_PERP_ASSETS
    .map((a) => {
      const d = data?.[a.mint] ?? {};
      const mark = Number(d.usdPrice ?? 0);
      const changePct = Number(d.priceChange24h ?? 0);
      return {
        coin: a.coin,
        mark,
        prevDay: changePct ? mark / (1 + changePct / 100) : mark,
        dayVolumeUsd: Number(d.liquidity ?? 0),
        funding: 0,
        openInterest: 0,
        maxLeverage: JUP_MAX_LEVERAGE,
        changePct,
      };
    })
    .filter((m) => m.mark > 0);
}

// ------------------------------- pump.fun ------------------------------------

// Ficha de um token. Traz o que as checagens do broker precisam: programa do
// token (Token-2022 e onde moram os honeypots), reservas, criador, se bondou.
export async function pumpCoin(mint) {
  const c = await getJson(`${PUMP}/coins/${mint}`);
  return {
    mint: c.mint,
    name: c.name,
    symbol: c.symbol,
    description: c.description ?? "",
    creator: c.creator,
    createdAt: c.created_timestamp,
    complete: !!c.complete,
    usdMarketCap: Number(c.usd_market_cap ?? 0),
    athMarketCap: Number(c.ath_market_cap ?? 0),
    replyCount: c.reply_count ?? 0,
    participants: c.num_participants ?? 0,
    isLive: !!c.is_currently_live,
    // MAYHEM MODE (pump.fun): `mayhem_state` = "active" enquanto o evento roda.
    // A casa NAO opera token em mayhem (decisao do Michel, 12/08/2026) — o
    // executor recusa a compra. Achado no bundle do site (`isMayhemMode`,
    // `/coins/mayhem-mode`) porque a doc fica atras do modal de consentimento.
    mayhemState: c.mayhem_state ?? c.mayhem?.state ?? null,
    mayhemMode: c.mayhem?.mode ?? null, // "manual" | "auto"
    // BOOST e OUTRA coisa: acontece depois da migracao do token. Fica so como
    // informacao — nao bloqueia.
    boostMode: c.boost_mode ?? "NONE",
    tokenProgram: c.token_program ?? "",
    // ATENCAO A DIFERENCA (o Michel pegou este erro em 12/08/2026):
    // `virtual_sol_reserves` NAO e liquidez — e a CONSTANTE da bonding curve.
    // Todo token da pump.fun nasce com 30 SOL virtuais, entao esse numero em
    // dolar so muda com o preco do SOL: era isso que fazia tokens diferentes
    // aparecerem todos com o mesmo "pool de $2.285".
    // Ele serve para SLIPPAGE (o k da curva define o impacto no preco).
    virtualSol: Number(c.virtual_sol_reserves ?? 0) / 1e9,
    virtualTokens: Number(c.virtual_token_reserves ?? 0),
    // `real_sol_reserves` e o DINHEIRO DE VERDADE que ja entrou no token.
    // Zero = ninguem comprou ainda ("token zerado"). E isto que responde
    // "tem dinheiro aqui dentro?".
    realSol: Number(c.real_sol_reserves ?? 0) / 1e9,
    lastTrade: c.last_trade_timestamp,
    website: c.website ?? "",
    twitter: c.twitter ?? "",
  };
}

// Tokens recentes. O formato desta rota muda de tempos em tempos — se ela
// quebrar, o agente simplesmente nao ve lista nova e continua vivo.
export async function pumpRecent(limit = 12) {
  try {
    const rows = await getJson(
      `${PUMP}/coins?offset=0&limit=${limit}&sort=last_trade_timestamp&order=DESC&includeNsfw=false`
    );
    const list = Array.isArray(rows) ? rows : (rows?.coins ?? []);
    return list.map((c) => ({
      mint: c.mint,
      symbol: c.symbol,
      name: c.name,
      usdMarketCap: Number(c.usd_market_cap ?? 0),
      complete: !!c.complete,
      createdAt: c.created_timestamp,
      participants: c.num_participants ?? 0,
    }));
  } catch {
    return [];
  }
}

// --------------------------- Leitura livre da web -----------------------------
//
// Agora via Chromium headless (lib/browser.js): o agente navega como uma pessoa
// navega — JavaScript renderiza, CDN nao devolve JSON de erro para "bot". O
// fetch cru fica so de reserva para quando o Chromium nao sobe.

import * as chrome from "./browser.js";

// Busca na web. Sem isso o agente le a internet mas nao navega nela: so alcanca
// URL que ja esteja no contexto dele. E o que separa "pode ler" de "pode achar".
export async function search(query, max = 8, shotPath = null, key = undefined) {
  try {
    return await chrome.searchPage(query, max, { shotPath, key });
  } catch {
    return searchFallback(query, max);
  }
}

// Reserva: DuckDuckGo HTML por fetch, sem chave nem conta.
async function searchFallback(query, max) {
  const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "user-agent": UA },
  });
  const html = await r.text();
  const out = [];
  // Cada resultado e um <a class="result__a" href="...">titulo</a>
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < max) {
    let url = m[1];
    // O DDG embrulha o destino em /l/?uddg=<url-encoded>
    const wrapped = url.match(/[?&]uddg=([^&]+)/);
    if (wrapped) url = decodeURIComponent(wrapped[1]);
    const title = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (url.startsWith("http") && title) out.push({ title, url });
  }
  return out;
}

// Abre a pagina no Chromium e devolve o texto renderizado. shotPath, se vier,
// recebe o screenshot do que o agente viu — o palco mostra esse arquivo. TUDO
// que sai daqui e ENTRADA NAO CONFIAVEL: o engine marca como tal e o broker
// nunca aceita ordem originada de texto lido.
export async function readUrl(url, maxChars = 6000, shotPath = null) {
  try {
    return await chrome.readPage(url, { maxChars, shotPath });
  } catch {
    return readUrlFallback(url, maxChars);
  }
}

// Abre a URL na ABA do agente (fica aberta entre turnos) e devolve o que esta
// na tela: texto do viewport, o que da pra clicar, posicao do scroll. Se o
// Chromium nao subir, cai no fetch cru — sem aba, sem scroll, so texto.
export async function openUrl(agentId, url, shotPath = null) {
  try {
    return await chrome.openPage(agentId, url, { shotPath });
  } catch (e) {
    // O texto vem por HTTP puro, mas a ABA do agente NAO navegou — ela ficou
    // onde a navegacao falhou (tela de erro do Chrome, com a URL certa na
    // barra). Quem chama precisa saber disso: sem o aviso, o palco mostra a
    // pagina como se estivesse aberta e o trade tenta operar num painel que
    // nao existe. Silenciar esta falha custou uma tarde em 12/08/2026.
    console.log(`[diag ${new Date().toISOString()}] openPage falhou para ${agentId} em ${url}: ${String(e?.message ?? e).slice(0, 160)}`);
    const r = await readUrlFallback(url, 6000);
    return { ...r, links: [], scrollPct: 100, atEnd: true, browserFalhou: true };
  }
}

// Movimento na aba do agente: "scroll down" | "scroll up" | "click: <texto>" |
// "back". Mesma regra de entrada nao confiavel do readUrl.
export async function browse(agentId, move, shotPath = null) {
  return chrome.browseMove(agentId, move, { shotPath });
}

// Reserva: fetch cru + tags fora. Sem screenshot.
async function readUrlFallback(url, maxChars) {
  const r = await fetch(url, { headers: { "user-agent": UA } });
  const html = await r.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return { url, status: r.status, text: text.slice(0, maxChars) };
}
