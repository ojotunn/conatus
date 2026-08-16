// ============================================================================
// Teste do RELIGAR do chat ao vivo — contra o servidor REAL da pump.fun.
//
// Historia: no boot da noite 2 (15/08/2026) o join levou um 502 passageiro e o
// show ficou surdo ate restart manual, porque a conexao so nascia no boot.
// Agora existe ensure(): religa sala caida, com folga de 60s entre tentativas.
// Este probe conecta na sala do $CONATUS, derruba a conexao como se a rede
// tivesse caido, e prova que ensure() religa preservando o que ja foi visto.
// Rodar: node scripts/probe-reconnect.js   (precisa de rede)
// ============================================================================

const chat = await import("../src/lib/pumpchat.js");

const MINT = "Br6TnKguXsBzGNdQysJAyfzCsLgwMT4v9iPCHfdEpump";

let fails = 0;
const ok = (cond, msg) => {
  if (cond) { console.log(`  PASS  ${msg}`); }
  else { console.log(`  FAIL  ${msg}`); fails++; }
};

// 1. Conecta na sala de verdade.
await chat.join(MINT);
const antes = chat.roomInfo(MINT);
ok(antes?.connected === true, `conectado na sala do $CONATUS (${antes?.held ?? 0} msgs de historico)`);

// 2. A rede "cai".
chat._dropForTest(MINT);
ok(chat.roomInfo(MINT)?.connected === false, "queda simulada — sala marcada como caida");

// 3. ensure() religa (primeira tentativa nao espera os 60s de folga).
const sala = await chat.ensure(MINT);
ok(!!sala, "ensure() religou a sala");
const depois = chat.roomInfo(MINT);
ok(depois?.connected === true, "sala conectada de novo");
ok(depois?.held >= antes?.held, `historico preservado no rejoin (${antes?.held} -> ${depois?.held} msgs)`);

// 4. Sala de pe: ensure() e um no-op barato, nao abre conexao nova.
const mesma = await chat.ensure(MINT);
ok(mesma === sala || (mesma && chat.roomInfo(MINT)?.connected), "ensure() com sala de pe nao derruba nada");

// 5. Cai de novo DENTRO da folga de 60s: ensure() devolve null (espera).
chat._dropForTest(MINT);
const emEspera = await chat.ensure(MINT);
ok(emEspera === null, "segunda queda em <60s entra na janela de espera (sem marreta na pump)");

console.log();
console.log(fails === 0 ? "probe-reconnect: tudo verde" : `probe-reconnect: ${fails} FALHA(S)`);
process.exit(fails === 0 ? 0 : 1);
