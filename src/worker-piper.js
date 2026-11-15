// Web Worker do Piper: baixa as vozes, fonemiza (espeak-ng via piper_phonemize) e sintetiza (VITS via onnxruntime).
// Roda fora da thread principal para que a reprodução de áudio e as mensagens (pausar/parar) não travem.
import * as ort from "onnxruntime-web/wasm";

const HF = "https://huggingface.co/rhasspy/piper-voices/resolve/main";
const CACHE = "piper-vozes-v1";

let base = ""; // URL raiz da extensão (chrome.runtime.getURL("")), enviada pela thread principal
const vozes = new Map(); // id -> Promise<{ sessao, cfg }>

function estado(estado, extra = {}) {
  self.postMessage({ tipo: "estado", estado, ...extra });
}

// "pt_BR-faber-medium" -> "pt/pt_BR/faber/medium/pt_BR-faber-medium"
function caminhoVoz(id) {
  const [loc, nome, qual] = id.split("-");
  return `${loc.split("_")[0]}/${loc}/${nome}/${qual}/${id}`;
}

// ---------- Download com cache (Cache API) ----------

async function baixar(url, aoProgredir) {
  const cache = await caches.open(CACHE);
  const guardado = await cache.match(url);
  if (guardado) return guardado.arrayBuffer();

  const r = await fetch(url);
  if (!r.ok) throw new Error(`Falha ao baixar a voz (${r.status}).`);
  const total = Number(r.headers.get("Content-Length")) || 0;
  const leitor = r.body.getReader();
  const partes = [];
  let lido = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    partes.push(value);
    lido += value.length;
    aoProgredir?.(lido, total);
  }
  const blob = new Blob(partes);
  await cache.put(url, new Response(blob));
  return blob.arrayBuffer();
}

// ---------- Voz (modelo + configuração) ----------

function carregarVoz(id) {
  if (!vozes.has(id)) {
    const p = (async () => {
      const url = `${HF}/${caminhoVoz(id)}.onnx`;
      estado("baixando", { pct: 0 });
      const cfg = JSON.parse(new TextDecoder().decode(await baixar(url + ".json")));
      const modelo = await baixar(url, (l, t) => estado("baixando", { pct: t ? Math.round((l / t) * 100) : 0 }));

      ort.env.wasm.wasmPaths = base + "dist/ort/";
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
      const sessao = await ort.InferenceSession.create(modelo, { executionProviders: ["wasm"] });
      estado("pronto");
      return { sessao, cfg };
    })();
    p.catch(() => vozes.delete(id)); // permite nova tentativa
    vozes.set(id, p);
  }
  return vozes.get(id);
}

// ---------- Fonemização (piper_phonemize, espeak-ng em WebAssembly) ----------

let fabrica = null;
let moduloWasm = null;

// Converte os fonemas do espeak em IDs usando o phoneme_id_map da PRÓPRIA voz (como o Piper original):
// "^" + (fonema + "_")... + "$". O mapa padrão do phonemizer gera IDs fora do vocabulário de várias vozes.
function fonemasParaIds(fonemas, mapa) {
  const ids = [...(mapa["^"] ?? [])];
  for (const f of fonemas) {
    if (!mapa[f]) continue;
    ids.push(...mapa[f], ...(mapa["_"] ?? []));
  }
  ids.push(...(mapa["$"] ?? []));
  return ids;
}

async function fonemizar(texto, vozEspeak, mapa) {
  fabrica ??= (await import(/* @vite-ignore */ base + "dist/piper/phonemize.js")).createPiperPhonemize;
  moduloWasm ??= WebAssembly.compileStreaming(fetch(base + "dist/piper/piper_phonemize.wasm")).catch((e) => {
    moduloWasm = null; // permite nova tentativa
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
  mod.callMain(["-l", vozEspeak, "--input", JSON.stringify([{ text: texto }]), "--espeak_data", "/espeak-ng-data"]);
  if (!saida) throw new Error("Não consegui converter o texto em fonemas.");
  const ids = Array.isArray(saida.phonemes) && mapa ? fonemasParaIds(saida.phonemes, mapa) : saida.phoneme_ids;
  if (!ids?.length) throw new Error("Não consegui converter o texto em fonemas.");
  return ids;
}

// ---------- Síntese ----------

async function sintetizar(texto, id, velocidade) {
  const { sessao, cfg } = await carregarVoz(id);
  const ids = await fonemizar(texto, cfg.espeak.voice, cfg.phoneme_id_map);
  const { noise_scale, length_scale, noise_w } = cfg.inference;

  const entradas = {
    input: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new ort.Tensor("int64", BigInt64Array.of(BigInt(ids.length))),
    // length_scale maior = fala mais devagar; dividir pela velocidade acelera/desacelera sem mudar o tom.
    scales: new ort.Tensor("float32", Float32Array.of(noise_scale, length_scale / velocidade, noise_w)),
  };
  if (cfg.num_speakers > 1) entradas.sid = new ort.Tensor("int64", BigInt64Array.of(0n));

  const saida = await sessao.run(entradas);
  const pcm = new Float32Array(saida.output.data); // cópia própria, transferível
  return { pcm, sr: cfg.audio.sample_rate };
}

self.onmessage = async ({ data }) => {
  const { tipo, id } = data;
  try {
    if (tipo === "init") {
      base = data.base;
    } else if (tipo === "carregar") {
      await carregarVoz(data.voz);
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
