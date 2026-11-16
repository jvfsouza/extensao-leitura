// Web Worker do Kokoro (Kokoro-82M, Apache 2.0): TTS neural de 82M de parâmetros rodando 100% no navegador.
// Mesmo protocolo do worker-piper.js (init / carregar / sintetizar). O modelo (~90 MB, q8) é baixado do
// Hugging Face na 1ª vez e guardado na Cache API pelo próprio transformers.js; os .wasm do onnxruntime são locais.
//
// Idiomas: o kokoro-js só fonemiza inglês (pacote "phonemizer", espeak-ng só com vozes en). Para o português
// (vozes pf_/pm_) o texto é fonemizado aqui com o espeak-ng "pt-br" do piper_phonemize (já empacotado para o
// Piper) e os fonemas vão direto ao modelo via generate_from_ids. É um caminho experimental (ver README).
import { KokoroTTS, env } from "kokoro-js";
import { env as tenv } from "@huggingface/transformers"; // o env do kokoro-js só expõe wasmPaths; o do transformers dá acesso a env.backends.onnx

const MODELO = "onnx-community/Kokoro-82M-v1.0-ONNX";

let base = ""; // URL raiz da extensão (chrome.runtime.getURL(""))
let tts = null; // Promise<KokoroTTS>
let cfg = {}; // ajustes de teste: { device, dtype, threads }
let falhas = []; // motivos de candidatos descartados (diagnóstico)
let escolhido = null; // { device, dtype } efetivamente em uso

function estado(estado, extra = {}) {
  self.postMessage({ tipo: "estado", estado, ...extra });
}

// ---------- Modelo ----------
//
// Motor de inferência, em ordem de preferência (RTF = tempo de síntese / duração do áudio; medido num PC de 12 núcleos):
//  1. WebGPU + fp32 (~326 MB): RTF ~0,4. Só se houver adapter WebGPU; é validado com uma síntese de teste
//     (som finito e não mudo) e, se falhar (ou falhar depois, em runtime), cai para o WASM.
//     O fp16 (~163 MB) foi descartado: no onnxruntime-web deste projeto devolve só NaN (áudio mudo).
//  2. WASM (CPU) + uint8 (~177 MB): RTF ~0,6, 4 threads (4 = 8 = 12 threads; 1 thread é ~1,6x mais lento).
//  3. WASM + q8 (~92 MB): RTF ~1,2-1,4 (mais lento que a fala), só se o uint8 não carregar.

