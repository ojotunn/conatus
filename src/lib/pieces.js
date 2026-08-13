// ============================================================================
// O catalogo da loja — as pecas que os agentes poem A VENDA por dinheiro real.
//
// O engine escreve (add, nos handlers de `sell`/`rugcheck`); o server LE o
// arquivo do disco (sobrevive a engine parado). Um escritor so — sem corrida.
//
// A peca guarda o texto COMPLETO aqui e um `preview` curto separado: o preview
// e o que circula de graca (feed, /api/store/list); o texto inteiro so sai
// depois de pagamento verificado on-chain. Sem essa separacao a loja cobraria
// por algo que o /api/state ja entrega.
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, "..", "data");
// PIECES_FILE: override para testes (o probe aponta pra um arquivo descartavel
// em vez de poluir o catalogo real).
const FILE = process.env.PIECES_FILE || path.join(DATA, "pieces.json");

// Teto do catalogo. FIFO: estourou, a peca mais velha sai. Mantem o arquivo
// pequeno e a vitrine relevante — ninguem compra a analise de tres meses atras.
const MAX_PIECES = 200;
const PREVIEW_CHARS = 180;

// Cache validado por mtime: o ENGINE escreve este arquivo e o SERVER le — sao
// processos diferentes. Sem checar o mtime, o server nunca veria peca nova.
let cache = null;
let cacheMtime = 0;

function load() {
  let mtime = 0;
  try { mtime = fs.statSync(FILE).mtimeMs; } catch { /* ainda nao existe */ }
  if (cache && mtime === cacheMtime) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!Array.isArray(cache.pieces)) cache = { pieces: [] };
  } catch {
    cache = { pieces: [] };
  }
  cacheMtime = mtime;
  return cache;
}

function save() {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
    try { cacheMtime = fs.statSync(FILE).mtimeMs; } catch { /* leitura refaz */ }
  } catch { /* disco cheio nao pode derrubar o show */ }
}

// Id curto e legivel (pc-<base36 do tempo><contador>). Nao e seguranca — e so
// referencia de compra; a verificacao de pagamento e quem guarda a porta.
let seq = 0;
export function makeId(now = Date.now()) {
  return `pc-${now.toString(36)}${(seq++ % 36).toString(36)}`;
}

// Publica uma peca no catalogo. Devolve o id (vai junto no evento do feed).
export function add({ agent, kind, title, text, priceUsd, commissionId = null, at = Date.now() }) {
  const db = load();
  const piece = {
    id: makeId(at),
    agent,
    kind, // "sell" | "rugcheck"
    commissionId, // peca feita por ENCOMENDA: o pagador desbloqueia com a tx dele
    title: String(title || "").slice(0, 120),
    preview: String(text || "").slice(0, PREVIEW_CHARS) + (String(text || "").length > PREVIEW_CHARS ? "…" : ""),
    text: String(text || ""),
    priceUsd: Number(priceUsd) || 0,
    at,
    sales: 0,
  };
  db.pieces.push(piece);
  if (db.pieces.length > MAX_PIECES) db.pieces = db.pieces.slice(-MAX_PIECES);
  save();
  return piece.id;
}

// Vitrine: metadados + preview, NUNCA o texto. E o que o /api/store/list serve.
export function listPublic() {
  return load().pieces.map(({ text, ...pub }) => pub).reverse(); // mais novas primeiro
}

export function getFull(id) {
  return load().pieces.find((p) => p.id === id) ?? null;
}

// Registro de venda (contador na peca — o ledger de compras fica no server).
export function recordSale(id) {
  const p = load().pieces.find((x) => x.id === id);
  if (p) { p.sales++; save(); }
}

// Para testes: aponta para outro arquivo e zera o cache.
export function _resetForTest() { cache = { pieces: [] }; save(); }
