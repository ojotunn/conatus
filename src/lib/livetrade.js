// ============================================================================
// O TRADE NA TELA — o agente comprando na pump.fun como uma pessoa compra:
// carteira conectada, valor digitado, botao clicado, tudo ao vivo no palco.
//
// POR QUE ISTO EXISTE: o show e assistir. Uma ordem que sai por baixo, via API,
// da o mesmo resultado financeiro e nenhum espetaculo — o espectador ve um
// numero mudar e nada acontecer. Aqui o ato e visivel.
//
// A TRAVA, AGORA VERIFICADA (decisao do Michel, 12/08/2026):
// a carteira injetada passa a poder assinar TRANSACAO, mas cada pedido da
// pagina atravessa o mesmo portao que ja protege o caminho do PumpPortal —
// que tambem e um terceiro montando transacao:
//     estrutura -> lista branca de programas -> simulacao -> delta de saldo
//     dentro do teto em dolar.
// A pagina pode PEDIR. Passar, so o que for trade legitimo do proprio agente.
//
// Se qualquer passo daqui falhar (site mudou, modal novo, botao renomeado), o
// chamador cai no caminho on-chain do executor. A tela e o show; o dinheiro
// nao pode depender de um seletor de CSS.
// ============================================================================

import * as chrome from "./browser.js";
import * as pumpauth from "./pumpauth.js";
import { load as loadWallet, b58encode } from "./signer.js";
import { attachWallet } from "./pumpwallet.js";
import { approveAndSign, sendSigned } from "./executor.js";

