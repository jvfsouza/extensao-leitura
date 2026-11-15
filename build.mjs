// Gera dist/: bundle do motor neural (Piper) + arquivos .wasm locais (MV3 não permite carregar código remoto).
import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
for (const d of ["ort", "piper"]) mkdirSync("dist/" + d, { recursive: true });

await build({
  entryPoints: ["src/offscreen.js", "src/worker-piper.js"],
  outdir: "dist",
  bundle: true,
  format: "esm",
  platform: "browser",
  minify: true,
  logLevel: "info",
});

// onnxruntime-web (inferência do modelo)
const ort = "node_modules/onnxruntime-web/dist/";
for (const f of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) cpSync(ort + f, "dist/ort/" + f);

// piper_phonemize (texto -> fonemas, espeak-ng em WebAssembly): módulo JS + .wasm + dados das vozes
const vits = "node_modules/@diffusionstudio/vits-web/dist/";
const glue = readdirSync(vits).find((f) => /^piper-.*\.js$/.test(f));
cpSync(vits + glue, "dist/piper/phonemize.js");
const pw = "node_modules/@diffusionstudio/piper-wasm/build/";
for (const f of ["piper_phonemize.wasm", "piper_phonemize.data"]) cpSync(pw + f, "dist/piper/" + f);

console.log("dist/ pronto.");
