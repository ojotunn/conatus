// ============================================================================
// Memoria e persona — a parte que faz os dois divergirem de verdade.
//
// Dois agentes com o mesmo modelo base e historias diferentes viram pessoas
// diferentes com o tempo. Duas coisas persistem:
//
//   licoes   — o que cada um aprendeu, escrito por ele mesmo, com expiracao
//              (licao que nao se reconfirma sai; senao vira supersticão)
//   persona  — o arquivo que descreve quem ele e, que ELE pode reescrever.
//              Cada reescrita fica versionada em history/ (dentro do diretorio
//              de dados — ver agentsDir), entao da pra ver o historico de quem
//              cada um ja foi. Um git log de uma personalidade.
//
// O que ele NAO pode reescrever e a fronteira do executor — se a trava pode
// ser editada por quem ela trava, ela nao e trava, e sugestao.
// ============================================================================

import fs from "node:fs";
import path from "node:path";

const LESSON_TTL_DAYS = 14; // licao nao reconfirmada nesse prazo sai do arquivo
const MAX_LESSONS = 24;

// Onde as personas VIVEM em runtime: no diretorio de dados (no Railway, o
// VOLUME — mesmo lugar do .env e do checkpoint), nao na imagem. Dois motivos:
// (1) o agente reescreve a propria persona, e escrita na imagem morre no
// proximo restart — a reescrita sumia enquanto o personaVersion do checkpoint
// sobrevivia; (2) ajustar personalidade vira editar um arquivo no volume, sem
// push nem redeploy (o engine rele a persona a cada turno).
// O agents/ do repo continua existindo como SEED: molde do dia 1, copiado pro
// volume na primeira leitura. Depois disso o volume vence — igual ao .env.
// AGENTS_DIR: override para testes (mesmo padrao de STATE_FILE/PIECES_FILE).
export function agentsDir(root) {
  return process.env.AGENTS_DIR || path.join(root, "src", "data", "agents");
}

export function personaPath(root, id) {
  return path.join(agentsDir(root), `${id}.md`);
}

// Seed do primeiro boot: volume novo/vazio recebe a persona da imagem (e o
// historico, se a imagem tiver um). Idempotente — arquivo existente nunca e
// sobrescrito, entao reescritas dos agentes ficam intactas.
function ensureSeeded(root, id) {
  const dst = personaPath(root, id);
  if (fs.existsSync(dst)) return;
  fs.mkdirSync(agentsDir(root), { recursive: true });
  fs.copyFileSync(path.join(root, "agents", `${id}.md`), dst);
  const seedHist = path.join(root, "agents", "history");
  if (fs.existsSync(seedHist)) {
    const dstHist = path.join(agentsDir(root), "history");
    fs.mkdirSync(dstHist, { recursive: true });
    for (const f of fs.readdirSync(seedHist)) {
      const to = path.join(dstHist, f);
      if (!fs.existsSync(to)) fs.copyFileSync(path.join(seedHist, f), to);
    }
  }
}

export function readPersona(root, id) {
  ensureSeeded(root, id);
  return fs.readFileSync(personaPath(root, id), "utf8");
}

// Reescrita: versiona a anterior antes de sobrescrever. Nunca perde histórico.
export function rewritePersona(root, id, newText, why, version) {
  const histDir = path.join(agentsDir(root), "history");
  fs.mkdirSync(histDir, { recursive: true });
  const prev = readPersona(root, id);
  fs.writeFileSync(path.join(histDir, `${id}.v${version}.md`), prev);
  fs.writeFileSync(
    path.join(histDir, `${id}.v${version}.why.txt`),
    `${new Date().toISOString()}\n${why ?? "(sem motivo declarado)"}\n`
  );
  fs.writeFileSync(personaPath(root, id), String(newText).trim() + "\n");
  return version + 1;
}

// ------------------------------- licoes ---------------------------------------

export function addLesson(agent, text, day) {
  const t = String(text).trim();
  if (!t) return;
  const existing = agent.lessons.find((l) => l.text.toLowerCase() === t.toLowerCase());
  if (existing) {
    // Reconfirmacao: renova o prazo e conta a repeticao em vez de duplicar.
    existing.confirmations++;
    existing.lastDay = day;
    return;
  }
  agent.lessons.unshift({ text: t, day, lastDay: day, confirmations: 1 });
  if (agent.lessons.length > MAX_LESSONS) agent.lessons.length = MAX_LESSONS;
}

// Poda. Sem isso a memoria acumula regra sobre regra e o agente vira
// supersticioso e paralisado depois de algumas semanas.
export function expireLessons(agent, day) {
  const before = agent.lessons.length;
  agent.lessons = agent.lessons.filter(
    (l) => day - l.lastDay < LESSON_TTL_DAYS || l.confirmations >= 3
  );
  return before - agent.lessons.length;
}

export function formatLessons(agent) {
  if (!agent.lessons.length) return "(voce ainda nao escreveu nenhuma licao)";
  return agent.lessons
    .map((l, i) => `${i + 1}. ${l.text}  [dia ${l.day}, confirmada ${l.confirmations}x]`)
    .join("\n");
}
