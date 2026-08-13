// ============================================================================
// Chat ao vivo da pump.fun — SOMENTE LEITURA.
//
// Protocolo capturado do proprio site (socket.io v4 sobre ws):
//   1. wss://livechat.pump.fun/socket.io/?EIO=4&transport=websocket
//   2. servidor manda  0{"sid":...}
//   3. cliente manda   40{"origin":"https://pump.fun","timestamp":<ms>,
//                          "token":null,"deviceId":"device-<uuid>"}
//   4. servidor manda  40{"sid":...}
//   5. cliente manda   42N["joinRoom",{roomId:<mint>,username:""}]
//      -> ack 43N[{authenticated:false,...,roomConfig:{tokenGateEnabled}}]
//   6. cliente manda   42N["getMessageHistory",{roomId,before:null,limit:50}]
//      -> ack 43N[[ ...mensagens... ]]
//   7. mensagens novas chegam como push 42["<evento>",{...message...}]
//
// LER NAO EXIGE LOGIN: o site conecta com token:null e recebe o historico.
// `authenticated:false` e o estado normal de quem so assiste.
//
// ENVIAR exige sessao — e a sessao viaja no COOKIE, nao no campo `token` do
// handshake (que continua `null` mesmo logado; capturado da propria pagina).
// Por isso `sendAs` recebe os cookies do perfil do agente:
//   8. cliente manda   42N["sendMessage",{roomId,message,username:<ENDERECO>}]
//      -> ack 43N[{ id, roomId, message, username, userAddress, ... }]
//   Repare que `username` no ENVIO leva o endereco da carteira, nao o nome de
//   exibicao — o servidor resolve o nome sozinho na resposta.
//
// Mensagem nova de qualquer um chega como push 42["newMessage",{...}], e o
// cliente confirma leitura com 42["messageReceived",{messageId}].
//
// Tudo que CHEGA daqui e ENTRADA NAO CONFIAVEL — texto de estranho digitado
// direto para os agentes, a maior superficie de injecao do projeto. O engine
// trata como dado, nunca como instrucao.
// ============================================================================

import WebSocket from "ws";
import crypto from "node:crypto";

const URL = "wss://livechat.pump.fun/socket.io/?EIO=4&transport=websocket";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const KEEP = 120; // mensagens mantidas por sala

const rooms = new Map(); // mint -> { ws, messages, seen, config, closed }

function normalize(m) {
  return {
    id: m.id,
    text: String(m.message ?? ""),
    username: String(m.username ?? "anon"),
    address: String(m.userAddress ?? ""),
    at: m.timestamp ? Date.parse(m.timestamp) : Date.now(),
    isCreator: !!m.isCreator,
    isModerator: !!m.isModerator,
  };
}

function push(room, raw) {
  const m = normalize(raw);
  if (!m.id || room.seen.has(m.id)) return;
  room.seen.add(m.id);
  room.messages.push(m);
  if (room.messages.length > KEEP) room.messages.shift();
}

