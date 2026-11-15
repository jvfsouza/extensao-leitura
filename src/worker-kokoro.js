// Web Worker do Kokoro (Kokoro-82M, Apache 2.0): TTS neural de 82M de parâmetros rodando 100% no navegador.
// Mesmo protocolo do worker-piper.js (init / carregar / sintetizar). O modelo (~90 MB, q8) é baixado do
// Hugging Face na 1ª vez e guardado na Cache API pelo próprio transformers.js; os .wasm do onnxruntime são locais.
//
// Idiomas: o kokoro-js só fonemiza inglês (pacote "phonemizer", espeak-ng só com vozes en). Para o português
// (vozes pf_/pm_) o texto é fonemizado aqui com o espeak-ng "pt-br" do piper_phonemize (já empacotado para o
// Piper) e os fonemas vão direto ao modelo via generate_from_ids. É um caminho experimental (ver README).
import { KokoroTTS, env } from "kokoro-js";

const MODELO = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DTYPES = ["q8", "q4"]; // q8 (~92 MB); q4 como alternativa se q8 falhar

let base = ""; // URL raiz da extensão (chrome.runtime.getURL(""))
let tts = null; // Promise<KokoroTTS>

function estado(estado, extra = {}) {
  self.postMessage({ tipo: "estado", estado, ...extra });
}

// ---------- Modelo ----------

function carregarModelo() {
  if (!tts) {
    tts = (async () => {
      env.wasmPaths = base + "dist/kokoro/";
      let ultimo;
      for (const dtype of DTYPES) {
        const arquivos = new Map(); // arquivo -> { loaded, total }
        let ultimoPct = -1; // o callback dispara milhares de vezes; só avisa quando a % muda
        estado("baixando", { pct: 0 });
        try {
          const modelo = await KokoroTTS.from_pretrained(MODELO, {
            dtype,
            device: "wasm",
            progress_callback: (p) => {
              if (p.status === "progress" && p.file) {
                arquivos.set(p.file, { loaded: p.loaded, total: p.total });
                let l = 0, t = 0;
                for (const a of arquivos.values()) { l += a.loaded; t += a.total; }
                const pct = t ? Math.min(99, Math.round((l / t) * 100)) : 0;
                if (pct !== ultimoPct) {
                  ultimoPct = pct;
                  estado("baixando", { pct });
                }
              } else if (p.status === "ready") {
                estado("carregando");
              }
            },
          });
          estado("carregando");
          estado("pronto");
          return modelo;
        } catch (e) {
          console.warn(`Kokoro: falha com dtype ${dtype}`, e);
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

async function sintetizar(texto, voz, velocidade) {
  const modelo = await carregarModelo();
  let audio;
  if (ehPortugues(voz)) {
    const fonemas = ajustarFonemas(await fonemasPtBr(texto));
    if (!fonemas) throw new Error("Não consegui converter o texto em fonemas.");
    const { input_ids } = modelo.tokenizer(fonemas, { truncation: true });
    audio = await modelo.generate_from_ids(input_ids, { voice: voz, speed: velocidade });
  } else {
    audio = await modelo.generate(texto, { voice: voz, speed: velocidade });
  }
  const pcm = new Float32Array(audio.audio); // cópia própria, transferível
  return { pcm, sr: audio.sampling_rate };
}

self.onmessage = async ({ data }) => {
  const { tipo, id } = data;
  try {
    if (tipo === "init") {
      base = data.base;
    } else if (tipo === "carregar") {
      await carregarModelo();
      self.postMessage({ tipo: "ok", id });
    } else if (tipo === "sintetizar") {
      const r = await sintetizar(data.texto, data.voz, data.velocidade);
      self.postMessage({ tipo: "audio", id, pcm: r.pcm, sr: r.sr }, [r.pcm.buffer]);
    }
  } catch (e) {
    console.error(e);
    self.postMessage({ tipo: "erro", id, msg: String(e?.message || e) });
  }
};