async function temWebGPU() {
  try {
    return !!(self.navigator?.gpu && (await self.navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

let semWebGPU = false; // WebGPU falhou nesta sessão (carregamento ou 1ª síntese): não tenta de novo

// Arquivo de cada variante no repositório do modelo (a Cache API guarda pela URL).
const ARQ = { fp32: "model.onnx", uint8: "model_uint8.onnx", q8: "model_quantized.onnx" };
async function emCache(dtype) {
  try {
    const c = await caches.open("transformers-cache");
    return !!(await c.match(`https://huggingface.co/${MODELO}/resolve/main/onnx/${ARQ[dtype]}`));
  } catch {
    return false;
  }
}

async function candidatos() {
  if (cfg.device && cfg.device !== "auto") return [{ device: cfg.device, dtype: cfg.dtype || (cfg.device === "webgpu" ? "fp32" : "q8") }];
  const l = [];
  if (!semWebGPU && (await temWebGPU())) l.push({ device: "webgpu", dtype: "fp32" });
  l.push({ device: "wasm", dtype: "uint8" });
  // Se só uma das variantes principais já está baixada, usa ela em vez de baixar outra (evita 326 MB à toa).
  const baixadas = await Promise.all(l.map((c) => emCache(c.dtype)));
  const prontas = l.filter((_, i) => baixadas[i]), faltam = l.filter((_, i) => !baixadas[i]);
  return [...prontas, ...faltam, { device: "wasm", dtype: "q8" }];
}

const estatAudio = (pcm) => {
  let pico = 0, soma = 0, ruins = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i];
    if (!Number.isFinite(v)) { ruins++; continue; }
    if (Math.abs(v) > pico) pico = Math.abs(v);
    soma += v * v;
  }
  return { n: pcm.length, pico, rms: Math.sqrt(soma / (pcm.length || 1)), ruins };
};
const audioValido = (pcm) => {
  const e = estatAudio(pcm);
  return e.ruins === 0 && e.n > 1000 && e.pico > 0.02;
};

function carregarModelo() {
  if (!tts) {
    tts = (async () => {
      env.wasmPaths = base + "dist/kokoro/";
      self.navigator?.storage?.persist?.().catch(() => {}); // pede armazenamento permanente: o Chrome não apaga o modelo sozinho
      const nucleos = self.navigator?.hardwareConcurrency || 4;
      tenv.backends.onnx.wasm.numThreads = cfg.threads || Math.min(4, Math.max(2, Math.floor(nucleos / 2)));
      let ultimo;
      for (const cand of await candidatos()) {
        const arquivos = new Map(); // arquivo -> { loaded, total }
        let ultimoPct = -1; // o callback dispara milhares de vezes; só avisa quando a % muda
        const jaBaixado = await emCache(cand.dtype); // lendo do cache o progresso não é download
        estado(jaBaixado ? "carregando" : "baixando", { pct: 0 });
        try {
          const modelo = await KokoroTTS.from_pretrained(MODELO, {
            dtype: cand.dtype,
            device: cand.device,
            progress_callback: (p) => {
              if (p.status === "progress" && p.file && !jaBaixado) {
                arquivos.set(p.file, { loaded: p.loaded, total: p.total });
                let l = 0, t = 0;
                for (const a of arquivos.values()) { l += a.loaded; t += a.total; }
                const pct = t ? Math.min(99, Math.round((l / t) * 100)) : 0;
                if (pct !== ultimoPct) {
                  ultimoPct = pct;
                  estado("baixando", { pct, mb: Math.round(t / 1e6) });
                }
              } else if (p.status === "ready") {
                estado("carregando");
              }
            },
          });
          estado("carregando");
          if (cand.device === "webgpu") {
            // Síntese de teste: valida o resultado e já compila os shaders (senão a 1ª frase real demora ~4 s a mais).
            const t = await modelo.generate("Hello, this is a test.", { voice: "af_heart" });
            if (cfg.simularFalhaGpu || !audioValido(t.audio)) throw new Error("WebGPU produziu áudio inválido " + JSON.stringify(estatAudio(t.audio)));
          }
          escolhido = cand;
          estado("pronto");
          return modelo;
        } catch (e) {
          console.warn(`Kokoro: falha com ${cand.device}/${cand.dtype}`, e);
          falhas.push(`${cand.device}/${cand.dtype}: ${e?.message || e}`);
          if (cand.device === "webgpu") semWebGPU = true;
          ultimo = e;
        }
      }
      throw new Error(`Não foi possível carregar o modelo Kokoro (${ultimo?.message || ultimo}). Verifique a conexão com huggingface.co.`);
    })();
    tts.catch(() => (tts = null)); // permite nova tentativa
  }
  return tts;
}

// ---------- Fonemização do português (espeak-ng pt-br via piper_phonemize) ----------

let fabrica = null;
let moduloWasm = null;

async function fonemasPtBr(texto) {
  fabrica ??= (await import(/* @vite-ignore */ base + "dist/piper/phonemize.js")).createPiperPhonemize;
  moduloWasm ??= WebAssembly.compileStreaming(fetch(base + "dist/piper/piper_phonemize.wasm")).catch((e) => {
    moduloWasm = null;
    throw e;
  });
  const wasm = await moduloWasm;
  let saida = null;
  const mod = await fabrica({
    print(linha) {
      saida ??= JSON.parse(linha);
    },
    printErr() {},
    locateFile: (f) => base + "dist/piper/" + f,
    instantiateWasm(imports, pronto) {
      WebAssembly.instantiate(wasm, imports).then((inst) => pronto(inst, wasm));
      return {};
    },
  });
  mod.callMain(["-l", "pt-br", "--input", JSON.stringify([{ text: texto }]), "--espeak_data", "/espeak-ng-data"]);
  if (!saida || !Array.isArray(saida.phonemes)) throw new Error("Não consegui converter o texto em fonemas.");
  return saida.phonemes.flat().join("");
}

// Ajustes dos fonemas do espeak para o Kokoro (o tokenizador já descarta símbolos fora do vocabulário).
function ajustarFonemas(f) {
  f = f.replace(/ʲ/g, "j").replace(/[͜͡]/g, "").replace(/\s+/g, " ");
  return f.trim();
}

// ---------- Síntese ----------

const ehPortugues = (voz) => voz.startsWith("p");

async function gerar(modelo, texto, voz, velocidade) {
  if (ehPortugues(voz)) {
    const fonemas = ajustarFonemas(await fonemasPtBr(texto));
    if (!fonemas) throw new Error("Não consegui converter o texto em fonemas.");
    const { input_ids } = modelo.tokenizer(fonemas, { truncation: true });
    return modelo.generate_from_ids(input_ids, { voice: voz, speed: velocidade });
  }
  return modelo.generate(texto, { voice: voz, speed: velocidade });
}

async function sintetizar(texto, voz, velocidade) {
  let modelo = await carregarModelo();
  let audio;
  try {
    audio = await gerar(modelo, texto, voz, velocidade);
    if (cfg.simularFalhaGpuRuntime && escolhido?.device === "webgpu") throw new Error("falha simulada");
    if (escolhido?.device === "webgpu" && !audioValido(audio.audio)) throw new Error("WebGPU produziu áudio inválido");
  } catch (e) {
    if (escolhido?.device !== "webgpu") throw e;
    // Falha em runtime no WebGPU (perda de dispositivo, shader, memória…): refaz tudo no WASM e segue.
    console.warn("Kokoro: WebGPU falhou na síntese; voltando para WASM", e);
    semWebGPU = true;
    tts = null;
    escolhido = null;
    modelo = await carregarModelo();
    audio = await gerar(modelo, texto, voz, velocidade);
  }
  const pcm = new Float32Array(audio.audio); // cópia própria, transferível
  return { pcm, sr: audio.sampling_rate };
}

self.onmessage = async ({ data }) => {
  const { tipo, id } = data;
  try {
    if (tipo === "init") {
      base = data.base;
      if (data.cfg) cfg = data.cfg;
    } else if (tipo === "carregar") {
      const t0 = performance.now();
      await carregarModelo();
      self.postMessage({ tipo: "ok", id, ms: performance.now() - t0, motor: escolhido, falhas, threads: tenv.backends.onnx.wasm.numThreads });
    } else if (tipo === "sintetizar") {
      const t0 = performance.now();
      const r = await sintetizar(data.texto, data.voz, data.velocidade);
      self.postMessage({ tipo: "audio", id, pcm: r.pcm, sr: r.sr, ms: performance.now() - t0 }, [r.pcm.buffer]);
    }
  } catch (e) {
    console.error(e);
    self.postMessage({ tipo: "erro", id, msg: String(e?.message || e) });
  }
};
