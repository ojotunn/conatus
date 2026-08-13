// ============================================================================
// Teste OFFLINE do RELOGIO DE PAUTA e dos EVENTOS DO MUNDO.
//
// O que ele prova:
//   RELOGIO
//     1. Sem SCHEDULE, os marcos DERIVAM da janela ativa (mudou a janela,
//        mudou a pauta) — e a janela 8-20 da exatamente 08:00/12:00/16:00/
//        19:30/20:00.
//     2. Spec na mao vence a derivacao; "off" desliga; spec ilegivel nao vira
//        silencio (cai na derivada).
//     3. Um marco dispara UMA vez por dia.
//     4. Marco vencido ha muito tempo volta como `stale` (motor que sobe as 15h
//        nao despeja a pauta da manha na cara do espectador).
//   MUNDO
//     5. Eco so nasce com movimento acima do limiar, e nao repete a mesma
//        noticia — mas volta quando a moeda anda outra faixa.
//     6. Alarme de sobrevida dispara uma vez por limiar cruzado.
//     7. Saude da casa so vira evento na TRANSICAO (caiu/voltou).
//
// Sem rede, sem API, sem tocar em arquivo real. Rodar: node scripts/probe-world.js
// ============================================================================

import { parseSchedule, defaultMarks, dueMark, describe } from "../src/lib/schedule.js";
import * as world from "../src/lib/events.js";

