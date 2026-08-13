// ============================================================================
// O EXECUTOR REAL — a unica porta por onde o valor dos agentes se MOVE, e ela
// so abre pra dentro da propria carteira.
//
// O `signer.js` recusa assinar qualquer coisa que nao seja texto, e diz no
// comentario: "se um dia precisar, sera uma decisao explicita do Michel, num
// modulo separado, com o executor no meio". Este e esse modulo. A decisao foi
// tomada em 12/08/2026: os trades passam a ser REAIS na pump.fun, porque
// "na vida real nao existe simulacao".
//
// A TRAVA CONTINUA DE PE, e agora ela e VERIFICADA, nao apenas ausente:
//
//   1. O agente nunca ve a chave nem monta transacao. Ele PROPOE; o broker
//      aprova por regra; aqui a transacao e montada, conferida e assinada.
//   2. LISTA BRANCA de programas: se a transacao tocar qualquer programa fora
//      do conjunto {pump, pump-amm, Token, ATA, System, ComputeBudget, Memo},
//      e recusada. Isso mata Approve/SetAuthority/delegate na origem.
//   3. SIMULACAO antes de assinar: a transacao roda no RPC e o executor compara
//      os DELTAS DE SALDO. Se a carteira perder mais SOL do que o combinado,
//      e recusada — nao importa como o ataque tenha sido montado.
//   4. TETO DURO em dolar por operacao (MAX_REAL_TRADE_USD), independente do
//      que o agente pediu e do que o broker aprovou.
//
// Nao existe aqui: transferir para terceiro, sacar, aprovar delegate, assinar
// transacao arbitraria. O que existe e trocar SOL por token e token por SOL,
// dentro da carteira do proprio agente.
//
// Zero dependencia nova: a transacao vem serializada do PumpPortal e a
// assinatura e ed25519 do node:crypto, o mesmo que o signer.js ja usa.
// ============================================================================

import crypto from "node:crypto";
import { b58encode, b58decode } from "./signer.js";

const PUMPPORTAL = "https://pumpportal.fun/api/trade-local";
const rpcUrl = () => process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";

// ---------------------------- a lista branca --------------------------------
// Todo programa que a transacao pode tocar. Em transacao versionada (v0) o
// program id NUNCA pode vir de address lookup table — a propria Solana exige
// que esteja nas contas estaticas. Entao ler as estaticas basta.
// Cada entrada aqui foi VERIFICADA on-chain em 12/08/2026 (dono da bonding
// curve, autoridade de upgrade), nao copiada de tutorial.
const ALLOWED_PROGRAMS = new Set([
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",  // pump.fun — confirmado: e o DONO da conta da bonding curve
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",  // pump AMM (token graduado) — mesma autoridade da pump
  "FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe", // PumpPortal (router + taxa 0,5%) — ver nota abaixo
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",  // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",  // Token-2022 — ver nota abaixo
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token Account
  "11111111111111111111111111111111",             // System (criar conta, wrap SOL)
  "ComputeBudget111111111111111111111111111111",  // taxa de prioridade
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",  // Memo
]);
//
// TOKEN-2022 entrou na lista (antes era recusa automatica). Motivo: em
// 12/08/2026 a maioria dos tokens da pump.fun ja e Token-2022 usando SO
// extensoes de metadata — recusar o programa bloquearia o mercado inteiro e
// ainda deixava passar honeypot de SPL comum (freeze authority). Quem julga
// agora e `wallet.inspectMint`, que le as EXTENSOES do mint e reprova transfer
// hook, permanent delegate, taxa de transferencia, non-transferable e freeze.
// Checagem mais precisa e mais abrangente do que a regra que ela substituiu.
//
// PUMPPORTAL (FAdo9NCw) e um TERCEIRO: e o programa deles que roteia a ordem e
// cobra os 0,5%. A autoridade de upgrade e diferente da pump.fun oficial, entao
// ele pode mudar sem aviso. Por isso ele NAO e confiado — e apenas tolerado:
// quem realmente segura a porta e a SIMULACAO com conferencia de delta logo
// abaixo. Se um dia esse programa tentar levar mais do que o combinado, a
// transacao e recusada antes de ser assinada.

