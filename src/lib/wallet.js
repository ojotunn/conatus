// ============================================================================
// Leitura de carteira — somente leitura, so precisa do endereco publico.
//
// E aqui que "ganho por trabalho" deixa de ser aspiracao. Em vez de integrar
// com cada plataforma que pode pagar o agente (x402, bounty, tip, alguem
// contratando), o sistema so olha o saldo: subiu e nao foi trade, virou renda.
//
// Agnostico de origem de proposito. Quando o x402 entrar, ja esta coberto —
// e o mesmo caminho serve para dinheiro que chegou de um jeito que ninguem
// previu, que e justamente o interessante num agente solto na internet.
//
// Nenhuma chave e usada. Isto le endereco publico e mais nada.
// ============================================================================

// Lido a cada chamada (nao no import): o server carrega o .env DEPOIS dos
// imports, e congelar aqui prenderia todo mundo no RPC publico rate-limitado.
const rpcUrl = () => process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

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

// Saldo em SOL e USDC. Devolve numeros ja convertidos das unidades minimas.
export async function getBalances(address) {
  const [lamports, tokens] = await Promise.all([
    rpc("getBalance", [address]),
    rpc("getTokenAccountsByOwner", [
      address,
      { mint: USDC_MINT },
      { encoding: "jsonParsed" },
    ]).catch(() => ({ value: [] })),
  ]);

  const usdc = (tokens?.value ?? []).reduce((sum, acc) => {
    const amt = acc?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
    return sum + (Number(amt) || 0);
  }, 0);

  return { sol: (lamports?.value ?? 0) / 1e9, usdc };
}

// ---------------------------------------------------------------------------
// RAIO-X DO MINT — o que o token PODE fazer com voce depois que voce comprar.
//
// Isto substitui a regra velha ("Token-2022 = recusa"), que estava larga demais:
// em 12/08/2026 boa parte dos tokens da pump.fun ja e Token-2022 usando so
// extensoes de METADATA (benignas), e recusar todos bloquearia o mercado
// inteiro. O perigo nunca foi o programa — sao extensoes especificas.
//
// E de quebra pega um risco que a regra velha NAO pegava: `freezeAuthority`
// setada num token SPL comum (alguem pode congelar sua conta = nao vende mais).
// ---------------------------------------------------------------------------
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// Extensoes que tiram de voce o controle do que comprou.
const DANGEROUS_EXTENSIONS = {
  transferHook: "transfer hook — o criador roda codigo em cada transferencia e pode travar a venda",
  permanentDelegate: "permanent delegate — o dono pode confiscar o token da sua carteira",
  nonTransferable: "non-transferable — literalmente nao sai da carteira",
  transferFeeConfig: "transfer fee — o criador leva um pedaco de cada transferencia (pode ser tudo)",
  defaultAccountState: "default account state — contas podem nascer congeladas",
  mintCloseAuthority: "mint close authority — o mint pode ser fechado por baixo de voce",
};

// Le o mint on-chain e devolve o que ele pode aprontar. `dangers` vazio = limpo.
export async function inspectMint(mint) {
  const acc = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
  const v = acc?.value;
  if (!v) return { ok: false, dangers: ["o mint nao existe on-chain"] };
  const info = v.data?.parsed?.info;
  if (!info) return { ok: false, dangers: ["nao consegui ler o mint"] };

  const dangers = [];
  const extensions = (info.extensions ?? []).map((e) => e.extension);
  for (const ext of extensions) {
    if (DANGEROUS_EXTENSIONS[ext]) dangers.push(DANGEROUS_EXTENSIONS[ext]);
  }
  // Vale para os DOIS programas de token: congelar a conta e a forma mais
  // simples de fazer um honeypot, e nao precisa de Token-2022 pra isso.
  if (info.freezeAuthority)
    dangers.push("freeze authority ativa — podem congelar sua conta e voce nao vende");

  return {
    ok: dangers.length === 0,
    dangers,
    extensions,
    tokenProgram: v.owner,
    isToken2022: v.owner === TOKEN_2022,
    freezeAuthority: info.freezeAuthority ?? null,
    mintAuthority: info.mintAuthority ?? null,
  };
}