let fails = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  PASS  ${msg}`);
  else { console.log(`  FAIL  ${msg}`); fails++; }
};
const at = (kind, marks) => marks.find((m) => m.kind === kind)?.at;
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
// Relogio de mentira: constroi um Date so com hora e minuto.
const hora = (h, m = 0) => new Date(2026, 7, 12, h, m, 0);

console.log("\n1. Sem SCHEDULE, a pauta deriva da janela ativa");
const padrao = parseSchedule("", { startHour: 8, endHour: 20 });
ok(at("open", padrao) === 8 * 60, `open as 08:00 — deu ${hhmm(at("open", padrao))}`);
ok(at("prime", padrao) === 12 * 60, `prime as 12:00 — deu ${hhmm(at("prime", padrao))}`);
ok(at("check", padrao) === 16 * 60, `check as 16:00 — deu ${hhmm(at("check", padrao))}`);
ok(at("close", padrao) === 19 * 60 + 30, `close as 19:30 — deu ${hhmm(at("close", padrao))}`);
ok(at("bill", padrao) === 20 * 60, `bill as 20:00 — deu ${hhmm(at("bill", padrao))}`);

console.log("\n1b. Outra janela move a pauta junto (lancamento em outro horario)");
const tarde = parseSchedule("", { startHour: 14, endHour: 23 });
ok(at("open", tarde) === 14 * 60, `janela 14-23: open as 14:00 — deu ${hhmm(at("open", tarde))}`);
ok(at("bill", tarde) === 23 * 60, `janela 14-23: bill as 23:00 — deu ${hhmm(at("bill", tarde))}`);
ok(at("close", tarde) === 22 * 60 + 30, `janela 14-23: close as 22:30 — deu ${hhmm(at("close", tarde))}`);
const noite = parseSchedule("", { startHour: 20, endHour: 4 });
ok(at("open", noite) === 20 * 60, "janela que cruza a meia-noite (20-04): open as 20:00");
ok(at("bill", noite) === 4 * 60, `janela 20-04: bill as 04:00 — deu ${hhmm(at("bill", noite))}`);
// DIA INTEIRO (REST_ENABLED=0): o fim normalizaria para 00:00 e engoliria os
// dois ultimos marcos em cima da abertura. Tem que virar fim de dia.
const dia24 = parseSchedule("", { startHour: 0, endHour: 24 });
ok(at("open", dia24) === 0, "24h: open as 00:00");
ok(at("prime", dia24) === 8 * 60, `24h: prime as 08:00 — deu ${hhmm(at("prime", dia24))}`);
ok(at("check", dia24) === 16 * 60, `24h: check as 16:00 — deu ${hhmm(at("check", dia24))}`);
ok(at("close", dia24) === 23 * 60 + 29, `24h: close as 23:29 — deu ${hhmm(at("close", dia24))}`);
ok(at("bill", dia24) === 23 * 60 + 59, `24h: bill as 23:59 — deu ${hhmm(at("bill", dia24))}`);
ok(new Set(dia24.map((m) => m.at)).size === 5, "24h: os cinco marcos em horarios distintos");

console.log("\n2. Spec na mao, desligar e spec ilegivel");
const naMao = parseSchedule("09:15:open,21:00:bill", { startHour: 8, endHour: 20 });
ok(naMao.length === 2 && at("open", naMao) === 9 * 60 + 15, "spec na mao vence a derivacao");
ok(parseSchedule("off", {}).length === 0, `"off" desliga a pauta`);
ok(parseSchedule("banana", { startHour: 8, endHour: 20 }).length === 5,
  "spec ilegivel cai na derivada em vez de virar silencio");
ok(describe(padrao).includes("08:00 open"), "describe() imprime a pauta pro log");

console.log("\n3. Um marco por dia, e o mais recente vencido primeiro");
const feitos = [];
let m = dueMark(padrao, hora(12, 5), feitos);
ok(m?.kind === "prime", `as 12:05 vence o prime — deu ${m?.kind}`);
feitos.push(m.kind);
ok(dueMark(padrao, hora(12, 30), feitos) === null ||
   dueMark(padrao, hora(12, 30), feitos).kind !== "prime", "o prime nao repete no mesmo dia");
ok(dueMark(padrao, hora(7, 0), []) === null, "antes da abertura nao ha marco vencido");

console.log("\n4. Marco vencido demais volta como stale (nao anuncia)");
const velho = dueMark(padrao, hora(15, 0), ["prime", "open"]);
ok(velho === null, "as 15:00 com open/prime feitos, nada vencido ainda (check e 16:00)");
const atrasado = dueMark(padrao, hora(15, 0), []);
ok(atrasado?.kind === "prime" && atrasado.stale === true,
  `motor subindo as 15:00 pega o prime como stale — deu ${atrasado?.kind}/${atrasado?.stale}`);
const naHora = dueMark(padrao, hora(12, 20), []);
ok(naHora?.kind === "prime" && naHora.stale === false, "20 min de atraso ainda e na hora");

console.log("\n5. Ecos");
const watch = [{ mint: "AAAApump", mcap: 100000, at: Date.now() - 3600000, agent: "rook", note: "sold" }];
ok(world.echoes(watch, { AAAApump: 110000 }).length === 0, "movimento de 10% nao vira eco");
const eco = world.echoes(watch, { AAAApump: 148000 });
ok(eco.length === 1 && eco[0].agent === "rook", "movimento de 48% vira eco do agente certo");
ok(/\+48%/.test(eco[0].text) && /SOLD/.test(eco[0].text),
  `o texto traz o numero e o que ele fez — "${eco[0].text}"`);
ok(world.echoes(watch, { AAAApump: 148000 }, { seen: [eco[0].key] }).length === 0,
  "a mesma noticia nao se repete");
ok(world.echoes(watch, { AAAApump: 210000 }, { seen: [eco[0].key] }).length === 1,
  "mas a moeda volta quando anda outra faixa");
ok(world.echoes(watch, {}).length === 0, "sem preco atual, sem eco (nunca inventa)");
ok(world.echoes([{ mint: "X", mcap: 0 }], { X: 5000 }).length === 0, "mcap zero na origem nao vira +infinito%");

console.log("\n6. Sobrevida da casa");
ok(world.runwayAlarm(80).length === 0, "80h de sobrevida nao alarma");
const al = world.runwayAlarm(20);
ok(al.length === 1 && al[0].key === "runway:24", `20h cruza o limiar de 24h — deu ${al[0]?.key}`);
ok(world.runwayAlarm(20, { seen: ["runway:24"] }).length === 0, "o mesmo limiar nao repete");
ok(world.runwayAlarm(5, { seen: ["runway:24"] })[0]?.key === "runway:6", "o limiar seguinte ainda dispara");
ok(world.runwayAlarm(null).length === 0 && world.runwayAlarm(0).length === 0, "sem dado, sem alarme");

console.log("\n7. Saude da casa: so na transicao");
ok(world.healthEvents({ rpc: true, chat: true }, { rpc: true, chat: true }).length === 0,
  "nada mudou, nada e dito");
const caiu = world.healthEvents({ rpc: true, chat: true }, { rpc: false, chat: true });
ok(caiu.length === 1 && /BLIND/.test(caiu[0].text), "RPC caindo vira acontecimento");
const voltou = world.healthEvents({ rpc: false, chat: true }, { rpc: true, chat: true });
ok(voltou.length === 1 && /again/i.test(voltou[0].text), "RPC voltando tambem");
ok(world.healthEvents({ rpc: true, chat: true }, { rpc: false, chat: false }).length === 2,
  "os dois caindo dao dois eventos");

// ----------------------------------------------------------------------------
// 8. A FIACAO DENTRO DO MOTOR. As sete secoes acima provam as pecas; esta prova
// que o motor de fato as usa — marco batido vira evento no palco E pauta no
// turno, e nao repete. (Sem rede e sem API: so o estado do engine.)
// ----------------------------------------------------------------------------
console.log("\n8. O motor usa o relogio (fiacao, nao so a peca)");
const fs = await import("node:fs");
const os = await import("node:os");
const pathMod = await import("node:path");
const TMP = fs.mkdtempSync(pathMod.join(os.tmpdir(), "arena-world-"));
for (const k of ["CHECKPOINT_FILE", "STATE_FILE", "TOTALS_FILE", "PIECES_FILE"])
  process.env[k] = pathMod.join(TMP, k.toLowerCase());
process.env.ARCHIVE_FILE = pathMod.join(TMP, "archive.jsonl");

const engine = await import("../src/engine.js");
engine.cfg.schedule = "";           // derivada da janela
engine.cfg.restEnabled = true;
engine.cfg.activeStartHour = 8;
engine.cfg.activeEndHour = 20;
engine.state.marksDone = [];
engine.state.agenda = null;
engine.state.feed.length = 0;

engine.runSchedule(hora(12, 10));   // horario nobre
const marcou = engine.state.agenda;
ok(marcou?.kind === "prime", `o motor registrou o marco prime — deu ${marcou?.kind}`);
ok(Array.isArray(marcou?.lines) && marcou.lines.length > 0, "a pauta tem corpo para entrar no turno");
ok(engine.state.feed.some((e) => /PRIME TIME/.test(e.text ?? "")), "o palco anunciou o marco");
ok(engine.state.marksDone.includes("prime"), "o marco entrou na lista do dia");

const feedAntes = engine.state.feed.length;
engine.runSchedule(hora(12, 40));
ok(engine.state.feed.length === feedAntes, "o mesmo marco nao anuncia de novo no mesmo dia");

engine.runSchedule(hora(16, 5));
ok(engine.state.agenda?.kind === "check", `as 16:05 o motor avanca para o check — deu ${engine.state.agenda?.kind}`);

fs.rmSync(TMP, { recursive: true, force: true });

console.log(fails === 0 ? "\nTUDO VERDE\n" : `\n${fails} FALHA(S)\n`);
process.exitCode = fails ? 1 : 0;