const KEYPAIR_ENV = { sable: "SABLE_SOL_KEYPAIR", rook: "ROOK_SOL_KEYPAIR" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Guarda o portao armado por agente, pra nao reinstalar a cada trade.
const armed = new Map(); // agentId -> { detach, maxSolSpend }

// ---------------------------------------------------------------------------
// ARMA o portao na aba do agente: a carteira passa a existir para a pagina, e
// todo pedido de assinatura de transacao passa pela verificacao do executor.
// `maxSolSpend` e o teto DURO daquele momento — quem chama define.
// ---------------------------------------------------------------------------
export async function armWallet(agentId, { maxSolSpend, onEvent = null }) {
  const page = await chrome.getAgentPage(agentId);
  const wallet = loadWallet(KEYPAIR_ENV[agentId]);
  const say = (m) => { if (onEvent) { try { onEvent(m); } catch {} } };

  const gate = async (txBytes, { send }) => {
    say(`the page asked to sign a transaction (${txBytes.length} bytes)`);
    const v = await approveAndSign(txBytes, {
      owner: wallet.address,
      keypairEnvKey: KEYPAIR_ENV[agentId],
      maxSolSpend: armed.get(agentId)?.maxSolSpend ?? maxSolSpend,
    });
    if (!v.ok) { say(`REFUSED — ${v.reason}`); return { ok: false, reason: v.reason }; }
    say(`approved · spends ${v.spentSol?.toFixed(6)} SOL · programs ${v.programs?.map((p) => p.slice(0, 6)).join(",")}`);

    // A assinatura fica nos primeiros 64 bytes da transacao assinada.
    const signature = v.signed.subarray(1, 65);
    if (send) {
      const sent = await sendSigned(v.signed);
      if (!sent.ok) { say(`send failed — ${sent.reason}`); return { ok: false, reason: sent.reason }; }
      say(`sent · ${sent.signature}`);
      lastSignature.set(agentId, sent.signature);
    } else {
      // A pump.fun pede `signTransaction` e transmite ELA MESMA. A assinatura
      // que devolvemos JA E o id da transacao — sem registrar isto aqui, a
      // compra acontecia de verdade (o SOL saia da carteira) e mesmo assim era
      // reportada como "nao completou a tempo", e o show caia no caminho
      // on-chain para comprar DE NOVO.
      lastSignature.set(agentId, b58encode(signature));
    }
    return { ok: true, signature };
  };

  const prev = armed.get(agentId);
  if (prev) { armed.set(agentId, { ...prev, maxSolSpend }); return prev; }

  const att = await attachWallet(page, wallet, {
    mode: "sign",
    walletName: "Phantom",
    approveTransaction: gate,
    onTxRequest: (i) => say(`tx request: ${i.bytes} bytes${i.send ? " (sign+send)" : ""}`),
  });
  const rec = { detach: att.detach, maxSolSpend };
  armed.set(agentId, rec);
  return rec;
}

// A ultima assinatura enviada por este caminho (o palco mostra o link).
export const lastSignature = new Map();

// ---------------------------------------------------------------------------
// Clique real por texto (o mesmo truque do login: clique sintetico dentro de
// evaluate nao abre modal da pump; tem que ser clique de verdade).
// ---------------------------------------------------------------------------
async function clickText(page, rx, sel = "button,[role=button],a") {
  const h = await page.evaluateHandle((src, s) => {
    const re = new RegExp(src, "i");
    return [...document.querySelectorAll(s)]
      .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .find((b) => re.test((b.innerText || b.textContent || "").trim())) ?? null;
  }, rx.source, sel);
  const el = h.asElement();
  if (!el) return false;
  await el.click().catch(() => {});
  return true;
}

// Clique que funciona TAMBEM no que nao e botao.
//
// A pump.fun monta abas ("Buy"/"Sell"), atalhos ($25/$100) e o alternador de
// unidade como DIV/SPAN sem `role=button` — procurar por `button` nao acha nada
// e a falha sai como "nao achei a aba de venda". A mesma coisa acontecia com a
// carteira no modal, e o que resolveu foi achar a FOLHA com o texto e clicar na
// COORDENADA dela (receita do `pumpauth.walletSpot`). Aqui vale o mesmo.
//
// `prefer` desfaz uma ambiguidade perigosa: "Buy" e o nome DA ABA e tambem do
// BOTAO que dispara a ordem. Clicar no botao achando que era a aba manda uma
// ordem. No painel da pump.fun a aba fica ACIMA do campo de valor e o botao
// ABAIXO, entao a geometria decide: "top" pra aba, "bottom" pra acao.
async function clickByLeafText(page, rx, { prefer = "bottom" } = {}) {
  const spot = await page.evaluate((src, pref) => {
    const re = new RegExp(src, "i");
    const achados = [];
    const anda = (raiz) => {
      let els = [];
      try { els = [...raiz.querySelectorAll("*")]; } catch { return; }
      for (const el of els) {
        const t = (el.textContent || "").trim();
        if (t && t.length < 40 && re.test(t)) {
          const r = el.getBoundingClientRect();
          // So o que esta REALMENTE na tela: clicar fora da viewport nao faz nada.
          if (r.width > 0 && r.height > 0 && r.top >= 0 && r.top < innerHeight) {
            achados.push({
              folha: el.children.length === 0,
              x: Math.round(r.x + r.width / 2),
              y: Math.round(r.y + r.height / 2),
            });
          }
        }
        if (el.shadowRoot) anda(el.shadowRoot);
      }
    };
    anda(document);
    // A folha e o alvo bom (o SPAN com a palavra), nao o container que a envolve.
    const folhas = achados.filter((a) => a.folha);
    const lista = folhas.length ? folhas : achados;
    if (!lista.length) return null;
    lista.sort((a, b) => a.y - b.y);
    return pref === "top" ? lista[0] : lista[lista.length - 1];
  }, rx.source, prefer).catch(() => null);
  if (!spot) return false;
  await page.mouse.click(spot.x, spot.y);
  return true;
}

// Dispensa o que costuma ficar por cima (cookies, boas-vindas).
async function clearOverlays(page) {
  for (const rx of [/^(accept all|reject all)$/i, /^continue$/i, /^(i agree|got it|ok)$/i]) {
    if (await clickText(page, rx)) await sleep(600);
  }
}

// Escreve num input como uma pessoa escreve (o React so reage ao setter nativo
// + evento de input; atribuir `.value` direto nao dispara nada).
async function typeAmount(page, valor) {
  return page.evaluate((v) => {
    const inputs = [...document.querySelectorAll("input")]
      .filter((i) => { const r = i.getBoundingClientRect(); return r.width > 40 && r.height > 10; });
    const alvo = inputs.find((i) => /amount|sol|0\.0/i.test(i.placeholder || "")) ?? inputs[0];
    if (!alvo) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(alvo, String(v));
    alvo.dispatchEvent(new Event("input", { bubbles: true }));
    alvo.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, String(valor));
}

// A SESSAO DO NAVEGADOR MORREU no meio da operacao?
//
// Numa transmissao longa isso acontece: o Browserbase encerra a sessao, a aba
// fecha, e o clique seguinte estoura com "Target closed". Nao e erro de logica
// — e o mundo. Quem trata isso reabre a aba e tenta de novo UMA vez; sem isso,
// o show perde a tela toda vez que a sessao expira (visto em 12/08/2026).
function sessaoMorreu(e) {
  return /target closed|session closed|detached|browser has disconnected|connection closed/i
    .test(String(e?.message ?? e));
}

// Reabre tudo depois de uma sessao morta: aba nova E carteira presa de novo.
// So limpar `armed` nao basta — o registro e o que impede o `attachWallet` de
// rodar duas vezes, entao sem apaga-lo a aba nova ficaria SEM carteira e a
// tentativa seguinte falharia num lugar diferente, parecendo outro bug.
async function ressuscitar(agentId, say) {
  const teto = armed.get(agentId)?.maxSolSpend ?? 0;
  armed.delete(agentId);
  await chrome.getAgentPage(agentId);          // recria a aba (e a sessao, se preciso)
  await armWallet(agentId, { maxSolSpend: teto });
  if (say) say("the browser session had died — reopened it");
}

// Espera a assinatura aparecer (o portao assina e envia por baixo).
async function waitSignature(agentId, segundos = 30) {
  for (let i = 0; i < segundos; i++) {
    const sig = lastSignature.get(agentId);
    if (sig) return sig;
    await sleep(1000);
  }
  return null;
}

// Conecta a carteira na pagina. NAO reimplementar aqui: a receita mora no
// `pumpauth` (banner de cookies, clique por coordenada na folha, shadow DOM,
// esperas longas, sucesso medido por fato da PAGINA e nao por flag nossa).
// A versao caseira que existia aqui reprovou as quatro tentativas de trade na
// tela em 12/08/2026 — o dinheiro saiu pela corrente e o show nao aconteceu.
//
// A carteira ja esta presa nesta aba pelo `armWallet`, com poder de assinar
// transacao; `ensureLoggedIn` nao mexe nisso, so clica.
async function ensureConnected(page, say) {
  const r = await pumpauth.ensureLoggedIn(page, { timeoutMs: 90000, onEvent: say });
  if (r.ok && say) say(r.alreadyLoggedIn ? "already signed in" : "signed in on screen");
  return r.ok ? true : r.error;
}

// ---------------------------------------------------------------------------
// COMPRA NA TELA. Abre a pagina da moeda, conecta, digita o valor em SOL e
// clica no botao de compra. Devolve { ok, signature } — ou o motivo da falha,
// pro chamador cair no caminho on-chain sem drama.
// ---------------------------------------------------------------------------
// `solUsd` e obrigatorio na pratica: sem ele nao da pra saber quanto digitar
// quando o campo esta em dolar. Sem preco, cai em SOL e avisa.
export async function buyOnScreen(agentId, mint, amountSol, { onEvent = null, solUsd = 0, _2a = false } = {}) {
  const say = (m) => { if (onEvent) { try { onEvent(m); } catch {} } };
  try {
    const page = await chrome.getAgentPage(agentId);
    lastSignature.delete(agentId);

    // NAO confie na URL como prova de que a pagina existe.
    //
    // `market.openUrl` cai num fetch HTTP puro quando a navegacao do navegador
    // falha, e devolve o texto como se tivesse dado certo — o palco mostra a
    // moeda, o excerpt vem cheio, e a aba de verdade ficou na tela de erro do
    // Chrome COM A URL DA MOEDA na barra. Em 12/08/2026 eu otimizei "nao
    // renavega se ja estiver na moeda" olhando so `page.url()`, e com isso
    // pulava justamente a navegacao que consertaria a pagina morta.
    //
    // Estar viva vale mais que estar na URL certa: navega se faltar qualquer
    // uma das duas. A pump.fun demora pra montar o painel — 10s e o que a
    // receita do `pumpauth` aprendeu na marra; 2.5s nao bastava.
    const naMoeda = page.url().includes(mint);
    const viva = !(await pumpauth.pareceMorta(page));
    if (!naMoeda || !viva) {
      if (!viva) say("the page was blank — loading the coin again");
      await page.goto(`https://pump.fun/coin/${mint}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(10000);
    }
    await clearOverlays(page);

    const conn = await ensureConnected(page, say);
    if (conn !== true) return { ok: false, reason: `nao consegui conectar a carteira na pagina (${conn})` };
    await sleep(800);

    // A aba de COMPRA tem que estar escolhida antes de procurar o campo — o
    // painel comeca em "Buy", mas nao da pra contar com isso depois de uma
    // navegacao qualquer.
    await clickByLeafText(page, /^buy$/i, { prefer: "top" }); // a ABA, nao o botao
    await sleep(600);

    // UNIDADE: o painel alterna entre USD e SOL (o botao "USD ⇅"). Digitar um
    // numero em SOL num campo em USD compra ~75x a mais.
    const unidade = await page.evaluate(() => {
      const alt = [...document.querySelectorAll("button,[role=button]")]
        .map((b) => (b.innerText || "").trim().replace(/\s+/g, " "))
        .find((t) => /^(usd|sol)\s*⇅?$/i.test(t)) || "";
      return /^sol/i.test(alt) ? "SOL" : "USD";
    }).catch(() => "USD");
    const emSol = unidade === "SOL" || !(solUsd > 0);
    const valor = emSol ? amountSol.toFixed(6) : (amountSol * solUsd).toFixed(2);

    // NAO ADIVINHAR QUAL E O CAMPO — VERIFICAR.
    //
    // O painel tem varios inputs e o de valor nao e o obvio: o `type=number`
    // (0x0) e outra coisa, e o de valor e um `text` de 1x68. Pior: escrever no
    // `.value` enche o DOM sem mover o estado do React, e o botao continua
    // "Enter an amount", desabilitado — o clique sai e nenhuma transacao e
    // montada. Entao: digita no teclado, campo a campo, ate o botao de acao
    // virar "Buy $X.XX". Quando ele aparece, o site aceitou o valor de fato.
    const candidatos = await page.evaluate(() =>
      [...document.querySelectorAll("input")]
        .map((i, n) => ({ n, tipo: i.type, h: Math.round(i.getBoundingClientRect().height) }))
        .filter((c) => !/^(checkbox|radio|hidden|submit|button)$/i.test(c.tipo))
        // O de altura visivel primeiro: e o campo real do painel.
        .sort((a, b) => b.h - a.h)
        .map((c) => c.n)
    ).catch(() => []);

    let pronto = null;
    for (const n of candidatos) {
      await page.evaluate((i) => document.querySelectorAll("input")[i]?.focus(), n);
      await page.keyboard.down("Control");
      await page.keyboard.press("KeyA");
      await page.keyboard.up("Control");
      await page.keyboard.type(String(valor), { delay: 90 });
      await sleep(1000);
      pronto = await page.evaluate(() =>
        [...document.querySelectorAll("button,[role=button]")]
          .filter((b) => !b.disabled)
          .map((b) => (b.innerText || "").trim())
          .find((t) => /^buy\s*\$\s*[\d.,]+/i.test(t)) ?? null
      ).catch(() => null);
      if (pronto) break;
    }

    if (!pronto) {
      const diag = await page.evaluate(() => ({
        inputs: [...document.querySelectorAll("input")].map((i) => {
          const r = i.getBoundingClientRect();
          return { tipo: i.type, valor: i.value, h: Math.round(r.height) };
        }),
        botoes: [...document.querySelectorAll("button,[role=button]")]
          .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 60 && r.height > 20; })
          .map((b) => ({ t: (b.innerText || "").trim().slice(0, 24), off: b.disabled })),
      })).catch(() => null);
      console.log(`[diag ${new Date().toISOString()}] o painel nao aceitou o valor: ${JSON.stringify(diag)}`);
      return { ok: false, reason: "o painel nao aceitou o valor" };
    }
    say(`typed ${valor} ${unidade} — the button now reads "${pronto}"`);

    // O botao traz o VALOR no texto ("Buy $1.00"), entao `/^buy$/` nunca casa.
    // Clicar pelo texto exato dele tambem elimina a confusao com a aba "Buy".
    if (!(await clickByLeafText(page, new RegExp(`^${pronto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i")))) {
      return { ok: false, reason: `nao consegui clicar em "${pronto}"` };
    }
    say("clicked buy — waiting for the chain");

    const sigOk = await waitSignature(agentId, 40);
    if (sigOk) return { ok: true, signature: sigOk, url: `https://solscan.io/tx/${sigOk}` };
    return { ok: false, reason: "a pagina nao completou a compra a tempo" };
  } catch (e) {
    // Sessao caiu no meio: reabre e tenta UMA vez. Duas seria insistir contra
    // um ambiente que claramente nao esta de pe.
    if (sessaoMorreu(e) && !_2a) {
      await ressuscitar(agentId, say).catch(() => {});
      return buyOnScreen(agentId, mint, amountSol, { onEvent, solUsd, _2a: true });
    }
    return { ok: false, reason: e.message };
  }
}


// ---------------------------------------------------------------------------
// VENDA NA TELA. O ciclo tem que ser assistivel inteiro — ver o agente comprar
// e depois o dinheiro voltar por baixo, sem tela, seria contar metade.
//
// A pump.fun tem aba "sell" e botoes de porcentagem (25/50/100%). Tentamos o
// caminho da porcentagem primeiro (e o que uma pessoa clica) e caimos no campo
// de valor se nao existir.
// ---------------------------------------------------------------------------
export async function sellOnScreen(agentId, mint, { percent = 100, onEvent = null, _2a = false } = {}) {
  const say = (m) => { if (onEvent) { try { onEvent(m); } catch {} } };
  try {
    const page = await chrome.getAgentPage(agentId);
    lastSignature.delete(agentId);

    // Se ja nao estivermos na moeda, vai pra ela — o espectador precisa ver
    // qual token esta sendo vendido.
    // Mesma regra da compra: viva importa mais que estar na URL certa.
    if (!page.url().includes(mint) || (await pumpauth.pareceMorta(page))) {
      await page.goto(`https://pump.fun/coin/${mint}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(10000);
      await clearOverlays(page);
    }
    const conn = await ensureConnected(page, say);
    if (conn !== true) return { ok: false, reason: `carteira nao conectada para vender (${conn})` };

    // Troca pra aba de venda.
    if (!(await clickByLeafText(page, /^sell$/i, { prefer: "top" }))) { // a ABA
      return { ok: false, reason: "nao achei a aba de venda" };
    }
    say("switched to the sell tab");
    await sleep(900);

    // Porcentagem (o clique de gente) e, se nao houver, o campo de valor.
    const pctRx = new RegExp(`^${percent}\\s*%$`, "i");
    if (await clickByLeafText(page, pctRx)) {
      say(`clicked ${percent}%`);
    } else {
      const saldo = await page.evaluate(() => {
        const m = document.body.innerText.match(/balance[:\s]+([\d.,]+)/i);
        return m ? m[1].replace(/,/g, "") : null;
      });
      if (!saldo) return { ok: false, reason: "nao achei nem o botao de % nem o saldo para vender" };
      const qtd = (Number(saldo) * percent) / 100;
      if (!(await typeAmount(page, qtd))) return { ok: false, reason: "nao achei o campo de quantidade" };
      say(`typed ${qtd} tokens into the sell box`);
    }
    await sleep(1200);

    // O botao de acao NAO se chama so "Sell": como na compra, ele traz o que
    // esta sendo vendido ("Sell 466,254 Owl Runner"). Regex ancorado em
    // `^sell$` so casa com a ABA, e clicar na aba nao vende nada. Espera o
    // botao habilitado aparecer e clica NELE, pelo texto exato — assim nao ha
    // como confundir com a aba.
    const acao = await page.evaluate(() =>
      [...document.querySelectorAll("button,[role=button]")]
        .filter((b) => !b.disabled)
        .map((b) => (b.innerText || "").trim().replace(/\s+/g, " "))
        .find((t) => /^sell\b.+/i.test(t) || /^(place trade|confirm)$/i.test(t)) ?? null
    ).catch(() => null);

    if (!acao) {
      const diag = await page.evaluate(() => [...document.querySelectorAll("button,[role=button]")]
        .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 60 && r.height > 20; })
        .map((b) => ({ t: (b.innerText || "").trim().slice(0, 28), off: b.disabled }))).catch(() => null);
      console.log(`[diag ${new Date().toISOString()}] botao de vender nao apareceu: ${JSON.stringify(diag)}`);
      return { ok: false, reason: "o painel nao habilitou a venda" };
    }

    if (!(await clickByLeafText(page, new RegExp(`^${acao.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i")))) {
      return { ok: false, reason: `nao consegui clicar em "${acao}"` };
    }
    say(`clicked "${acao}" — waiting for the chain`);

    const sig = await waitSignature(agentId, 40);
    if (sig) return { ok: true, signature: sig, url: `https://solscan.io/tx/${sig}` };
    return { ok: false, reason: "a pagina nao completou a venda a tempo" };
  } catch (e) {
    if (sessaoMorreu(e) && !_2a) {
      await ressuscitar(agentId, say).catch(() => {});
      return sellOnScreen(agentId, mint, { percent, onEvent, _2a: true });
    }
    return { ok: false, reason: e.message };
  }
}