// Valor total da carteira em USD. solUsd vem do feed de mercado que ja existe.
export function totalUsd({ sol, usdc }, solUsd) {
  return sol * solUsd + usdc;
}

// O detector. Compara o valor de agora com o de antes, desconta o que os trades
// explicam, e o que sobrar e renda de fora.
//
// A tolerancia existe porque preco de SOL oscila entre duas leituras e taxa de
// rede consome fracao — sem ela, todo tick reportaria centavos de "renda".
export function detectIncome({ before, after, tradePnl, tolerance = 0.02 }) {
  const delta = after - before;
  const unexplained = delta - tradePnl;
  if (Math.abs(unexplained) < tolerance) return { income: 0, unexplained: 0 };
  // Saida inexplicada nao vira "renda negativa": ou e taxa, ou e algo que
  // merece investigacao humana. Reporta, nao contabiliza.
  return { income: unexplained > 0 ? unexplained : 0, unexplained };
}

// ---------------------------------------------------------------------------
// VERIFICACAO DE PAGAMENTO (a porta da loja x402). Leitura pura: o comprador
// pagou da carteira DELE direto pro endereco do agente; aqui so se confere a
// transacao on-chain. Nenhuma chave, nenhuma assinatura — a trava do projeto
// nao chega perto disto.
// ---------------------------------------------------------------------------

// Janela de validade da transacao. Impede que alguem "reivindique" uma gorjeta
// antiga do historico como se fosse pagamento de agora.
const MAX_TX_AGE_MS = 24 * 3600 * 1000;

// Avalia o RESULTADO de getTransaction (funcao pura — testavel offline com
// fixture, sem rede). Soma o que a transacao ENTREGOU ao `payTo` em USDC
// (preferencia) ou SOL (convertido por solUsd) e compara com o preco.
// Tolerancia de 2% cobre oscilacao de preco entre a compra e a conferencia.
export function _evalTransfer(tx, { payTo, minUsd, solUsd, now = Date.now() }) {
  if (!tx) return { ok: false, reason: "transaction not found" };
  if (tx.meta?.err) return { ok: false, reason: "transaction failed on-chain" };
  const age = now - (tx.blockTime ?? 0) * 1000;
  if (!tx.blockTime || age > MAX_TX_AGE_MS) return { ok: false, reason: "transaction too old" };

  // USDC: delta dos token balances cujo dono e o payTo e o mint e o USDC.
  const usdcOf = (list) => (list ?? [])
    .filter((b) => b.mint === USDC_MINT && b.owner === payTo)
    .reduce((s, b) => s + (Number(b.uiTokenAmount?.uiAmount) || 0), 0);
  const usdcDelta = usdcOf(tx.meta?.postTokenBalances) - usdcOf(tx.meta?.preTokenBalances);

  // SOL: delta de lamports na posicao do payTo entre accountKeys.
  const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === "string" ? k : k?.pubkey));
  const idx = keys.indexOf(payTo);
  const lamportsDelta = idx >= 0
    ? ((tx.meta?.postBalances?.[idx] ?? 0) - (tx.meta?.preBalances?.[idx] ?? 0))
    : 0;
  const solUsdPaid = (lamportsDelta / 1e9) * (Number(solUsd) || 0);

  const floor = minUsd * 0.98;
  if (usdcDelta >= floor) return { ok: true, paidUsd: usdcDelta, method: "usdc" };
  if (solUsdPaid >= floor) return { ok: true, paidUsd: solUsdPaid, method: "sol" };
  return {
    ok: false,
    reason: `paid $${Math.max(usdcDelta, solUsdPaid).toFixed(2)} — needs $${minUsd.toFixed(2)}`,
  };
}

// Busca a transacao e avalia. `solUsd` vem do feed de mercado de quem chama.
export async function verifyPayment({ txSig, payTo, minUsd, solUsd }) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{60,120}$/.test(String(txSig ?? "")))
    return { ok: false, reason: "that does not look like a transaction signature" };
  let tx;
  try {
    tx = await rpc("getTransaction", [txSig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
  } catch (e) {
    return { ok: false, reason: `rpc: ${e.message}` };
  }
  return _evalTransfer(tx, { payTo, minUsd, solUsd });
}
