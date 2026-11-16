// Offscreen document (voz neural Piper): reproduz o áudio e coordena a fila. A síntese (pesada)
// roda num Web Worker (src/worker-piper.js), assim esta thread fica livre para tocar
// áudio e atender pausar/parar sem atraso.

const motores = {}; // nome do motor ("piper" | "kokoro") -> { worker, pendentes }
let proxId = 0;

function motor(nome) {
  if (motores[nome]) return motores[nome];
  const worker = new Worker(chrome.runtime.getURL(`dist/worker-${nome}.js`), { type: "module" });
  worker.postMessage({ tipo: "init", base: chrome.runtime.getURL(""), cfg: globalThis.__kokoroCfg }); // __kokoroCfg: só para testes de desempenho
  const m = (motores[nome] = { worker, pendentes: new Map() });

  worker.onmessage = ({ data }) => {
    if (data.tipo === "estado") {
      emitirEstado(data.estado, { pct: data.pct });
      return;
    }
    const p = m.pendentes.get(data.id);
    if (!p) return;
    m.pendentes.delete(data.id);
    if (data.tipo === "erro") p.err(new Error(data.msg));
    else p.ok(data);
  };
  worker.onerror = (e) => {
    console.error("Erro no worker:", e);
    emitirEstado("erro", { msg: e.message || "falha ao iniciar o motor de voz" });
    for (const p of m.pendentes.values()) p.err(new Error(e.message || "falha no worker"));
    m.pendentes.clear();
  };
  return m;
}

// "piper:pt_BR-faber-medium" -> { nome: "piper", voz: "pt_BR-faber-medium" }
function separar(vozCompleta) {
  const i = vozCompleta.indexOf(":");
  return { nome: vozCompleta.slice(0, i), voz: vozCompleta.slice(i + 1) };
}

function chamar(nome, msg) {
  const m = motor(nome);
  return new Promise((ok, err) => {
    const id = ++proxId;
    m.pendentes.set(id, { ok, err });
    m.worker.postMessage({ ...msg, id });
  });
}

function emitirEstado(estado, extra = {}) {
  chrome.runtime.sendMessage({ tipo: "p-estado", estado, ...extra }).catch(() => {});
}

function emitir(sessao, i, ev) {
  chrome.runtime.sendMessage({ tipo: "p-evento", sessao, i, ev }).catch(() => {});
}

// ---------- Áudio ----------

let ctx = null;
let pausadoPeloUsuario = false;

function obterCtx() {
  ctx ??= new AudioContext();
  if (ctx.state === "suspended" && !pausadoPeloUsuario) ctx.resume().catch(() => {});
  return ctx;
}

// O Chrome fecha offscreen documents de áudio após 30 s sem tocar nada; o download inicial do modelo
// pode passar disso. Um sinal praticamente inaudível mantém o documento vivo durante o carregamento.
function manterVivo() {
  const c = obterCtx();
  const osc = c.createOscillator();
  const ganho = c.createGain();
  ganho.gain.value = 0.004; // margem sobre o limiar de silêncio do Chrome (~-72 dBFS), senão o documento fecha em 30 s
  osc.frequency.value = 40;
  osc.connect(ganho).connect(c.destination);
  osc.start();
  return () => {
    try { osc.stop(); } catch {}
    osc.disconnect();
  };
}

const carregando = new Map(); // id da voz -> Promise
function carregar(voz) {
  if (!carregando.has(voz)) {
    const p = (async () => {
      const soltar = manterVivo();
      try {
        const { nome, voz: v } = separar(voz);
        await chamar(nome, { tipo: "carregar", voz: v });
      } finally {
        soltar();
      }
    })();
    p.catch(() => carregando.delete(voz)); // permite nova tentativa
    carregando.set(voz, p);
  }
  return carregando.get(voz);
}

