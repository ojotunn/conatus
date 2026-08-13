// ============================================================================
// Carteira injetada no navegador do agente (Wallet Standard + provider legado).
//
// O agente entra num site que autentica por carteira do mesmo jeito que uma
// pessoa entra: o site enxerga uma carteira instalada, pede conexao, pede uma
// assinatura de login, e recebe.
//
// ONDE A CHAVE FICA: no Node, nunca na pagina. A pagina tem UMA funcao exposta,
// `__arenaWalletRPC`, e nada mais. Quem assina e o `signer`, que RECUSA
// qualquer payload que nao seja texto legivel. Uma transacao Solana serializada
// nao passa nesse filtro, entao nao existe caminho — deste modulo ou de
// qualquer pagina — que transforme a chave do agente em transacao assinada.
// A trava do projeto continua sendo a ausencia da funcao, nao a boa vontade.
//
// UMA ponte, um formato. A versao anterior deste arquivo tinha quatro pontes
// sobrepostas: a que o codigo chamava era apagada por um `evaluateOnNewDocument`
// posterior, e a conversao de base58 lia um cache que ninguem escrevia. Era
// codigo morto em cima de codigo morto, e o sintoma foi o site nunca enxergar
// carteira nenhuma. Se um dia precisar de outra operacao, ela vira um `op` novo
// no mesmo RPC — nao uma segunda ponte.
// ============================================================================

import { b58decode } from "./signer.js";

const RPC = "__arenaWalletRPC";
const prepared = new WeakSet(); // paginas que ja receberam a ponte

