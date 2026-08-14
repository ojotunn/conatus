// ============================================================================
// Teste OFFLINE da persona no diretorio de dados (volume no Railway).
//
// Desde 14/08 as personas vivem em src/data/agents/ (agentsDir em
// lib/memory.js), seedadas do agents/ do repo na primeira leitura. Motivo:
// reescrita de persona gravada na imagem morria no restart do Railway.
// Este probe prova: seed no primeiro read, conteudo identico ao molde,
// reescrita versionando no history/ do data dir, molde do repo intacto,
// e seed idempotente (segundo boot NAO sobrescreve a reescrita).
// Rodar: node scripts/probe-persona.js
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// AGENTS_DIR descartavel ANTES de importar — mesmo cuidado dos outros probes
// (probe ja sujou arquivo real por nao fazer isto).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "arena-persona-"));
process.env.AGENTS_DIR = path.join(TMP, "agents");

const mem = await import("../src/lib/memory.js");

let fails = 0;
const ok = (cond, msg) => {
  if (cond) { console.log(`  PASS  ${msg}`); }
  else { console.log(`  FAIL  ${msg}`); fails++; }
};

const seedFile = path.join(ROOT, "agents", "sable.md");
const seedText = fs.readFileSync(seedFile, "utf8");
const liveFile = path.join(TMP, "agents", "sable.md");

// 1. Antes de qualquer leitura o data dir nao tem nada.
ok(!fs.existsSync(liveFile), "data dir nasce sem persona");

// 2. Primeira leitura seeda e devolve o molde do repo.
const first = mem.readPersona(ROOT, "sable");
ok(fs.existsSync(liveFile), "primeiro read copiou a persona pro data dir");
ok(first === seedText, "conteudo lido e identico ao molde do repo");

// 3. Reescrita: versiona no history DO DATA DIR e troca o arquivo vivo.
const v2 = mem.rewritePersona(ROOT, "sable", "REWRITTEN ".repeat(30), "probe", 1);
ok(v2 === 2, "rewrite devolve versao incrementada");
const hist = path.join(TMP, "agents", "history");
ok(fs.existsSync(path.join(hist, "sable.v1.md")), "versao anterior guardada em history/ do data dir");
ok(fs.readFileSync(path.join(hist, "sable.v1.md"), "utf8") === seedText, "history guarda o texto anterior");
ok(mem.readPersona(ROOT, "sable").startsWith("REWRITTEN"), "read seguinte devolve a persona reescrita");

// 4. O molde do repo (a imagem) nao foi tocado pela reescrita.
ok(fs.readFileSync(seedFile, "utf8") === seedText, "agents/ do repo permanece intacto");

// 5. Seed e idempotente: "segundo boot" NAO sobrescreve a reescrita.
//    (E o que protege a persona que o agente escreveu num restart do Railway.)
const again = mem.readPersona(ROOT, "sable");
ok(again.startsWith("REWRITTEN"), "novo boot preserva a reescrita — seed nao sobrescreve");

// 6. O outro agente seeda de forma independente.
ok(mem.readPersona(ROOT, "rook") === fs.readFileSync(path.join(ROOT, "agents", "rook.md"), "utf8"),
  "rook seeda independente e identico ao molde");

console.log();
console.log(fails === 0 ? "probe-persona: tudo verde" : `probe-persona: ${fails} FALHA(S)`);
process.exit(fails === 0 ? 0 : 1);
