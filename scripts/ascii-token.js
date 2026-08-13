// ============================================================================
// Gera a imagem do token: ASCII ART DE VERDADE (caracteres reais — letras,
// numeros, simbolos) a partir de uma imagem-fonte, no estilo claudius.run.
//
// Como: o Chromium desenha a fonte num canvas, amostra a luminancia numa grade
// de celulas, mapeia cada celula pra um caractere (mais claro = mais denso) e
// pra COR do proprio pixel (a fonte ja e iluminada azul/laranja — a luz dos
// dois agentes vem de graca). Renderiza num <pre> monoespacado e fotografa.
//
// Rodar: node scripts/ascii-token.js [entrada] [saida]
//   padrao: src/data/spinoza-source.png -> src/data/conatus-token.png
// ============================================================================

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC = path.resolve(process.argv[2] ?? path.join(ROOT, "src", "data", "spinoza-source.png"));
const OUT = path.resolve(process.argv[3] ?? path.join(ROOT, "src", "data", "conatus-token.png"));

const SIZE = 1024;          // saida 1:1 (padrao pump.fun)
// Opcoes por env (para gerar variacoes sem tocar no codigo):
//   ASCII_COLS   — colunas de caracteres (densidade). ROWS deriva (~0.54x)
//   ASCII_COLOR  — "source" (cor da luz azul/laranja) | "green" (terminal) | "mono"
//   ASCII_CAPTION— "1" poe o "conatus" embaixo; padrao SEM legenda
//   ASCII_TIGHT  — "1" = mascara apertada (mata restos no topo/rodape)
const COLS = Number(process.env.ASCII_COLS || 92);
const ROWS = Math.round(COLS * 0.54);
const COLOR = process.env.ASCII_COLOR || "source";
const CAPTION_ON = process.env.ASCII_CAPTION === "1";
const TIGHT = process.env.ASCII_TIGHT !== "0"; // padrao: apertada

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: SIZE, height: SIZE, deviceScaleFactor: 1 });

const html = `<!doctype html><html><head><style>
  html,body{margin:0;width:${SIZE}px;height:${SIZE}px;background:#0a0d12;overflow:hidden}
  .wrap{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center}
  pre{margin:0;font-family:"Consolas","Courier New",monospace;font-weight:700;
      line-height:1.0;letter-spacing:0;user-select:none}
  .cap{font-family:"Consolas","Courier New",monospace;font-size:34px;margin-top:26px;
      letter-spacing:6px;color:#8a95a6}
  .cap b{color:#5b9dff;font-weight:400}.cap i{color:#ff7a45;font-style:normal}
</style></head><body>
  <div class="wrap"><pre id="art"></pre>
  ${CAPTION_ON ? '<div class="cap"><b>cona</b><i>tus</i></div>' : ""}</div>
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
      // Rampa de densidade: do quase-nada ao macico. Numeros e letras — o
      // pedido literal do Michel — nas faixas do meio, M/8 nos brilhos.
      const RAMP = " .':,;i1tfC08M@";
      let out = "";
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          const i = (y * COLS + x) * 4;
          const r = px[i], g = px[i + 1], b = px[i + 2];
          let lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          // Vinheta eliptica: mata o fundo claro das bordas/cantos da fonte
          // (viravam muralhas de @). TIGHT aperta e limpa os restos do anel
          // que sobravam no topo e no rodape.
          const RX = ${TIGHT} ? 0.74 : 0.80, RY = ${TIGHT} ? 0.90 : 1.00;
          const F0 = ${TIGHT} ? 0.80 : 0.85, F1 = ${TIGHT} ? 1.00 : 1.12;
          const nx = (x / COLS - 0.5) * 2 / RX;
          const ny = (y / ROWS - 0.5) * 2 / RY;
          const d = Math.sqrt(nx * nx + ny * ny);
          const mask = d >= F1 ? 0 : d <= F0 ? 1 : (F1 - d) / (F1 - F0);
          lum *= mask;
          if (lum < 26) { out += " "; continue; }
          const ch = RAMP[Math.min(RAMP.length - 1, Math.floor((lum / 255) * RAMP.length))];
          // Cor: "source" usa a luz azul/laranja da propria fonte; "green" e o
          // fosforo puro do claudius; "mono" e giz branco-azulado.
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
      // Ajusta o tamanho da fonte pra grade caber com folga no quadro.
      let fs = 18;
      pre.style.fontSize = fs + "px";
      const fit = () => pre.getBoundingClientRect();
      let r0 = fit();
      while ((r0.width > ${SIZE} - 120 || r0.height > ${SIZE} - ${CAPTION_ON ? 190 : 110}) && fs > 6) {
        fs -= 0.5; pre.style.fontSize = fs + "px"; r0 = fit();
      }
      resolve({ fontSize: fs, w: r0.width | 0, h: r0.height | 0 });
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
</script></body></html>`;

await page.setContent(html, { waitUntil: "load" });

// A imagem-fonte entra como data URL — sem servidor, sem CORS.
const fs = await import("node:fs");
const b64 = fs.readFileSync(SRC).toString("base64");
const info = await page.evaluate((d) => window.render(d), `data:image/png;base64,${b64}`);
console.log(`grade ${COLS}x${ROWS} · fonte ${info.fontSize}px · arte ${info.w}x${info.h}`);

await page.screenshot({ path: OUT, type: "png" });
await browser.close();
console.log(`salvo: ${OUT}`);
