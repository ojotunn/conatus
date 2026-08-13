// ============================================================================
// O RELOGIO DE PAUTA — o dia tem horario.
//
// Doze horas de live sem grade sao um bloco liso: o espectador nao sabe quando
// voltar e o dia nao tem comeco, meio nem fim. Cinco marcos resolvem isso sem
// custar uma unica chamada de API — eles pegam carona no turno que ja ia
// acontecer, injetando a pauta e anunciando no palco.
//
// OS MARCOS PAUTAM, NAO OBRIGAM. O agente continua podendo ignorar, que e o que
// mantem o show sendo deles e nao roteiro lido. A unica coisa mecanica e o
// dinheiro, e o dinheiro mora em outro lugar (postDailyBill/collectRent).
//
// HORARIO: por padrao os marcos DERIVAM da janela ativa, entao mudar o horario
// do show move a pauta junto, sozinho. Cravar na mao tambem funciona:
//   SCHEDULE=08:00:open,12:00:prime,16:00:check,19:30:close,20:00:bill
// SCHEDULE=off desliga tudo.
// ============================================================================

export const KINDS = ["open", "prime", "check", "close", "bill"];

const hhmm = (min) =>
  `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

// Marcos derivados da janela ativa. Para a janela padrao 8h-20h isto da
// exatamente 08:00 / 12:00 / 16:00 / 19:30 / 20:00; para qualquer outra janela,
// as mesmas proporcoes.
export function defaultMarks(startHour = 8, endHour = 20) {
  const s = ((Number(startHour) % 24) + 24) % 24;
  const eRaw = Number(endHour);
  const e = eRaw === 24 ? 24 : ((eRaw % 24) + 24) % 24;
  // Janela que cruza a meia-noite (ou 24h cheias) vira duracao positiva.
  const dur = e > s ? e - s : e + 24 - s;
  const norm = (min) => ((Math.round(min) % 1440) + 1440) % 1440;
  const inicio = s * 60;
  const fim = inicio + dur * 60; // pode passar de 1440 — so normaliza no final
  // DIA INTEIRO (sem janela de descanso): o fim da janela normalizaria para
  // 00:00, que e o MESMO instante da abertura — os dois ultimos marcos
  // desapareceriam em cima do primeiro. Nesse caso o fim do dia e 23:59.
  const diaInteiro = dur >= 24;
  return [
    { kind: "open", at: norm(inicio) },
    { kind: "prime", at: norm(inicio + (dur * 60) / 3) },
    { kind: "check", at: norm(inicio + (dur * 60 * 2) / 3) },
    // O fechamento fica meia hora antes do fim: da tempo de reagir ao placar
    // antes de a casa apagar a luz.
    { kind: "close", at: diaInteiro ? 1409 : norm(fim - 30) },
    { kind: "bill", at: diaInteiro ? 1439 : norm(fim) },
  ];
}

// Le a spec. Vazia = derivada da janela. "off"/"0"/"none" = sem marcos.
export function parseSchedule(spec, { startHour = 8, endHour = 20 } = {}) {
  const raw = String(spec ?? "").trim();
  if (/^(off|0|none|no)$/i.test(raw)) return [];
  if (!raw) return defaultMarks(startHour, endHour);

  const out = [];
  for (const part of raw.split(",")) {
    const m = part.trim().match(/^(\d{1,2})\s*:\s*(\d{2})\s*:\s*(\w+)$/);
    if (!m) continue;
    const kind = m[3].toLowerCase();
    if (!KINDS.includes(kind)) continue;
    const at = (Number(m[1]) % 24) * 60 + Math.min(59, Number(m[2]));
    out.push({ kind, at });
  }
  // Spec ilegivel inteira nao pode virar "sem pauta" em silencio.
  if (!out.length) return defaultMarks(startHour, endHour);
  return out.sort((a, b) => a.at - b.at);
}

// O QUE ESTA VENCIDO AGORA.
//
// Devolve o primeiro marco do dia cujo horario ja passou e que ainda nao
// aconteceu hoje. `graceMin` existe para o caso de o motor subir as 15h: os
// marcos das 8h e das 12h estao vencidos, mas anuncia-los seria mentir sobre a
// hora — eles voltam como { stale: true } para o chamador riscar da lista sem
// anunciar nada.
export function dueMark(marks, now, done = [], graceMin = 60) {
  const min = now.getHours() * 60 + now.getMinutes();
  const feitos = new Set(done);
  const vencidos = marks
    .filter((m) => !feitos.has(m.kind) && m.at <= min)
    .sort((a, b) => a.at - b.at);
  if (!vencidos.length) return null;
  // O mais recente vencido e o que interessa; os outros ficam para as proximas
  // chamadas (um marco por turno, nunca uma enxurrada de uma vez).
  const alvo = vencidos[vencidos.length - 1];
  const atraso = min - alvo.at;
  return { ...alvo, stale: atraso > graceMin, lateMin: atraso };
}

// Descricao curta para o log e para o painel.
export function describe(marks) {
  if (!marks.length) return "off";
  return marks.map((m) => `${hhmm(m.at)} ${m.kind}`).join(" · ");
}
