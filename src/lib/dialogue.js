// ============================================================================
// A CONVERSA ENTRE OS DOIS (13/08/2026).
//
// O canal de fala sempre existiu: `remark` vem colado em qualquer acao e nao
// custa chamada nenhuma. O que faltava era MEMORIA. O motor guardava so
// `lastSaid` — UMA linha, sobrescrita a cada fala — entao dava para responder,
// nao para discutir: no terceiro turno ninguem lembrava do assunto. E falar com
// a sala gravava por cima, apagando a frase dirigida ao colega antes de ela ser
// lida uma unica vez.
//
// Modulo puro de proposito (mesma escolha de schedule.js e events.js): sem
// estado global, sem I/O, testavel offline em `scripts/probe-dialogue.js`.
// ============================================================================

// Teto do registro. Baixo por escolha: e contexto de conversa, nao arquivo — o
// arquivo permanente e o /journal. Cada linha guardada custa token em TODO
// turno dos dois agentes, entao o teto e uma decisao de custo, nao de espaco.
export const KEEP = 8;

// Quantas trocas entram no prompt. Menor que o teto: o registro guarda um pouco
// mais do que se mostra, para a fala a sala nao empurrar a conversa para fora.
export const SHOW = 6;

/**
 * Acrescenta uma fala ao registro e devolve a lista ja podada.
 * `to` e o id do colega ou "room" (plateia). Fala vazia nao entra.
 */
export function push(list, { from, to, text, tick }, keep = KEEP) {
  const t = String(text ?? "").trim();
  if (!t) return Array.isArray(list) ? list : [];
  const out = [...(Array.isArray(list) ? list : []), { from, to, text: t, tick }];
  return out.length > keep ? out.slice(-keep) : out;
}

/**
 * So o que foi dito ENTRE os dois, em ordem cronologica (mais recente por
 * ultimo, que e como se le uma conversa). O que foi para a sala fica de fora:
 * aquilo e para a plateia e chega ao agente por outro caminho.
 */
export function between(list, agentId, foeId, limit = SHOW) {
  return (Array.isArray(list) ? list : [])
    .filter((d) => d && d.to !== "room" &&
                   (d.from === agentId || d.from === foeId) &&
                   (d.to === agentId || d.to === foeId))
    .slice(-limit);
}

/**
 * As linhas que entram no prompt. Devolve [] quando nao houve conversa — sem
 * cabecalho orfao. `trim` e injetado para o corte de tamanho ser o mesmo do
 * resto do motor.
 */
export function render(list, { agentId, foeId, foeName, trim = (s) => s, limit = SHOW }) {
  const troca = between(list, agentId, foeId, limit);
  if (!troca.length) return [];
  const L = ["BETWEEN THE TWO OF YOU LATELY (most recent last):"];
  for (const d of troca) {
    const quem = d.from === agentId ? "You" : foeName;
    L.push(`  ${quem}: "${trim(d.text, 220)}"`);
  }
  // Quem falou por ultimo importa: uma pergunta pendente e uma divida social.
  // O silencio continua sendo escolha legitima — mas escolha, nao esquecimento.
  if (troca[troca.length - 1].from === foeId) {
    L.push(`  ${foeName} spoke last. Answer it or let it go — both are a choice they will notice.`);
  }
  return L;
}
