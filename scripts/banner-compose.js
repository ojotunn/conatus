// ============================================================================
// Monta uma imagem ASCII na capa do X (1500x500). Centraliza (ou desloca) a
// arte num quadro escuro, com o canto inferior esquerdo livre pro avatar.
// Opcional: wordmark "conatus" + tagline a esquerda.
//
// Rodar: node scripts/banner-compose.js <img-ascii> <saida> [IMG_H] [WORD]
//   IMG_H: altura da arte em px (padrao 470). WORD: "on" poe o wordmark.
// ============================================================================

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const IN = path.resolve(process.argv[2]);
const OUT = path.resolve(process.argv[3] ?? path.join(ROOT, "public", "assets", "conatus-banner.png"));
const IMG_H = Number(process.argv[4] || process.env.IMG_H || 470);
const WORD = (process.argv[5] || process.env.WORD || "off") === "on";
const SHIFT = Number(process.env.SHIFT || (WORD ? 300 : 0)); // desloca a arte pra direita

const W = 1500, H = 500;
// SCATTER=1 espalha detalhes ASCII soltos (poeira de caracteres azul/laranja)
// pelo fundo — esparso e determinístico (seed fixa, mesma capa sempre).
const SCATTER = process.env.SCATTER === "1";
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

const b64 = fs.readFileSync(IN).toString("base64");

const html = `<!doctype html><html><head><style>
  html,body{margin:0;width:${W}px;height:${H}px;background:#0a0d12;overflow:hidden}
  .wrap{position:relative;width:${W}px;height:${H}px;background:#0a0d12}
  .art{position:absolute;top:50%;left:calc(50% + ${SHIFT / 2}px);transform:translate(-50%,-50%);
       height:${IMG_H}px;image-rendering:auto}
  .txt{position:absolute;left:104px;top:50%;transform:translateY(-50%);z-index:2}
  .word{font-family:"Consolas","Courier New",monospace;font-size:100px;font-weight:700;letter-spacing:11px;line-height:1}
  .word b{color:#5b9dff;font-weight:700}.word i{color:#ff7a45;font-style:normal}
  .tag{font-family:"Consolas","Courier New",monospace;font-size:24px;letter-spacing:8px;color:#9aa5b4;margin-top:22px}
</style></head><body>
  <div class="wrap">
    <div id="scatter" style="position:absolute;inset:0;font-family:'Consolas','Courier New',monospace;font-weight:700;z-index:0"></div>
    <img class="art" src="data:image/png;base64,${b64}">
    ${WORD ? `<div class="txt"><div class="word"><b>cona</b><i>tus</i></div><div class="tag">the striving to persist</div></div>` : ""}
  </div>
</body></html>`;

await page.setContent(html, { waitUntil: "load" });

// Poeira ASCII: caracteres soltos azul (Sable) / laranja (Rook), esparsos, com
// PRNG de seed fixa — a mesma capa sai identica em toda re-geracao.
if (SCATTER) {
  await page.evaluate(() => {
    let s = 42;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const CHARS = ".:;i1tfC08".split("");
    const el = document.getElementById("scatter");
    let html = "";
    for (let k = 0; k < 150; k++) {
      const x = rnd() * 1500, y = rnd() * 500;
      // Mais denso nas bordas, raro perto do centro-direita (onde a arte vive).
      const nearArt = x > 620 && x < 1260 && y > 60;
      if (nearArt && rnd() < 0.8) continue;
      const blue = rnd() < 0.5;
      const ch = CHARS[(rnd() * CHARS.length) | 0];
      const size = 8 + rnd() * 6;
      const op = 0.10 + rnd() * 0.30;
      const col = blue ? "91,157,255" : "255,122,69";
      html += `<span style="position:absolute;left:${x.toFixed(0)}px;top:${y.toFixed(0)}px;` +
        `font-size:${size.toFixed(1)}px;color:rgba(${col},${op.toFixed(2)})">${ch}</span>`;
    }
    el.innerHTML = html;
  });
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
await page.screenshot({ path: OUT, type: "png", clip: { x: 0, y: 0, width: W, height: H } });
await browser.close();
console.log(`salvo: ${OUT} (${W}x${H}${WORD ? " · com wordmark" : ""})`);
