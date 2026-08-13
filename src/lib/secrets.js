// ============================================================================
// SEGREDOS — e o guarda que impede eles de vazarem para o modelo.
//
// Os agentes nunca veem chave nenhuma. Isso ja e verdade por construcao: o
// prompt e montado a partir da persona, do estado do mundo e do que foi lido,
// e nenhum desses caminhos toca no .env.
//
// Mas "e verdade por construcao" e uma promessa sobre codigo que vai mudar.
// Este arquivo transforma a promessa em checagem: antes de cada chamada, o
// texto que vai para o modelo e varrido atras de qualquer valor secreto
// configurado. Achou, nao envia. Prefiro o turno falhar a chave circular.
//
// Vale para os dois sentidos do risco: bug meu colocando segredo no contexto,
// e agente pedindo educadamente para ver a propria chave.
// ============================================================================

// Todo campo secreto do projeto. O painel mascara estes e nunca os devolve.
// Uma carteira por agente: a Phantom (Solana). Nao ha chave "so operar" em
// Solana como ha na Hyperliquid — um keypair faz tudo. Por isso a trava e o
// executor, e a mitigacao e a carteira ser quente com pouco dentro: financie
// so o que o agente deve operar.
export const SECRET_KEYS = [
  "ANTHROPIC_API_KEY",
  "SABLE_SOL_KEYPAIR",
  "SABLE_X_API_KEY", "SABLE_X_API_SECRET", "SABLE_X_ACCESS_TOKEN", "SABLE_X_ACCESS_SECRET",
  "ROOK_SOL_KEYPAIR",
  "ROOK_X_API_KEY", "ROOK_X_API_SECRET", "ROOK_X_ACCESS_TOKEN", "ROOK_X_ACCESS_SECRET",
  // Navegadores remotos (Browserbase) — infra, mas chave e chave: mascarada
  // no painel e varrida do prompt como qualquer outra.
  "BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID",
  "ADMIN_TOKEN",
];

// Campos por agente que NAO sao segredo (endereco publico, @ do perfil).
// BANK_SOL_PUBKEY: a carteira do BANCO = a carteira DEV que lanca o token e
// coleta as creator fees. Publica de proposito — o publico VE o dinheiro
// entrando (fees) e saindo (compute). Nenhuma chave privada chega perto daqui.
export const PUBLIC_AGENT_KEYS = [
  "SABLE_SOL_PUBKEY", "SABLE_X_HANDLE",
  "ROOK_SOL_PUBKEY", "ROOK_X_HANDLE",
  "BANK_SOL_PUBKEY",
];

// Valor curto demais nao serve de agulha: procurar por "1" no prompt daria
// falso positivo em tudo. Segredo de verdade tem folga bem acima disso.
const MIN_LEN = 12;

export function collectSecrets(env = process.env) {
  const out = [];
  for (const k of SECRET_KEYS) {
    const v = String(env[k] ?? "").trim();
    if (v.length >= MIN_LEN) out.push({ key: k, value: v });
  }
  return out;
}

// --------------------------- segredos de runtime -------------------------------
//
// Nem todo segredo esta no .env. Um token de sessao nasce durante a execucao —
// e como `collectSecrets` so olha nomes fixos de variavel, um token jamais
// entraria na varredura. Registrar aqui no instante em que ele aparece e o que
// mantem a promessa deste arquivo valida para segredos que ainda nao existiam
// quando o processo subiu.
const runtime = new Map(); // rotulo -> valor

export function addRuntimeSecret(value, label = "RUNTIME_SECRET") {
  const v = String(value ?? "").trim();
  if (v.length >= MIN_LEN) runtime.set(label, v);
  return v.length >= MIN_LEN;
}

export function clearRuntimeSecrets() {
  runtime.clear();
}

// Tudo que nao pode aparecer nem no prompt nem no log: .env + runtime.
export function allSecrets(env = process.env) {
  const out = collectSecrets(env);
  for (const [key, value] of runtime) out.push({ key, value });
  return out;
}

export class SecretLeak extends Error {
  constructor(key) {
    super(`abortado: ${key} apareceu no texto que ia para o modelo`);
    this.key = key;
  }
}

// Chame antes de cada chamada ao modelo, com tudo que vai no corpo.
// Sem argumento, varre TUDO — inclusive os segredos de runtime.
export function assertClean(text, secrets = allSecrets()) {
  if (!secrets?.length) return;
  const hay = String(text);
  for (const s of secrets) {
    if (hay.includes(s.value)) throw new SecretLeak(s.key);
  }
}

// Para log e para o painel: nunca imprima o valor, imprima isto.
export function mask(v) {
  const s = String(v ?? "");
  if (!s) return "";
  if (s.length <= 8) return "•".repeat(s.length);
  return `${s.slice(0, 4)}${"•".repeat(Math.min(20, s.length - 8))}${s.slice(-4)}`;
}

// O caminho de SAIDA. `assertClean` protege o que vai para o modelo; isto
// protege o que vai para o log, para o painel e para a tela do Michel numa
// gravacao. Stack trace e a rota larga: o handler de crash imprime `e.stack`
// cru, e o painel devolve esse stream verbatim.
export function redact(text, secrets = allSecrets()) {
  let out = String(text ?? "");
  if (!secrets?.length) return out;
  // Do valor mais longo para o mais curto: se um segredo contem outro, mascarar
  // o maior primeiro evita deixar sobra reconhecivel.
  for (const s of [...secrets].sort((a, b) => b.value.length - a.value.length)) {
    if (out.includes(s.value)) out = out.split(s.value).join(mask(s.value));
  }
  return out;
}