// ---------- Fila de síntese + reprodução ----------
//
// A síntese pode ser mais lenta que o tempo real (Kokoro em CPU). Para a leitura não engasgar:
//  - o 1º trecho é curto (começa a falar cedo);
//  - mede-se o RTF (tempo de síntese / duração do áudio) ao vivo e, se RTF > 1, a reprodução só começa
//    (ou retoma, se a fila secar) depois de haver áudio suficiente para a síntese restante terminar antes
//    de ele acabar (atraso = restante * (RTF - 1), com teto);
//  - a fila de pré-síntese é medida em segundos de áudio, não em nº de trechos.

let sessaoAtual = 0;
let prontos = []; // { item, audio }
let tocando = false;
let produtorTerminou = false;
let fonteAtual = null;
let emBuffer = false; // aguardando acumular áudio (mostrado no popup)
let jaTocou = false; // já começou a falar nesta sessão
let charsRestantes = 0; // texto ainda não sintetizado
let hist = []; // últimos trechos sintetizados: { ms, dur }
let totChars = 0;
let totDur = 0;
let fimUltimo = 0;
let fimAgendado = 0; // currentTime em que o trecho atual termina
let perf = null;

const TETO_BUFFER_INICIAL = 20; // s: espera inicial máxima
const TETO_BUFFER_RETOMADA = 10; // s: espera máxima quando a fila seca no meio da leitura
const FILA_MIN = 20; // s de áudio sintetizado à frente (mínimo)
globalThis.__perf = () => perf; // diagnóstico (testes de desempenho)

const segProntos = () => prontos.reduce((a, p) => a + (p.audio ? p.audio.pcm.length / p.audio.sr : 0), 0);
const rtfAtual = () => {
  const h = hist.slice(-4);
  const dur = h.reduce((a, x) => a + x.dur, 0);
  return dur ? h.reduce((a, x) => a + x.ms / 1000, 0) / dur : null;
};

// Quanto áudio precisa estar pronto antes de (re)começar a falar sem secar no meio.
function leadNecessario() {
  const rtf = rtfAtual();
  if (rtf == null || produtorTerminou) return 0;
  const restSeg = charsRestantes / (totChars / totDur || 14);
  const falta = restSeg * (rtf * 1.1 - 1); // 10% de folga
  return Math.min(Math.max(0, falta), jaTocou ? TETO_BUFFER_RETOMADA : TETO_BUFFER_INICIAL);
}

// Se o próximo trecho demora mais para sintetizar do que o áudio já à frente dura, a reprodução secaria
// antes dele ficar pronto. Nesse caso (RTF <= ~1) ele é partido para caber na folga atual.
function adaptarTamanho(itens, idx) {
  const it = itens[idx];
  const r = rtfAtual();
  if (!it?.texto || r == null || r > 1.15 || !totDur) return;
  const folga = segProntos() + (tocando ? Math.max(0, fimAgendado - (ctx?.currentTime || 0)) : 0);
  if (folga <= 0) return;
  const maxC = Math.max(40, Math.floor((folga / r) * (totChars / totDur) * 0.9));
  if (it.texto.length <= maxC + 25) return;
  const c = cortar(it.texto, maxC, Math.round(maxC * 0.5));
  const a = it.texto.slice(0, c + 1).trim(), b = it.texto.slice(c + 1).trim();
  if (a && b) itens.splice(idx, 1, { ...it, texto: a, ultima: false, pausaApos: 0 }, { ...it, texto: b, primeira: false });
}

function marcar(tipo, extra = {}) {
  perf?.ev.push({ t: Math.round(performance.now() - perf.t0), tipo, ...extra });
}

// Ponto de corte em pontuação (>= min) mais perto de max; senão no último espaço.
function cortar(t, max, min) {
  const cand = [". ", "! ", "? ", "… ", "; ", ": ", ", "];
  let corte = -1;
  for (const c of cand) {
    const i = t.lastIndexOf(c, max - 1);
    if (i >= min && i + c.length - 1 > corte) corte = i + c.length - 1;
  }
  if (corte < 0) corte = t.lastIndexOf(" ", max);
  if (corte <= 0) corte = max;
  return corte;
}

