// ============================================================================
// Teste do PORTAO — a decisao mais delicada do projeto.
//
// A carteira injetada passou a poder assinar TRANSACAO (o trade acontece na
// tela, ao vivo). Isso so e defensavel porque cada pedido da pagina atravessa
// `approveAndSign`: estrutura -> lista branca -> simulacao -> teto de gasto.
//
// Este probe prova as RECUSAS. Nada e assinado com chave real: as transacoes
// de ataque sao montadas a mao e reprovam antes de chegar perto da chave.
// Rodar: node scripts/probe-gate.js
// ============================================================================

import "dotenv/config";
import { approveAndSign, inspectTx, checkWhitelist } from "../src/lib/executor.js";
import { b58decode, b58encode } from "../src/lib/signer.js";

let fails = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  PASS  ${msg}`);
  else { console.log(`  FAIL  ${msg}`); fails++; }
};

const SABLE = process.env.SABLE_SOL_PUBKEY || "AHF8N7asQhTwh1MMiq46PvKguRp9XXWhPyzCxGvcasQa";
const ROOK = process.env.ROOK_SOL_PUBKEY || "Cnfv1Y1FjMsmkobwGjBZgkZWGFsH7kAqgwSwx5D8jmXg";

// Monta uma transacao v0 crua: 1 assinatura + N contas + 1 instrucao.
function fakeTx({ signer, programs, nSigs = 1 }) {
  const keys = [b58decode(signer), ...programs.map((p) => b58decode(p))];
  const partes = [
    Buffer.from([0x80]),                    // v0
    Buffer.from([nSigs, 0, programs.length]), // header
    Buffer.from([keys.length]),
    ...keys.map((k) => Buffer.from(k)),
    Buffer.alloc(32),                        // blockhash
    Buffer.from([programs.length]),          // uma instrucao por programa
  ];
  for (let i = 0; i < programs.length; i++) {
    partes.push(Buffer.from([1 + i]));       // programIdIndex
    partes.push(Buffer.from([0]));           // sem contas
    partes.push(Buffer.from([0]));           // sem dados
  }
  partes.push(Buffer.from([0]));             // sem lookups
  const msg = Buffer.concat(partes);
  return Buffer.concat([Buffer.from([nSigs]), Buffer.alloc(64 * nSigs), msg]);
}

const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM = "11111111111111111111111111111111";

console.log("\n1) ATAQUES ESTRUTURAIS — reprovam antes de qualquer rede");

// (a) transacao que chama um programa desconhecido (ex.: drenador)
{
  const DRENO = b58encode(Buffer.alloc(32, 7));
  const tx = fakeTx({ signer: SABLE, programs: [PUMP, DRENO] });
  const r = await approveAndSign(tx, { owner: SABLE, keypairEnvKey: "SABLE_SOL_KEYPAIR", maxSolSpend: 0.02 });
  ok(r.ok === false && /lista branca/.test(r.reason), "programa fora da lista branca RECUSADO");
  console.log(`        motivo: ${r.reason?.slice(0, 80)}`);
}

// (b) transacao que o OUTRO agente assinaria (a pagina tentando usar a chave errada)
{
  const tx = fakeTx({ signer: ROOK, programs: [PUMP] });
  const r = await approveAndSign(tx, { owner: SABLE, keypairEnvKey: "SABLE_SOL_KEYPAIR", maxSolSpend: 0.02 });
  ok(r.ok === false && /assinada por/.test(r.reason), "transacao de outro assinante RECUSADA");
}

// (c) multisig disfarcado (2 assinaturas — a segunda seria de quem?)
{
  const tx = fakeTx({ signer: SABLE, programs: [PUMP], nSigs: 2 });
  const r = await approveAndSign(tx, { owner: SABLE, keypairEnvKey: "SABLE_SOL_KEYPAIR", maxSolSpend: 0.02 });
  ok(r.ok === false && /assinaturas/.test(r.reason), "transacao com 2 assinaturas RECUSADA");
}

// (d) lixo binario que nao e transacao
{
  const r = await approveAndSign(Buffer.from("nao sou uma transacao"), { owner: SABLE, keypairEnvKey: "SABLE_SOL_KEYPAIR", maxSolSpend: 0.02 });
  ok(r.ok === false, "payload que nao e transacao RECUSADO");
}

console.log("\n2) A LISTA BRANCA sozinha (sem rede)");
{
  const tx = fakeTx({ signer: SABLE, programs: [PUMP, TOKEN, SYSTEM] });
  const info = inspectTx(tx);
  ok(checkWhitelist(info, SABLE).ok === true, "programas legitimos passam na peneira");
  const comDreno = fakeTx({ signer: SABLE, programs: [PUMP, b58encode(Buffer.alloc(32, 9))] });
  ok(checkWhitelist(inspectTx(comDreno), SABLE).ok === false, "um unico programa estranho reprova a transacao INTEIRA");
}

console.log("\n3) O TETO DE GASTO (a defesa que nao depende de entender a instrucao)");
{
  // Transacao estruturalmente valida chega na simulacao; teto zero reprova
  // qualquer gasto acima da folga de taxa.
  const tx = fakeTx({ signer: SABLE, programs: [PUMP, TOKEN] });
  const r = await approveAndSign(tx, { owner: SABLE, keypairEnvKey: "SABLE_SOL_KEYPAIR", maxSolSpend: 0 });
  // A simulacao vai falhar (instrucao vazia) OU o teto vai barrar — as duas
  // sao recusas legitimas; o que NAO pode e passar.
  ok(r.ok === false, "transacao sintetica nao passa na simulacao/teto");
  console.log(`        motivo: ${r.reason?.slice(0, 90)}`);
}

console.log("\n4) A CAPACIDADE NASCE FECHADA");
{
  const { attachWallet } = await import("../src/lib/pumpwallet.js");
  ok(typeof attachWallet === "function", "attachWallet existe");
  // Sem `approveTransaction`, a carteira nem anuncia a feature — e o
  // comportamento original do projeto, preservado.
  const src = (await import("node:fs")).readFileSync("src/lib/pumpwallet.js", "utf8");
  ok(/canSignTx\s*=\s*!!approveTransaction/.test(src), "signTransaction so e anunciado quando ha portao");
  ok(/if \(!approveTransaction\) return JSON.stringify\(\{ ok: false, code: "unsupported-op" \}\)/.test(src),
    "sem portao, o pedido da pagina recebe 'nao existe'");
}

console.log(`\n${fails === 0 ? "TODOS VERDES" : fails + " FALHA(S)"}\n`);
// process.exit() imediato aqui derruba o libuv no Windows (sockets keep-alive
// do fetch ainda abertos) e o probe "falharia" por um erro que nao e do teste.
process.exitCode = fails === 0 ? 0 : 1;
setTimeout(() => process.exit(process.exitCode), 300).unref();