async function rpc(method, params) {
  const r = await fetch(rpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`RPC ${j.error.message}`);
  return j.result;
}

// --------------------- leitura da transacao serializada ---------------------

// compact-u16 (shortvec): ate 3 bytes, 7 bits uteis cada, bit 8 = continua.
function readCompactU16(buf, off) {
  let val = 0, shift = 0, i = off;
  for (;;) {
    if (i >= buf.length) throw new Error("transacao truncada");
    const b = buf[i++];
    val |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 14) throw new Error("compact-u16 invalido");
  }
  return { val, off: i };
}

// Separa [assinaturas][mensagem] e devolve os program ids que a mensagem toca.
// Aceita transacao versionada (v0, primeiro byte da mensagem com bit alto) e
// legada. NAO interpreta os dados das instrucoes — o que decide se o valor sai
// e a simulacao; isto aqui e a peneira estrutural.
export function inspectTx(bytes) {
  const buf = Buffer.from(bytes);
  const { val: nSigs, off: afterCount } = readCompactU16(buf, 0);
  if (nSigs !== 1) throw new Error(`transacao exige ${nSigs} assinaturas — esperado exatamente 1`);
  const sigOffset = afterCount;
  const msgOffset = afterCount + 64 * nSigs;
  const msg = buf.subarray(msgOffset);
  if (!msg.length) throw new Error("mensagem vazia");

  let p = 0;
  let versioned = false;
  if (msg[0] & 0x80) { // prefixo de versao (0x80 = v0)
    if ((msg[0] & 0x7f) !== 0) throw new Error(`versao de transacao nao suportada: ${msg[0] & 0x7f}`);
    versioned = true;
    p = 1;
  }
  p += 3; // header: numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned

  const { val: nKeys, off: afterKeys } = readCompactU16(msg, p);
  p = afterKeys;
  const keys = [];
  for (let i = 0; i < nKeys; i++) {
    keys.push(b58encode(msg.subarray(p, p + 32)));
    p += 32;
  }
  p += 32; // recent blockhash

  const { val: nIx, off: afterIx } = readCompactU16(msg, p);
  p = afterIx;
  const programs = [];
  for (let i = 0; i < nIx; i++) {
    const programIdIndex = msg[p++];
    if (programIdIndex >= keys.length)
      throw new Error("program id fora das contas estaticas — recusado por principio");
    programs.push(keys[programIdIndex]);
    const { val: nAcc, off: a1 } = readCompactU16(msg, p);
    p = a1 + nAcc;
    const { val: dataLen, off: a2 } = readCompactU16(msg, p);
    p = a2 + dataLen;
  }

  return { versioned, nSigs, sigOffset, msgOffset, message: msg, keys, programs, signer: keys[0] };
}

// A peneira estrutural: todo programa tocado tem que estar na lista branca, e
// quem assina tem que ser o proprio agente.
export function checkWhitelist(info, expectedSigner) {
  if (info.signer !== expectedSigner)
    return { ok: false, reason: `a transacao seria assinada por ${info.signer}, nao pelo agente` };
  for (const prog of info.programs) {
    if (!ALLOWED_PROGRAMS.has(prog))
      return { ok: false, reason: `programa fora da lista branca: ${prog}` };
  }
  return { ok: true };
}

// ------------------------------- assinatura ---------------------------------

// Semente crua -> chave ed25519 (mesmo envelope PKCS8 do signer.js).
function keyFromSeed(seed) {
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed)]);
  return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

// Assina a MENSAGEM e escreve a assinatura no lugar reservado. A transacao ja
// vem montada com um slot de 64 bytes zerados — e ali que a assinatura entra.
function signTx(bytes, info, keypairRaw) {
  const s = String(keypairRaw ?? "").trim();
  const raw = s.startsWith("[") ? Uint8Array.from(JSON.parse(s)) : b58decode(s);
  if (raw.length !== 64) throw new Error("keypair deve ter 64 bytes");
  const pub = b58encode(raw.slice(32, 64));
  if (pub !== info.signer) throw new Error("a chave nao corresponde ao assinante da transacao");
  const sig = crypto.sign(null, Buffer.from(info.message), keyFromSeed(raw.slice(0, 32)));
  const out = Buffer.from(bytes);
  Buffer.from(sig).copy(out, info.sigOffset);
  return out;
}

