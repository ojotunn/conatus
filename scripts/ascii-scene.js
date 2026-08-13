// ============================================================================
// ASCII de CENA (larga) — mesmo tratamento da foto de perfil, mas pra cenas com
// duas silhuetas (Sable azul / Rook laranja) em vez de um busto centralizado.
// Sem a vinheta eliptica do token (que cortaria as figuras), grade maior pra
// segurar o detalhe, cores da propria fonte (a luz azul/laranja vem de graca).
//
// Rodar: node scripts/ascii-scene.js <entrada> <saida> [COLS]
//   ex: node scripts/ascii-scene.js in.png out.png 220
// ============================================================================

import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC = path.resolve(process.argv[2] ?? path.join(ROOT, "src", "data", "spinoza-source.png"));
const OUT = path.resolve(process.argv[3] ?? path.join(ROOT, "public", "assets", "scene.png"));
const COLS = Number(process.argv[4] || process.env.ASCII_COLS || 220);
const COLOR = process.env.ASCII_COLOR || "source"; // source | green | mono
const PAD = Number(process.env.PAD || 40);         // margem escura ao redor
const FLOOR = Number(process.env.FLOOR || 22);     // corte de luminancia (fundo)
// GAMMA < 1 clareia as sombras ANTES do corte: as fontes do Higgsfield sao
// pretos de cinema (so a borda de luz aparece), e sem isso o corpo do vulto
// some. 1 = sem mudanca; ~0.5 preenche silhueta escura.
const GAMMA = Number(process.env.GAMMA || 1);
// DIM < 1 deixa a imagem mais FOSCA: escurece a cor final (menos brilho, menos
// saturacao estourada). 1 = cheio; ~0.65 = fosco/suave.
const DIM = Number(process.env.DIM || 1);
// CROP="sx,sy,sw,sh" em FRACOES (0-1) da fonte: recorta antes de amostrar, pra
// aproximar das figuras (elas ficam pequenas no 21:9). Vazio = fonte inteira.
const CROP = (process.env.CROP || "").split(",").map(Number);
const CROP_OK = CROP.length === 4 && CROP.every((n) => Number.isFinite(n));

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });

const html = `<!doctype html><html><head><style>
  html,body{margin:0;background:#0a0d12}
  #stage{display:inline-block;padding:${PAD}px;background:#0a0d12}
  pre{margin:0;font-family:"Consolas","Courier New",monospace;font-weight:700;
      line-height:1.0;letter-spacing:0;user-select:none;font-size:9px}
</style></head><body>
  <div id="stage"><pre id="art"></pre></div>
<script>
  window.render = (dataUrl) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const COLS = ${COLS};
      // Recorte opcional (fracoes da fonte). Sem recorte = imagem inteira.
      const CR = ${CROP_OK ? JSON.stringify(CROP) : "null"};
      const sx = CR ? CR[0] * img.naturalWidth : 0;
      const sy = CR ? CR[1] * img.naturalHeight : 0;
      const sw = CR ? CR[2] * img.naturalWidth : img.naturalWidth;
      const sh = CR ? CR[3] * img.naturalHeight : img.naturalHeight;
      // Proporcao do RECORTE (nao da fonte) manda no numero de linhas.
      const srcA = sw / sh;
      const ROWS = Math.max(8, Math.round(COLS * 0.54 / srcA));
      const cv = document.createElement("canvas");
      cv.width = COLS; cv.height = ROWS;
      const cx = cv.getContext("2d", { willReadFrequently: true });
      cx.drawImage(img, sx, sy, sw, sh, 0, 0, COLS, ROWS);
      const px = cx.getImageData(0, 0, COLS, ROWS).data;
      const RAMP = " .':,;i1tfC08M@";
      const MODE = ${JSON.stringify(COLOR)};
      let out = "";
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          const i = (y * COLS + x) * 4;
          let r = px[i], g = px[i + 1], b = px[i + 2];
          // Clareia as sombras (gama por canal) antes de tudo: enche o corpo do
          // vulto que as fontes escuras do Higgsfield deixariam de fora.
          const G = ${GAMMA};
          if (G !== 1) {
            r = 255 * Math.pow(r / 255, G);
            g = 255 * Math.pow(g / 255, G);
            b = 255 * Math.pow(b / 255, G);
          }
          const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          if (lum < ${FLOOR}) { out += " "; continue; }
          const ch = RAMP[Math.min(RAMP.length - 1, Math.floor((lum / 255) * RAMP.length))];
          let cr, cg, cb;
          if (MODE === "green") {
            const v = lum / 255; cr = 40 * v; cg = Math.min(255, 120 + 135 * v); cb = 70 * v + 30;
          } else if (MODE === "mono") {
            const v = Math.min(255, lum * 1.4 + 40); cr = v * 0.88; cg = v * 0.93; cb = v;
          } else {
            const boost = 1.7, lift = 26;
            cr = Math.min(255, r * boost + lift); cg = Math.min(255, g * boost + lift); cb = Math.min(255, b * boost + lift);
          }
          const dim = ${DIM};
          cr *= dim; cg *= dim; cb *= dim;
          out += '<span style="color:rgb(' + (cr|0) + ',' + (cg|0) + ',' + (cb|0) + ')">' + ch + "</span>";
        }
        out += "\\n";
      }
      document.getElementById("art").innerHTML = out;
      resolve({ cols: COLS, rows: ROWS, srcA: srcA.toFixed(3) });
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
</script></body></html>`;

await page.setContent(html, { waitUntil: "load" });
const b64 = fs.readFileSync(SRC).toString("base64");
const info = await page.evaluate((d) => window.render(d), `data:image/png;base64,${b64}`);
console.log(`grade ${info.cols}x${info.rows} · aspecto ${info.srcA}`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const el = await page.$("#stage");
await el.screenshot({ path: OUT, type: "png" });
await browser.close();
console.log(`salvo: ${OUT}`);