function partirTexto(texto, max = 260) {
  let t = texto.replace(/\s+/g, " ").trim();
  const partes = [];
  while (t.length > max) {
    let corte = Math.max(t.lastIndexOf(", ", max), t.lastIndexOf("; ", max), t.lastIndexOf(": ", max));
    if (corte < max * 0.4) corte = t.lastIndexOf(" ", max);
    if (corte <= 0) corte = max;
    partes.push(t.slice(0, corte + 1).trim());
    t = t.slice(corte + 1).trim();
  }
  if (t) partes.push(t);
  return partes;
}

function parar() {
  sessaoAtual = -1;
  prontos = [];
  tocando = false;
  produtorTerminou = false;
  emBuffer = false;
  pausadoPeloUsuario = false;
  if (fonteAtual) {
    fonteAtual.onended = null;
    try { fonteAtual.stop(); } catch {}
    fonteAtual = null;
  }
  if (ctx?.state === "suspended") ctx.resume().catch(() => {});
}

function tocarProximo(sessao) {
  if (sessao !== sessaoAtual || tocando) return;
  if (!prontos.length) {
    if (produtorTerminou) emitir(sessao, -1, "fim");
    return;
  }
  // Fila curta demais para a velocidade de síntese: espera acumular (evita pausas repetidas).
  if (!produtorTerminou && segProntos() < leadNecessario()) {
    if (!emBuffer) {
      emBuffer = true;
      marcar("buffer");
      emitirEstado("buffer");
    }
    return;
  }
  if (emBuffer) {
    emBuffer = false;
    emitirEstado("pronto");
  }
  const { item, audio } = prontos.shift();
  if (item.primeira) emitir(sessao, item.bloco, "start");

  if (!audio) { // bloco sem nada para falar (só pontuação)
    if (item.ultima) emitir(sessao, item.bloco, "end");
    tocarProximo(sessao);
    return;
  }

  const c = obterCtx();
  const buf = c.createBuffer(1, audio.pcm.length, audio.sr);
  buf.copyToChannel(audio.pcm, 0);
  const src = c.createBufferSource();
  src.buffer = buf;
  src.connect(c.destination);
  tocando = true;
  fonteAtual = src;
  src.onended = () => {
    if (sessao !== sessaoAtual) return;
    tocando = false;
    fonteAtual = null;
    fimUltimo = performance.now();
    if (item.ultima) emitir(sessao, item.bloco, "end");
    tocarProximo(sessao);
  };
  src.start();
  fimAgendado = c.currentTime + buf.duration;
  if (perf) {
    const agora = performance.now();
    if (!jaTocou) perf.ttfs = Math.round(agora - perf.t0);
    else if (fimUltimo) {
      const gap = Math.round(agora - fimUltimo);
      if (gap > 40) perf.gaps.push(gap);
    }
    marcar("play", { dur: +(audio.pcm.length / audio.sr).toFixed(2), fila: +segProntos().toFixed(1) });
  }
  jaTocou = true;
}

