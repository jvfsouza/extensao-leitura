const $ = (id) => document.getElementById(id);
const enviar = (msg) => chrome.runtime.sendMessage(msg);

const ICONE_PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
const ICONE_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
function mostrarPausa(pausado) {
  $("pausar").innerHTML = pausado ? ICONE_PLAY : ICONE_PAUSE;
  $("pausar").title = pausado ? "Continuar" : "Pausar";
}
mostrarPausa(false);

let textoExtraido = ""; // texto exatamente como extraído (só ele tem mapa para o destaque)
let abaExtraida = null;

async function extrair() {
  const [aba] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const alvo = { tabId: aba.id };
    await chrome.scripting.insertCSS({ target: alvo, files: ["highlight.css"] });
    await chrome.scripting.executeScript({ target: alvo, files: ["content.js"] });
    const r = await chrome.tabs.sendMessage(aba.id, { type: "extrair" });
    textoExtraido = r.texto;
    abaExtraida = aba.id;
    $("texto").value = r.texto;
    $("info").textContent = `${r.texto.length} caracteres (${r.origem}).`;
  } catch (e) {
    $("info").textContent = "Não foi possível ler esta página (ex.: chrome://, Web Store).";
  }
}

// Vozes neurais offline (Piper). Cada voz (~60 MB) é baixada na 1ª vez que for usada.
const VOZES_PIPER = {
  "Português (Brasil)": [
    { id: "pt_BR-faber-medium", nome: "Faber (masculina)" },
    { id: "pt_BR-cadu-medium", nome: "Cadu (masculina)" },
    { id: "pt_BR-jeff-medium", nome: "Jeff (masculina)" },
    { id: "pt_BR-edresson-low", nome: "Edresson (masculina, leve)" },
  ],
  "English (US)": [
    { id: "en_US-lessac-medium", nome: "Lessac (female)" },
    { id: "en_US-amy-medium", nome: "Amy (female)" },
    { id: "en_US-ryan-medium", nome: "Ryan (male)" },
  ],
  "English (UK)": [
    { id: "en_GB-alba-medium", nome: "Alba (female)" },
    { id: "en_GB-alan-medium", nome: "Alan (male)" },
  ],
};

// Vozes neurais Kokoro-82M (IA, Apache 2.0). Modelo único (~177 MB em CPU, ~326 MB com WebGPU), baixado na 1ª vez. As vozes em português
// (pf_/pm_) usam fonemização espeak pt-br própria da extensão (experimental); as em inglês usam o kokoro-js.
const VOZES_KOKORO = {
  "Português (Brasil) · experimental": [
    { id: "pf_dora", nome: "Dora (feminina)" },
    { id: "pm_alex", nome: "Alex (masculina)" },
    { id: "pm_santa", nome: "Santa (masculina)" },
  ],
  "English (US)": [
    { id: "af_heart", nome: "Heart (female)" },
    { id: "af_bella", nome: "Bella (female)" },
    { id: "am_michael", nome: "Michael (male)" },
  ],
  "English (UK)": [
    { id: "bf_emma", nome: "Emma (female)" },
    { id: "bm_george", nome: "George (male)" },
  ],
};
// Tamanho do download do Kokoro: com WebGPU usa o modelo fp32 (~326 MB, ~3x mais rápido); sem, o uint8 (~177 MB).
let kokoroMB = 177;
(async () => {
  try {
    if (navigator.gpu && (await navigator.gpu.requestAdapter())) kokoroMB = 326;
  } catch {}
})();
const ehKokoro = () => $("voz").value.startsWith("kokoro:");
const ehNeuralSel = () => /^(piper|kokoro):/.test($("voz").value);

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

// Mensagens de erro claras em português para as falhas mais comuns.
function traduzirErro(msg) {
  const m = String(msg || "desconhecido");
  if (/Failed to fetch|NetworkError|Load failed|fetch/i.test(m)) return "sem conexão com huggingface.co para baixar o modelo. Verifique a internet e tente de novo.";
  if (/memory|alloc|OOM/i.test(m)) return "memória insuficiente para o modelo. Feche abas pesadas e tente de novo.";
  return m;
}

function mostrarEstadoNeural(e) {
  if (!e) return;
  const k = ehKokoro();
  if (e.estado === "baixando")
    $("info").textContent = k
      ? `Baixando o modelo Kokoro… ${e.pct ?? 0}% (~${e.mb || kokoroMB} MB, só na primeira vez)`
      : `Baixando a voz… ${e.pct ?? 0}% (só na primeira vez)`;
  else if (e.estado === "carregando") $("info").textContent = "Carregando o modelo na memória…";
  else if (e.estado === "buffer") $("info").textContent = "Preparando áudio… (buffer)";
  else if (e.estado === "erro") $("info").textContent = `Erro na voz neural: ${traduzirErro(e.msg)}`;
  else if (e.estado === "pronto") $("info").textContent = k ? "Lendo com Kokoro (IA)…" : "Lendo com voz neural…";
}
chrome.runtime.onMessage.addListener((m) => {
  if (m.tipo === "p-estado") mostrarEstadoNeural(m);
});