// ---------------------------------------------------------------------------
// Roda DENTRO da pagina, antes de qualquer script do site.
// Nao pode fechar sobre nada do Node: tudo entra por argumento.
// ---------------------------------------------------------------------------
function installWallet(address, pubBytes, walletName, rpcName, canSignTx) {
  const pub = Uint8Array.from(pubBytes);
  const dec = new TextDecoder();

  async function ask(op, payload) {
    const raw = await window[rpcName](JSON.stringify({ op, ...payload }));
    const r = JSON.parse(raw);
    if (!r.ok) {
      // Recusa da nossa ponte se parece, para o site, com o usuario clicando
      // "Cancelar" — que e exatamente o que ela e.
      const err = new Error(r.code === "observe" ? "User rejected the request." : "User rejected the request.");
      err.code = 4001;
      throw err;
    }
    return r;
  }

  async function signBytes(messageBytes) {
    const r = await ask("signMessage", { bytes: Array.from(messageBytes) });
    return Uint8Array.from(r.signature);
  }

  // ------------------------------------------------------------------------
  // TRANSACAO. So existe quando `canSignTx` — e ele so vem ligado quando o
  // engine explicitamente arma o portao (checagens + teto) do outro lado.
  //
  // A pagina manda a transacao INTEIRA serializada; quem decide e o Node.
  // A pagina nunca ve a chave e nunca recebe um "sim" que nao tenha passado
  // por lista branca, simulacao e teto de gasto.
  // ------------------------------------------------------------------------
  function txToBytes(tx) {
    // BYTES JA SERIALIZADOS — o caso que a pump.fun usa.
    //
    // A spec do Wallet Standard entrega `transaction` como Uint8Array, nao como
    // objeto do web3.js. Este codigo assumia o objeto e chamava `.serialize()`,
    // estourando com "tx.serialize is not a function" DENTRO da pagina — antes
    // do portao, entao nenhum log aparecia e a compra na tela simplesmente
    // expirava em silencio (12/08/2026).
    if (tx instanceof Uint8Array) return { bytes: tx, crua: true };
    if (tx && typeof tx.serialize !== "function" &&
        (Array.isArray(tx) || typeof tx.length === "number")) {
      return { bytes: Uint8Array.from(tx), crua: true };
    }
    // VersionedTransaction: tem .message e .signatures (array de Uint8Array).
    if (tx?.message && Array.isArray(tx?.signatures)) {
      return { bytes: tx.serialize(), versioned: true, crua: false };
    }
    // Transaction legada: serializa sem exigir assinatura.
    return {
      bytes: tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
      versioned: false,
      crua: false,
    };
  }

  // Escreve a assinatura de volta no objeto que o site nos deu, sem precisar
  // do construtor do web3.js da pagina (que nao temos referencia).
  function applySignature(tx, sig, versioned) {
    if (versioned) tx.signatures[0] = sig;
    else if (Array.isArray(tx.signatures) && tx.signatures[0]) tx.signatures[0].signature = sig;
    return tx;
  }

  async function doSignTransaction(tx) {
    const { bytes, versioned, crua } = txToBytes(tx);
    const r = await ask("signTransaction", { bytes: Array.from(bytes), versioned: !!versioned });
    const sig = Uint8Array.from(r.signature);
    if (crua) {
      // Formato da transacao: [contagem de assinaturas][64 bytes por slot][mensagem].
      // Recebemos bytes, devolvemos bytes — com a nossa assinatura no 1o slot,
      // que e o que o Wallet Standard espera como `signedTransaction`.
      const out = Uint8Array.from(bytes);
      out.set(sig, 1);
      return out;
    }
    return applySignature(tx, sig, versioned);
  }

  async function doSignAndSend(tx) {
    const { bytes, versioned } = txToBytes(tx);
    const r = await ask("signAndSendTransaction", { bytes: Array.from(bytes), versioned: !!versioned });
    return Uint8Array.from(r.signature); // assinatura da transacao enviada
  }

  const account = {
    address,
    publicKey: pub,
    chains: ["solana:mainnet"],
    // So anuncia o que implementa. Anunciar capacidade que nao existe faz o
    // site chamar o vazio — e um site em loop trava a aba inteira.
    features: canSignTx
      ? ["solana:signMessage", "solana:signTransaction", "solana:signAndSendTransaction"]
      : ["solana:signMessage"],
    label: walletName,
    icon: undefined,
  };

  const listeners = {};
  const wallet = {
    version: "1.0.0",
    name: walletName,
    icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiLz4=",
    chains: ["solana:mainnet"],
    accounts: [account],
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: async () => {
          window.__arenaConnected = true;
          return { accounts: [account] };
        },
      },
      "standard:disconnect": {
        version: "1.0.0",
        disconnect: async () => { window.__arenaConnected = false; },
      },
      "standard:events": {
        version: "1.0.0",
        on: (name, fn) => {
          (listeners[name] ||= []).push(fn);
          return () => { listeners[name] = (listeners[name] || []).filter((f) => f !== fn); };
        },
      },
      "solana:signMessage": {
        version: "1.0.0",
        signMessage: async (...args) => {
          const inputs = Array.isArray(args[0]) ? args[0] : args;
          const out = [];
          for (const i of inputs) {
            const signature = await signBytes(i.message);
            out.push({ signedMessage: i.message, signature });
          }
          return out;
        },
      },
      // As duas features de transacao so existem no objeto quando canSignTx.
      //
      // `supportedTransactionVersions` NAO e opcional: a spec do Wallet
      // Standard exige, e os adaptadores leem `.length`/`.includes` nela sem
      // checar. Sem o campo, o site estoura
      //     TypeError: Cannot read properties of undefined (reading 'length')
      // o React desmonta e a aba vira uma tela em branco — com a carteira
      // "injetada com sucesso". Foi o que derrubou o trade na tela o dia
      // inteiro em 12/08/2026, e por isso SO acontecia no caminho do trade:
      // o login injeta com canSignTx=false, onde estas features nem existem.
      ...(canSignTx ? {
        "solana:signTransaction": {
          version: "1.0.0",
          supportedTransactionVersions: ["legacy", 0],
          signTransaction: async (...args) => {
            const inputs = Array.isArray(args[0]) ? args[0] : args;
            const out = [];
            for (const i of inputs) {
              const tx = i.transaction ?? i;
              const signed = await doSignTransaction(tx);
              out.push({ signedTransaction: signed?.serialize ? signed.serialize() : signed });
            }
            return out;
          },
        },
        "solana:signAndSendTransaction": {
          version: "1.0.0",
          supportedTransactionVersions: ["legacy", 0],
          signAndSendTransaction: async (...args) => {
            const inputs = Array.isArray(args[0]) ? args[0] : args;
            const out = [];
            for (const i of inputs) {
              const tx = i.transaction ?? i;
              out.push({ signature: await doSignAndSend(tx) });
            }
            return out;
          },
        },
      } : {}),
    },
  };

  window.__arenaWallet = wallet;

  // O handshake do Wallet Standard, na ordem certa. O app chama
  // `event.detail({register})` — o detail e um OBJETO com `register`, nao a
  // funcao de registro. Trocar os dois faz a chamada estourar dentro do catch
  // e a carteira nunca aparece; foi exatamente o bug da versao anterior.
  window.addEventListener("wallet-standard:app-ready", (e) => {
    try { e.detail.register(wallet); } catch (err) { window.__arenaRegisterError = String(err); }
  });
  window.dispatchEvent(
    new CustomEvent("wallet-standard:register-wallet", {
      detail: (api) => {
        try { (api?.register ?? api)(wallet); }
        catch (err) { window.__arenaRegisterError = String(err); }
      },
    })
  );

  // Provider legado. Alguns sites so checam `window.solana`.
  // Com canSignTx DESLIGADO ele continua sem signTransaction nenhum: o site
  // encontra AUSENCIA, nao recusa educada — que era o comportamento original.
  // Ligado, as funcoes existem mas cada chamada passa pelo portao no Node.
  const legacy = {
    isPhantom: true,
    isConnected: false,
    publicKey: { toString: () => address, toBytes: () => pub, toBase58: () => address },
    connect: async () => {
      legacy.isConnected = true;
      window.__arenaConnected = true;
      return { publicKey: legacy.publicKey };
    },
    disconnect: async () => { legacy.isConnected = false; },
    signMessage: async (msg) => ({
      signature: await signBytes(msg instanceof Uint8Array ? msg : new TextEncoder().encode(String(msg))),
      publicKey: legacy.publicKey,
    }),
    on: () => {},
    off: () => {},
    removeAllListeners: () => {},
    request: async ({ method, params }) => {
      if (method === "connect") return legacy.connect();
      if (method === "disconnect") return legacy.disconnect();
      if (method === "signMessage") {
        const m = params?.message;
        return legacy.signMessage(m instanceof Uint8Array ? m : new TextEncoder().encode(String(m ?? "")));
      }
      if (canSignTx && method === "signTransaction") return doSignTransaction(params?.message ?? params);
      if (canSignTx && method === "signAndSendTransaction") {
        return { signature: await doSignAndSend(params?.message ?? params) };
      }
      throw new Error(`metodo nao suportado: ${method}`);
    },
  };
  if (canSignTx) {
    legacy.signTransaction = doSignTransaction;
    legacy.signAllTransactions = async (txs) => {
      const out = [];
      for (const t of txs) out.push(await doSignTransaction(t));
      return out;
    };
    legacy.signAndSendTransaction = async (tx) => ({ signature: await doSignAndSend(tx) });
  }
  window.phantom = { solana: legacy };
  window.solana = legacy;
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