async function falar({ sessao, textos, voz, velocidade }) {
  parar();
  sessaoAtual = sessao;
  jaTocou = false;
  hist = [];
  totChars = 0;
  totDur = 0;
  fimUltimo = 0;
  perf = { t0: performance.now(), ev: [], gaps: [], synth: [], ttfs: null };
  const { nome: nomeMotor, voz: vozId } = separar(voz);

  const itens = [];
  const vel0 = Math.min(2.5, Math.max(0.5, velocidade || 1));
  textos.forEach((texto, bloco) => {
    // Estrutura do texto -> pausas: 1 quebra = curta (item de lista), 2 = parágrafo, 3+ = título.
    const flat = [];
    for (const m of texto.matchAll(/([^\n]+)(\n*)/g)) {
      const quebras = m[2].length;
      const pausa = (quebras >= 3 ? 1.1 : quebras === 2 ? 0.7 : quebras === 1 ? 0.35 : 0) / Math.sqrt(vel0);
      const partes = partirTexto(m[1], nomeMotor === "kokoro" ? 220 : 260).filter((p) => /[\p{L}\p{N}]/u.test(p));
      partes.forEach((p, k) => {
        const fim = k === partes.length - 1;
        // Título/item sem pontuação final: o ponto faz a entonação cair, como no fim de uma frase.
        if (fim && quebras && /[\p{L}\p{N})"'”\]]$/u.test(p)) p += ".";
        flat.push({ bloco, texto: p, pausaApos: fim ? pausa : 0 });
      });
    }
    if (!flat.length) itens.push({ bloco, texto: null, primeira: true, ultima: true });
    else flat.forEach((it, k) => itens.push({ ...it, primeira: k === 0, ultima: k === flat.length - 1 }));
  });
  // Rampa: 1º trecho curto (começa a falar cedo) e 2º médio (precisa ficar pronto enquanto o 1º toca);
  // depois os trechos têm o tamanho normal.
  if (nomeMotor === "kokoro") {
    [85, 130].forEach((lim, i) => {
      const it = itens[i];
      if (!it?.texto || it.texto.length <= lim + 30) return;
      const c = cortar(it.texto, lim, Math.round(lim * 0.5));
      const a = it.texto.slice(0, c + 1).trim(), b = it.texto.slice(c + 1).trim();
      if (a && b) itens.splice(i, 1, { ...it, texto: a, ultima: false, pausaApos: 0 }, { ...it, texto: b, primeira: false });
    });
  }
  charsRestantes = itens.reduce((a, i) => a + (i.texto?.length || 0), 0);

  try {
    await carregar(voz);
    if (sessao !== sessaoAtual) return;
    obterCtx();
    const vel = Math.min(2.5, Math.max(0.5, velocidade || 1));
    perf.t0 = performance.now(); // exclui o carregamento do modelo da medição

    for (let idx = 0; idx < itens.length; idx++) {
      // Não sintetiza muito além do necessário (CPU/memória), mas sempre o bastante para o buffer adaptativo.
      while (sessao === sessaoAtual && tocando && segProntos() >= Math.max(FILA_MIN, leadNecessario() + 8)) await new Promise((r) => setTimeout(r, 100));
      if (sessao !== sessaoAtual) return;
      adaptarTamanho(itens, idx);
      const item = itens[idx];
      let audio = null;
      if (item.texto) {
        const r = await chamar(nomeMotor, { tipo: "sintetizar", texto: item.texto, voz: vozId, velocidade: vel });
        if (sessao !== sessaoAtual) return;
        audio = r;
        const dur = r.pcm.length / r.sr;
        if (r.ms) {
          hist.push({ ms: r.ms, dur });
          totChars += item.texto.length;
          totDur += dur;
          perf.synth.push({ chars: item.texto.length, ms: Math.round(r.ms), dur: +dur.toFixed(2), rtf: +(r.ms / 1000 / dur).toFixed(2) });
        }
        charsRestantes -= item.texto.length;
      }
      // Pausa de estrutura (título/parágrafo/item): silêncio no fim do áudio, assim respeita pausar/retomar.
      if (audio && item.pausaApos > 0 && idx < itens.length - 1) {
        const mudo = Math.round(item.pausaApos * audio.sr);
        const pcm = new Float32Array(audio.pcm.length + mudo);
        pcm.set(audio.pcm);
        audio = { ...audio, pcm };
      }
      prontos.push({ item, audio });
      tocarProximo(sessao);
    }
    produtorTerminou = true;
    tocarProximo(sessao);
  } catch (e) {
    console.error(e);
    if (sessao === sessaoAtual) {
      emitirEstado("erro", { msg: String(e?.message || e) });
      emitir(sessao, -1, "erro");
    }
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.alvo !== "offscreen") return;
  switch (msg.tipo) {
    case "p-falar": falar(msg); break;
    case "p-pausar": pausadoPeloUsuario = true; ctx?.suspend(); break;
    case "p-continuar": pausadoPeloUsuario = false; ctx?.resume(); break;
    case "p-parar": parar(); break;
  }
});