async function carregarVozes() {
  chrome.tts.getVoices((vozes) => {
    vozes.sort((a, b) => (b.lang?.startsWith("pt") ? 1 : 0) - (a.lang?.startsWith("pt") ? 1 : 0));
    $("voz").innerHTML =
      Object.entries(VOZES_PIPER)
        .map(
          ([grupo, lista]) =>
            `<optgroup label="${grupo} · neurais (offline)">` +
            lista.map((v) => `<option value="piper:${v.id}">${v.nome} · Piper</option>`).join("") +
            `</optgroup>`,
        )
        .join("") +
      Object.entries(VOZES_KOKORO)
        .map(
          ([grupo, lista]) =>
            `<optgroup label="Kokoro (IA) · ${grupo}">` +
            lista.map((v) => `<option value="kokoro:${v.id}">${v.nome} · Kokoro</option>`).join("") +
            `</optgroup>`,
        )
        .join("") +
      `<optgroup label="Vozes do sistema">` +
      vozes
        .map((v) => `<option value="${esc(v.voiceName)}">${esc(v.voiceName)} (${esc(v.lang || "?")})</option>`)
        .join("") +
      `</optgroup>`;
    chrome.storage.local.get(["voz", "vel"], ({ voz, vel }) => {
      if (voz) $("voz").value = voz;
      if (vel) { $("vel").value = vel; $("velValor").value = Number(vel).toFixed(1); }
    });
  });
}

$("extrair").onclick = extrair;

$("ler").onclick = async () => {
  // Texto vazio ou ainda intacto: re-extrai (pega a aba/seleção atual). Texto editado: lê como está, sem destaque.
  const atual = $("texto").value;
  if (!atual.trim() || atual === textoExtraido) await extrair();
  const text = $("texto").value;
  if (!text.trim()) return;
  const comDestaque = text === textoExtraido;
  enviar({
    type: "speak",
    text,
    rate: Number($("vel").value),
    voiceName: $("voz").value,
    tabId: comDestaque ? abaExtraida : null,
  });
  if (ehKokoro()) $("info").textContent = `Preparando o Kokoro (IA)… (a 1ª vez baixa ~${kokoroMB} MB)`;
  else if (ehNeuralSel()) $("info").textContent = "Preparando voz neural… (a 1ª vez baixa ~60 MB)";
  else $("info").textContent = comDestaque ? "Lendo…" : "Lendo texto editado (sem destaque na página).";
  mostrarPausa(false);
};

$("pausar").onclick = async () => {
  const { pausado } = await enviar({ type: "status" });
  await enviar({ type: pausado ? "resume" : "pause" });
  mostrarPausa(!pausado);
};

$("parar").onclick = () => {
  enviar({ type: "stop" });
  mostrarPausa(false);
};

const pular = async (delta) => {
  await enviar({ type: "pular", delta });
  mostrarPausa(false);
};
$("pular").onclick = () => pular(1);
$("anterior").onclick = () => pular(-1);

// Se estiver lendo (ou pausado), aplica a nova velocidade/voz e recomeça da frase atual.
// O slider dispara várias vezes ao arrastar, então espera um instante antes de aplicar.
let timerConfig = null;
function aplicarAoVivo() {
  clearTimeout(timerConfig);
  timerConfig = setTimeout(async () => {
    const s = await enviar({ type: "status" }).catch(() => null);
    if (!s || !(s.falando || s.pausado)) return;
    await enviar({ type: "config", rate: Number($("vel").value), voiceName: $("voz").value });
    if (ehNeuralSel()) $("info").textContent = "Trocando de voz… continua da frase atual.";
    else $("info").textContent = "Continuando da frase atual com a nova configuração.";
  }, 350);
}

$("vel").oninput = () => {
  $("velValor").value = Number($("vel").value).toFixed(1);
  chrome.storage.local.set({ vel: $("vel").value });
  aplicarAoVivo();
};
// Digitar o valor: ao confirmar (Enter/sair do campo) limita ao intervalo e sincroniza o slider.
const limitar = (v, min, max, dec) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min)).toFixed(dec);
$("velValor").onchange = () => {
  $("vel").value = limitar(parseFloat(String($("velValor").value).replace(",", ".")), 0.5, 2.5, 1);
  $("vel").oninput();
};
$("voz").onchange = () => {
  chrome.storage.local.set({ voz: $("voz").value });
  aplicarAoVivo();
};

