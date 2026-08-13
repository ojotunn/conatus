// ============================================================================
// A ESCALA. Eles nao dormem, mas trabalham em turnos — e cada turno roda um
// modelo diferente.
//
// Nao e so economia. E o mecanismo "riqueza compra cognicao" expresso como
// ritmo do dia: das 8 as 16 eles estao afiados, de madrugada pensam raso, e
// isso e visivel para quem assiste. O agente SABE em que turno esta, entao
// pode guardar a decisao dificil para o turno bom — ou nao, e se explicar.
//
// Formato (hora local, fim exclusivo, pode cruzar a meia-noite):
//   SHIFTS=00-08:claude-haiku-4-5:low,08-16:claude-opus-5:high,16-24:claude-sonnet-5:medium
// ============================================================================

const LABELS = {
  "claude-opus-5": "prime",
  "claude-sonnet-5": "swing",
  "claude-haiku-4-5": "graveyard",
};

// Devolve [] se a spec estiver vazia ou ilegivel — quem chama cai no modelo fixo.
export function parseShifts(spec) {
  if (!spec || !String(spec).trim()) return [];
  const out = [];
  for (const raw of String(spec).split(",")) {
    const m = raw.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})\s*:\s*([\w.-]+)\s*(?::\s*(\w+))?$/);
    if (!m) continue;
    const start = Number(m[1]) % 24;
    const endRaw = Number(m[2]);
    const end = endRaw === 24 ? 24 : endRaw % 24;
    if (start === end) continue; // faixa vazia, ignora
    out.push({
      start,
      end,
      model: m[3],
      effort: m[4] || "medium",
      label: LABELS[m[3]] ?? "shift",
    });
  }
  return out;
}

const covers = (s, h) => (s.start < s.end ? h >= s.start && h < s.end : h >= s.start || h < s.end);

// Qual turno vale nesta hora. Devolve null se nenhum cobrir (cai no fixo).
export function shiftAt(shifts, hour) {
  const h = ((hour % 24) + 24) % 24;
  return shifts.find((s) => covers(s, h)) ?? null;
}

// Quantos minutos faltam para o turno virar. Serve para o painel e para o
// proprio agente saber quanto tempo de lucidez ainda tem.
export function minutesLeft(shifts, date) {
  const cur = shiftAt(shifts, date.getHours());
  if (!cur) return null;
  const endHour = cur.end === 24 ? 24 : cur.end;
  let mins = (endHour - date.getHours()) * 60 - date.getMinutes();
  if (mins <= 0) mins += 24 * 60; // turno que cruza a meia-noite
  return mins;
}

// Resolve o modelo/effort deste instante, com fallback para o valor fixo.
export function resolve(shifts, fallback, date = new Date()) {
  const s = shiftAt(shifts, date.getHours());
  if (!s) return { ...fallback, label: "fixed", minutesLeft: null };
  return {
    model: s.model,
    effort: s.effort,
    label: s.label,
    minutesLeft: minutesLeft(shifts, date),
  };
}