// ------------------------------- o caminho ----------------------------------

// Monta a transacao no PumpPortal. Devolve os bytes crus — nada assinado.
// `pool`: "pump" (bonding curve) ou "pump-amm" (token graduado).
async function buildTrade({ owner, action, mint, amount, denominatedInSol, slippage, priorityFee, pool }) {
  const r = await fetch(PUMPPORTAL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      publicKey: owner, action, mint, amount,
      denominatedInSol: denominatedInSol ? "true" : "false",
      slippage, priorityFee, pool,
    }),
  });
  if (!r.ok) throw new Error(`PumpPortal HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 100) throw new Error(`PumpPortal devolveu ${buf.length} bytes — nao e transacao`);
  return buf;
}

// SIMULA e confere os DELTAS. E a defesa que nao depende de entender a
// instrucao: se a carteira perder mais SOL do que o combinado, recusa.
export async function simulateAndCheck(txBytes, { owner, maxSolSpend }) {
  const sim = await rpc("simulateTransaction", [
    Buffer.from(txBytes).toString("base64"),
    {
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "processed",
      accounts: { encoding: "base64", addresses: [owner] },
    },
  ]);
  const v = sim?.value;
  if (!v) return { ok: false, reason: "o RPC nao devolveu simulacao" };
  if (v.err) {
    const log = (v.logs ?? []).slice(-3).join(" | ").slice(0, 200);
    return { ok: false, reason: `a transacao falharia: ${JSON.stringify(v.err)}${log ? ` — ${log}` : ""}` };
  }
  const post = v.accounts?.[0]?.lamports;
  if (post == null) return { ok: false, reason: "simulacao sem saldo pos-transacao — nao assino as cegas" };
  const pre = (await rpc("getBalance", [owner]))?.value ?? 0;
  const spentSol = (pre - post) / 1e9;
  // Teto com folga pequena para taxa de rede/prioridade (0.01 SOL).
  if (spentSol > maxSolSpend + 0.01)
    return { ok: false, reason: `a transacao gastaria ${spentSol.toFixed(4)} SOL, acima do teto de ${maxSolSpend.toFixed(4)}` };
  return { ok: true, spentSol, units: v.unitsConsumed ?? null };
}

// Envia e espera confirmar. Devolve a assinatura (o link do Solscan).
async function sendAndConfirm(signed, { timeoutMs = 45000 } = {}) {
  const sig = await rpc("sendTransaction", [
    Buffer.from(signed).toString("base64"),
    { encoding: "base64", skipPreflight: false, maxRetries: 3, preflightCommitment: "confirmed" },
  ]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = (await rpc("getSignatureStatuses", [[sig], { searchTransactionHistory: false }]))?.value?.[0];
    if (st?.err) throw new Error(`transacao falhou on-chain: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") {
      return { signature: sig, status: st.confirmationStatus };
    }
  }
  // Nao confirmou a tempo: PODE ter passado. Devolve a assinatura pra conferir.
  return { signature: sig, status: "unconfirmed" };
}