/**
 * Prepara uma pagina para ter a carteira do agente.
 *
 * @param page        Page do Puppeteer
 * @param wallet      { address, signMessage(bytes) } — o retorno de signer.load()
 * @param mode        "sign" assina de verdade; "observe" NUNCA assina (sonda)
 * @param onSignRequest  (texto) => void — auditoria: o que o site pediu
 * @param walletName  nome exibido na lista de carteiras do site
 * @param approveTransaction  async (bytes, {send}) => { ok, signature?, reason? }
 *        O PORTAO. Sem ele, assinar transacao NAO EXISTE nesta pagina — a
 *        carteira nem anuncia a capacidade, e o site ve ausencia (o
 *        comportamento original do projeto). Com ele, cada pedido da pagina
 *        passa por lista branca + simulacao + teto ANTES de a chave ser usada.
 * @param onTxRequest  (info) => void — auditoria de cada pedido de transacao
 */
export async function attachWallet(page, wallet, {
  mode = "sign",
  onSignRequest = null,
  walletName = "Phantom",
  approveTransaction = null,
  onTxRequest = null,
} = {}) {
  const log = [];

  if (!prepared.has(page)) {
    const handler = async (raw) => {
      let req;
      try { req = JSON.parse(String(raw)); } catch { return JSON.stringify({ ok: false, code: "bad-request" }); }

      // ---------------------------------------------------------------
      // TRANSACAO pedida pela pagina. Sem portao armado, a resposta e a
      // mesma de sempre: nao existe. Com portao, ele decide — e a decisao
      // dele e final (a chave so e usada la dentro).
      // ---------------------------------------------------------------
      if (req.op === "signTransaction" || req.op === "signAndSendTransaction") {
        if (!approveTransaction) return JSON.stringify({ ok: false, code: "unsupported-op" });
        if (mode === "observe") return JSON.stringify({ ok: false, code: "observe" });
        const txBytes = Uint8Array.from(req.bytes ?? []);
        if (onTxRequest) {
          try { onTxRequest({ bytes: txBytes.length, versioned: !!req.versioned, send: req.op === "signAndSendTransaction" }); } catch {}
        }
        try {
          const r = await approveTransaction(txBytes, { send: req.op === "signAndSendTransaction" });
          if (!r?.ok) return JSON.stringify({ ok: false, code: "refused", why: String(r?.reason ?? "recusado").slice(0, 160) });
          return JSON.stringify({ ok: true, signature: Array.from(r.signature) });
        } catch (e) {
          return JSON.stringify({ ok: false, code: "refused", why: String(e.message).slice(0, 160) });
        }
      }

      if (req.op !== "signMessage") return JSON.stringify({ ok: false, code: "unsupported-op" });

      const bytes = Uint8Array.from(req.bytes ?? []);
      let texto = null;
      try { texto = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { /* binario */ }
      log.push({ at: Date.now(), text: texto, bytes: bytes.length });
      if (onSignRequest) { try { onSignRequest(texto, bytes.length); } catch {} }

      if (mode === "observe") return JSON.stringify({ ok: false, code: "observe" });

      try {
        // Assina os BYTES exatos que o site gerou. Decodificar para string e
        // recodificar mudaria o que e assinado e a verificacao falharia.
        const { signature } = wallet.signMessage(bytes);
        return JSON.stringify({ ok: true, signature: Array.from(b58decode(signature)) });
      } catch (e) {
        // Aqui cai o payload que nao e texto — ou seja, uma transacao.
        // A pagina recebe uma recusa; a chave nunca chega perto.
        return JSON.stringify({ ok: false, code: "refused", why: String(e.message).slice(0, 120) });
      }
    };

    try {
      await page.exposeFunction(RPC, handler);
    } catch (e) {
      // Pagina reusada entre logins: a ponte ja esta la, e tudo bem.
      if (!/already exists|has been registered/i.test(String(e.message))) throw e;
    }
    prepared.add(page);
  }

  const pubBytes = Array.from(b58decode(wallet.address));
  // A capacidade de assinar transacao so e ANUNCIADA quando ha portao.
  const canSignTx = !!approveTransaction;
  const script = await page.evaluateOnNewDocument(
    installWallet, wallet.address, pubBytes, walletName, RPC, canSignTx
  );

  // Se a pagina ja esta carregada, injeta agora tambem — `evaluateOnNewDocument`
  // so vale para a proxima navegacao.
  await page.evaluate(installWallet, wallet.address, pubBytes, walletName, RPC, canSignTx).catch(() => {});

  return {
    log,
    async detach() {
      try { await page.removeScriptToEvaluateOnNewDocument(script.identifier); } catch {}
    },
  };
}