// Cor/opacidade do destaque: salvas no storage; o content.js aplica ao vivo na página.
function hexParaRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
function atualizarPreviaDestaque() {
  const op = Number($("hlOp").value);
  if (document.activeElement !== $("hlOpValor")) $("hlOpValor").value = op;
  $("hlPrev").style.background = hexParaRgba($("hlCor").value, op / 100);
}
chrome.storage.local.get(["hlCor", "hlOp"], ({ hlCor, hlOp }) => {
  if (hlCor) $("hlCor").value = hlCor;
  if (hlOp) $("hlOp").value = hlOp;
  atualizarPreviaDestaque();
});
// Cores favoritas (até 8): guardam cor + opacidade. "+" salva a atual, clique aplica, botão direito remove.
let favoritas = []; // [{ cor: "#rrggbb", op: 10..100 }]
const MAX_FAVS = 8;
const salvarFavs = () => chrome.storage.local.set({ hlFavs: favoritas });
function desenharFavoritas() {
  const box = $("hlFavs");
  box.textContent = "";
  const corAtual = $("hlCor").value.toLowerCase();
  const opAtual = Number($("hlOp").value);
  favoritas.forEach((f) => {
    const b = document.createElement("button");
    b.className = "fav" + (f.cor === corAtual && f.op === opAtual ? " ativa" : "");
    b.style.background = hexParaRgba(f.cor, f.op / 100);
    b.title = `${f.cor} · ${f.op}% — clique para usar, botão direito para remover`;
    b.onclick = () => {
      $("hlCor").value = f.cor;
      $("hlOp").value = f.op;
      $("hlOp").oninput();
    };
    b.oncontextmenu = (e) => {
      e.preventDefault();
      favoritas = favoritas.filter((x) => x !== f);
      salvarFavs();
      desenharFavoritas();
    };
    box.append(b);
  });
  if (favoritas.length < MAX_FAVS) {
    const add = document.createElement("button");
    add.className = "fav fav-add";
    add.textContent = "+";
    add.title = "Salvar cor e opacidade atuais nos favoritos";
    add.onclick = () => {
      if (!favoritas.some((f) => f.cor === corAtual && f.op === opAtual)) favoritas.push({ cor: corAtual, op: opAtual });
      salvarFavs();
      desenharFavoritas();
    };
    box.append(add);
  }
  if (!favoritas.length) {
    const d = document.createElement("span");
    d.className = "favs-dica";
    d.textContent = "Toque em + para salvar a cor e a opacidade atuais.";
    box.append(d);
  }
}
chrome.storage.local.get("hlFavs", ({ hlFavs }) => {
  // Aceita favoritos antigos (só a cor, como string) e assume 50% de opacidade.
  favoritas = (Array.isArray(hlFavs) ? hlFavs : [])
    .map((f) => (typeof f === "string" ? { cor: f.toLowerCase(), op: 50 } : f))
    .filter((f) => f && /^#[0-9a-f]{6}$/i.test(f.cor));
  desenharFavoritas();
});

$("hlGota").onclick = async () => {
  // Conta-gotas nativo (pega qualquer cor da tela); sem suporte, abre o seletor comum.
  if (!window.EyeDropper) return $("hlCor").click();
  try {
    const { sRGBHex } = await new EyeDropper().open();
    $("hlCor").value = sRGBHex;
    $("hlCor").dispatchEvent(new Event("input"));
  } catch { /* cancelado */ }
};
$("hlOpValor").oninput = () => {
  const v = parseFloat($("hlOpValor").value);
  if (!Number.isFinite(v)) return;
  $("hlOp").value = limitar(v, 10, 100, 0);
  $("hlOp").oninput();
};
$("hlOpValor").onchange = () => { $("hlOpValor").value = $("hlOp").value; };
$("hlCor").oninput = $("hlOp").oninput = () => {
  atualizarPreviaDestaque();
  desenharFavoritas();
  chrome.storage.local.set({ hlCor: $("hlCor").value, hlOp: Number($("hlOp").value) });
};

$("copiar").onclick = async () => {
  await navigator.clipboard.writeText($("texto").value);
  $("info").textContent = "Copiado!";
};

$("baixar").onclick = () => {
  const blob = new Blob([$("texto").value], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "texto-extraido.txt";
  a.click();
  URL.revokeObjectURL(a.href);
};

carregarVozes();

// Ao reabrir o popup durante um download/erro, mostra o estado atual.
enviar({ type: "status" })
  .then((s) => {
    if (s?.neural && s.neural.estado !== "pronto") mostrarEstadoNeural(s.neural);
  })
  .catch(() => {});