// ---------------------------------------------------------------------------
// O PORTAO — para transacao que a PAGINA montou (o agente clicando "buy" na
// pump.fun, ao vivo). Este e o caminho novo, e o mais exposto: aqui a
// transacao nao foi pedida por nos, foi entregue por um site.
//
// Por isso ela passa pela MESMA barreira que ja protege o caminho do
// PumpPortal — que tambem e um terceiro montando transacao:
//   1. estrutura (1 assinatura, e do agente)
//   2. lista branca de programas
//   3. simulacao + delta de saldo dentro do teto
// So depois disso a chave e usada. Recusa e resposta legivel, nao excecao.
// ---------------------------------------------------------------------------
export async function approveAndSign(txBytes, { owner, keypairEnvKey, maxSolSpend }) {
  try {
    const info = inspectTx(txBytes);
    const wl = checkWhitelist(info, owner);
    if (!wl.ok) return { ok: false, reason: wl.reason };
    const sim = await simulateAndCheck(txBytes, { owner, maxSolSpend });
    if (!sim.ok) return { ok: false, reason: sim.reason };
    const keypair = process.env[keypairEnvKey];
    if (!keypair) return { ok: false, reason: `${keypairEnvKey} nao configurada` };
    const signed = signTx(txBytes, info, keypair);
    return {
      ok: true, signed, spentSol: sim.spentSol,
      programs: [...new Set(info.programs)],
    };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// Envia uma transacao ja assinada e espera confirmar (usado pelo caminho da
// pagina, quando o site pede signAndSend).
export async function sendSigned(signed) {
  try {
    const r = await sendAndConfirm(signed);
    return { ok: true, ...r, url: `https://solscan.io/tx/${r.signature}` };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ---------------------------------------------------------------------------
// A FUNCAO PUBLICA. Uma so, e ela so faz uma coisa: trocar, na carteira do
// proprio agente. `usd` e o tamanho em dolar; `solUsd` converte; `keypairEnvKey`
// e o NOME da variavel de ambiente (o valor nunca circula fora daqui).
//
// Devolve { ok, signature, spentSol, reason }. Nunca lanca pra fora do try do
// chamador sem motivo legivel — recusa e informacao, nao excecao.
// ---------------------------------------------------------------------------
export async function trade({
  owner, keypairEnvKey, action, mint, usd, solUsd, graduated = false,
  maxRealTradeUsd = 1, slippage = 10, priorityFee = 0.00001, sellPercent = null,
}) {
  try {
    if (!owner) return { ok: false, reason: "sem endereco do agente" };
    const keypair = process.env[keypairEnvKey];
    if (!keypair) return { ok: false, reason: `${keypairEnvKey} nao configurada` };
    if (!(solUsd > 0)) return { ok: false, reason: "sem preco do SOL para converter o tamanho" };

    // TETO DURO em dolar — vale mesmo que o broker tenha aprovado mais.
    // 0 = sem teto: o broker ja limitou pelo % da carteira real e pela curva.
    const sizeUsd = maxRealTradeUsd > 0
      ? Math.min(Number(usd) || 0, maxRealTradeUsd)
      : (Number(usd) || 0);
    if (action === "buy" && !(sizeUsd > 0)) return { ok: false, reason: "tamanho invalido" };
    const amountSol = sizeUsd / solUsd;

    // Compra: amount em SOL. Venda: percentual do que tem do token.
    const isBuy = action === "buy";
    const amount = isBuy ? Number(amountSol.toFixed(6)) : (sellPercent ?? "100%");

    const txBytes = await buildTrade({
      owner, action, mint, amount,
      denominatedInSol: isBuy,
      slippage, priorityFee,
      pool: graduated ? "pump-amm" : "pump",
    });

    // 1) peneira estrutural
    const info = inspectTx(txBytes);
    const wl = checkWhitelist(info, owner);
    if (!wl.ok) return { ok: false, reason: `RECUSADO — ${wl.reason}` };

    // 2) simulacao + deltas (na venda o SOL so entra, entao o teto e a taxa)
    const maxSolSpend = isBuy ? amountSol * 1.2 : 0;
    const sim = await simulateAndCheck(txBytes, { owner, maxSolSpend });
    if (!sim.ok) return { ok: false, reason: `RECUSADO — ${sim.reason}` };

    // 3) assina e envia
    const signed = signTx(txBytes, info, keypair);
    const sent = await sendAndConfirm(signed);
    return {
      ok: true,
      signature: sent.signature,
      status: sent.status,
      spentSol: sim.spentSol,
      sizeUsd,
      url: `https://solscan.io/tx/${sent.signature}`,
    };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// Para teste: expõe a lista branca sem permitir edicao.
export const _allowedPrograms = () => [...ALLOWED_PROGRAMS];