// Abre (ou reusa) a sala do mint. Resolve quando o historico chega.
export function join(mint, { timeout = 15000 } = {}) {
  const existing = rooms.get(mint);
  if (existing && !existing.closed) return Promise.resolve(existing);

  const room = { ws: null, messages: [], seen: new Set(), config: null, closed: false };
  rooms.set(mint, room);

  return new Promise((resolve, reject) => {
    let ackId = 0;
    const pending = new Map(); // id do ack -> handler
    const ws = new WebSocket(URL, { headers: { origin: "https://pump.fun", "user-agent": UA } });
    room.ws = ws;

    const emit = (event, payload, onAck) => {
      const id = ackId++;
      if (onAck) pending.set(id, onAck);
      ws.send(`42${id}${JSON.stringify([event, payload])}`);
    };

    const timer = setTimeout(() => reject(new Error("livechat: timeout no join")), timeout);

    ws.on("message", (data) => {
      const s = data.toString();

      if (s.startsWith("0{")) {
        // Handshake do namespace: o site manda esse envelope; token null = anonimo.
        ws.send(`40${JSON.stringify({
          origin: "https://pump.fun",
          timestamp: Date.now(),
          token: null,
          deviceId: `device-${crypto.randomUUID()}`,
        })}`);
        return;
      }

      if (s.startsWith("40")) {
        emit("joinRoom", { roomId: mint, username: "" }, (payload) => {
          room.config = payload?.[0] ?? null;
          emit("getMessageHistory", { roomId: mint, before: null, limit: 50 }, (hist) => {
            for (const m of hist?.[0] ?? []) push(room, m);
            // Historico vem do mais novo para o mais velho; queremos cronologico.
            room.messages.sort((a, b) => a.at - b.at);
            clearTimeout(timer);
            resolve(room);
          });
        });
        return;
      }

      if (s === "2") { ws.send("3"); return; } // ping do servidor

      // Ack de algo que pedimos: 43<id>[payload]
      const ack = s.match(/^43(\d+)(\[[\s\S]*)$/);
      if (ack) {
        const fn = pending.get(Number(ack[1]));
        pending.delete(Number(ack[1]));
        if (fn) { try { fn(JSON.parse(ack[2])); } catch {} }
        return;
      }

      // Push do servidor: 42[evento, payload]. Nao adivinhamos o nome do evento
      // de mensagem nova — qualquer payload com `message` + `id` e uma fala.
      const ev = s.match(/^42(\[[\s\S]*)$/);
      if (ev) {
        try {
          const [, payload] = JSON.parse(ev[1]);
          if (payload && typeof payload.message === "string" && payload.id) push(room, payload);
        } catch {}
      }
    });

    ws.on("error", (e) => { clearTimeout(timer); room.closed = true; reject(e); });
    ws.on("close", () => { room.closed = true; });
  });
}

// As ultimas `n` mensagens da sala, cronologicas.
export function recent(mint, n = 15) {
  const room = rooms.get(mint);
  if (!room) return [];
  return room.messages.slice(-n);
}

// Mensagens ainda nao entregues a este leitor (por agente). Amostrar importa:
// o chat e mangueira de incendio e cada token lido custa aluguel.
const cursors = new Map(); // `${mint}|${who}` -> ultimo id entregue
export function fresh(mint, who, max = 8) {
  const room = rooms.get(mint);
  if (!room) return [];
  if (!(max > 0)) max = 8; // 0/NaN entregaria nada e pareceria "chat mudo"
  const key = `${mint}|${who}`;
  const last = cursors.get(key);
  const all = room.messages;
  // PRIMEIRA leitura deste leitor: pula TUDO que ja estava na sala. O historico
  // (conversas de sessoes e testes antigos) nao e conversa de agora — entregar
  // ele fazia os agentes responderem papo de dias atras como se fosse novo.
  if (last === undefined) {
    if (all.length) cursors.set(key, all[all.length - 1].id);
    return [];
  }
  const idx = all.findIndex((m) => m.id === last);
  // Cursor sumiu do buffer (sala muito ativa): entrega só o rabo recente.
  const from = idx >= 0 ? idx + 1 : Math.max(0, all.length - max);
  const out = all.slice(from).slice(-max);
  if (out.length) cursors.set(key, out[out.length - 1].id);
  return out;
}

export function roomInfo(mint) {
  const room = rooms.get(mint);
  return room ? { config: room.config, connected: !room.closed, held: room.messages.length } : null;
}

// ----------------------------- ENVIO (autenticado) ----------------------------
//
// Abre uma conexao propria, manda uma mensagem, confere o ack e fecha. Conexao
// por mensagem e desperdicio em tese, mas agente posta raramente e conexao
// curta nao acumula estado nem token vencido — troca boa.
//
// `cookies` sai do perfil logado do agente (browser.js). Sem eles o servidor
// aceita a conexao mas responde `authenticated:false` e recusa o envio.
export function sendAs(mint, text, { cookies, address, timeout = 12000 } = {}) {
  return new Promise((resolve) => {
    const msg = String(text ?? "").trim();
    if (!msg) return resolve({ ok: false, code: "empty" });
    if (!cookies) return resolve({ ok: false, code: "unauthenticated" });

    let ackId = 0;
    const pending = new Map();
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, code: "offline" }), timeout);

    const ws = new WebSocket(URL, {
      headers: { origin: "https://pump.fun", "user-agent": UA, cookie: cookies },
    });

    const emit = (event, payload, onAck) => {
      const id = ackId++;
      if (onAck) pending.set(id, onAck);
      ws.send(`42${id}${JSON.stringify([event, payload])}`);
    };

    ws.on("message", (data) => {
      const s = data.toString();

      if (s.startsWith("0{")) {
        ws.send(`40${JSON.stringify({
          origin: "https://pump.fun",
          timestamp: Date.now(),
          token: null,
          deviceId: `device-${crypto.randomUUID()}`,
        })}`);
        return;
      }

      if (s.startsWith("40")) {
        emit("joinRoom", { roomId: mint, username: address ?? "" }, (payload) => {
          const cfg = payload?.[0] ?? {};
          // A prova de que o cookie valeu. Sem isto o envio seria silenciosamente
          // ignorado e o agente acharia que falou.
          if (!cfg.authenticated) return finish({ ok: false, code: "unauthenticated" });
          if (cfg.roomConfig?.tokenGateEnabled) return finish({ ok: false, code: "token-gated" });

          emit("sendMessage", { roomId: mint, message: msg, username: address }, (ack) => {
            const eco = ack?.[0];
            if (eco?.id) return finish({ ok: true, id: eco.id, username: eco.username });
            finish({ ok: false, code: "rejected" });
          });
        });
        return;
      }

      if (s === "2") { ws.send("3"); return; }

      const ack = s.match(/^43(\d+)(\[[\s\S]*)$/);
      if (ack) {
        const fn = pending.get(Number(ack[1]));
        pending.delete(Number(ack[1]));
        if (fn) { try { fn(JSON.parse(ack[2])); } catch { finish({ ok: false, code: "rejected" }); } }
        return;
      }

      // O servidor reclama por aqui quando recusa (limite de taxa, por exemplo).
      const ev = s.match(/^42(\[[\s\S]*)$/);
      if (ev) {
        try {
          const [nome, payload] = JSON.parse(ev[1]);
          if (nome === "exception") {
            const m = String(payload?.message ?? "");
            finish({ ok: false, code: /limit|slow|frequent/i.test(m) ? "rate-limited" : "rejected" });
          }
        } catch {}
      }
    });

    ws.on("error", () => finish({ ok: false, code: "offline" }));
    ws.on("close", () => finish({ ok: false, code: "offline" }));
  });
}

export function leave(mint) {
  const room = rooms.get(mint);
  if (room?.ws) { try { room.ws.close(); } catch {} }
  rooms.delete(mint);
}
