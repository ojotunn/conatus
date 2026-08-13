// ============================================================================
// Capa do X (1500x500) no MESMO padrao da foto de perfil: o rosto do Spinoza em
// ASCII real, luz azul (Sable) / laranja (Rook), fundo escuro — irmao do
// ascii-token.js. A face fica a direita (o avatar do X cobre o canto inferior
// esquerdo), o wordmark "conatus" + tagline a esquerda.
//
// Rodar: node scripts/ascii-banner.js [entrada] [saida]
//   padrao: src/data/spinoza-source.png -> public/assets/conatus-banner.png
// ============================================================================

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC = path.resolve(process.argv[2] ?? path.join(ROOT, "src", "data", "spinoza-source.png"));
const OUT = path.resolve(process.argv[3] ?? path.join(ROOT, "public", "assets", "conatus-banner.png"));

const W = 1500, H = 500;          // proporcao de capa do X (3:1)
const COLS = Number(process.env.ASCII_COLS || 82);
const ROWS = Math.round(COLS * 0.54);
const COLOR = process.env.ASCII_COLOR || "source"; // source | green | mono
const FACE_H = Number(process.env.FACE_H || 476);  // altura-alvo da face em px
const SIDE = process.env.SIDE === "left" ? "left" : "right"; // lado da face
const TAG = process.env.TAG ?? "the striving to persist";
// SUB: linha de baixo. "off" esconde; senao HTML (aceita <span class=b/o>).
const SUB = process.env.SUB ?? 'two minds — <span class="b">one cautious</span>, <span class="o">one reckless</span> —<br>paying rent, in real money, to keep thinking.';
// Cor do wordmark/tag conforme a paleta escolhida (verde combina com verde).
const isGreen = COLOR === "green";
const wbA = isGreen ? "#48d18a" : "#5b9dff"; // "cona"
const wbB = isGreen ? "#a6f0c8" : "#ff7a45"; // "tus"
const tagCol = isGreen ? "#7fdca8" : "#9aa5b4";

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

const html = `<!doctype html><html><head><style>
  html,body{margin:0;width:${W}px;height:${H}px;background:#0a0d12;overflow:hidden}
  .wrap{width:100%;height:100%;position:relative}
  /* leve brilho dos dois agentes vindo dos cantos, igual ao palco */
  .glow{position:absolute;inset:0;pointer-events:none}
  .glow.b{background:radial-gradient(ellipse at ${SIDE === "left" ? "12%" : "88%"} 40%,rgba(91,157,255,.10),transparent 46%)}
  .glow.o{background:radial-gradient(ellipse at ${SIDE === "left" ? "38%" : "62%"} 92%,rgba(255,122,69,.09),transparent 42%)}
  .txt{position:absolute;${SIDE === "left" ? "right:104px;text-align:right" : "left:104px"};top:50%;transform:translateY(-50%);z-index:2}
  .word{font-family:"Consolas","Courier New",monospace;font-size:112px;font-weight:700;
        letter-spacing:12px;line-height:1}
  .word b{color:${wbA};font-weight:700}.word i{color:${wbB};font-style:normal}
  .tag{font-family:"Consolas","Courier New",monospace;font-size:27px;letter-spacing:9px;
       color:${tagCol};margin-top:24px}
  .sub{font-family:"Consolas","Courier New",monospace;font-size:15px;letter-spacing:1.5px;
       color:#5b6472;margin-top:18px;line-height:1.75;max-width:560px;${SIDE === "left" ? "margin-left:auto" : ""}}
  .sub .b{color:${wbA}}.sub .o{color:${wbB}}
  .face{position:absolute;${SIDE === "left" ? "left:96px" : "right:96px"};top:50%;transform:translateY(-50%);z-index:1}
  pre{margin:0;font-family:"Consolas","Courier New",monospace;font-weight:700;
      line-height:1.0;letter-spacing:0;user-select:none}
</style></head><body>
  <div class="wrap">
    <div class="glow b"></div><div class="glow o"></div>
    <div class="face"><pre id="art"></pre></div>
    <div class="txt">
      <div class="word"><b>cona</b><i>tus</i></div>
      <div class="tag">${TAG}</div>
      ${SUB === "off" ? "" : `<div class="sub">${SUB}</div>`}
    </div>
  </div>
<script>
  window.render = (dataUrl) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const COLS = ${COLS}, ROWS = ${ROWS};
      const cv = document.createElement("canvas");
      cv.width = COLS; cv.height = ROWS;
      const cx = cv.getContext("2d", { willReadFrequently: true });
      cx.drawImage(img, 0, 0, COLS, ROWS);
      const px = cx.getImageData(0, 0, COLS, ROWS).data;
      const RAMP = " .':,;i1tfC08M@";
      let out = "";
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          const i = (y * COLS + x) * 4;
          const r = px[i], g = px[i + 1], b = px[i + 2];
          let lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          // Mesma vinheta apertada do token (mata o anel de fundo da fonte).
          const RX = 0.74, RY = 0.90, F0 = 0.80, F1 = 1.00;
          const nx = (x / COLS - 0.5) * 2 / RX;
          const ny = (y / ROWS - 0.5) * 2 / RY;
          const d = Math.sqrt(nx * nx + ny * ny);
          const mask = d >= F1 ? 0 : d <= F0 ? 1 : (F1 - d) / (F1 - F0);
          lum *= mask;
          if (lum < 26) { out += " "; continue; }
          const ch = RAMP[Math.min(RAMP.length - 1, Math.floor((lum / 255) * RAMP.length))];
          const MODE = ${JSON.stringify(COLOR)};
          let cr, cg, cb;
          if (MODE === "green") {
            const v = lum / 255;
            cr = 40 * v; cg = Math.min(255, 120 + 135 * v); cb = 70 * v + 30;
          } else if (MODE === "mono") {
            const v = Math.min(255, lum * 1.4 + 40);
            cr = v * 0.88; cg = v * 0.93; cb = v;
          } else {
            const boost = 1.55, lift = 30;
            cr = Math.min(255, r * boost + lift); cg = Math.min(255, g * boost + lift); cb = Math.min(255, b * boost + lift);
          }
          out += '<span style="color:rgb(' + (cr|0) + ',' + (cg|0) + ',' + (cb|0) + ')">' + ch + "</span>";
        }
        out += "\\n";
      }
      const pre = document.getElementById("art");
      pre.innerHTML = out;
      // Ajusta a fonte pra face bater a altura-alvo (${FACE_H}px).
      let fs = 14; pre.style.fontSize = fs + "px";
      const fit = () => pre.getBoundingClientRect();
      let r0 = fit();
      while (r0.height < ${FACE_H} && fs < 40) { fs += 0.5; pre.style.fontSize = fs + "px"; r0 = fit(); }
      while (r0.height > ${FACE_H} && fs > 6) { fs -= 0.5; pre.style.fontSize = fs + "px"; r0 = fit(); }
      resolve({ fontSize: fs, w: r0.width | 0, h: r0.height | 0 });
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
</script></body></html>`;

await page.setContent(html, { waitUntil: "load" });
const b64 = fs.readFileSync(SRC).toString("base64");
const info = await page.evaluate((d) => window.render(d), `data:image/png;base64,${b64}`);
console.log(`grade ${COLS}x${ROWS} · fonte ${info.fontSize}px · face ${info.w}x${info.h}`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
await page.screenshot({ path: OUT, type: "png" });
await browser.close();
console.log(`salvo: ${OUT}`);
