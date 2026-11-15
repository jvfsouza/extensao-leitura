// Offscreen document (voz neural Piper): reproduz o áudio e coordena a fila. A síntese (pesada)
// roda num Web Worker (src/worker-piper.js), assim esta thread fica livre para tocar
// áudio e atender pausar/parar sem atraso.

const motores = {}; // nome do motor ("piper") -> { worker, pendentes }
let proxId = 0;

function motor(nome) {
  if (motores[nome]) return motores[nome];
  const worker = new Worker(chrome.runtime.getURL(`dist/worker-${nome}.js`), { type: "module" });
  worker.postMessage({ tipo: "init", base: chrome.runtime.getURL("") });
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
  ganho.gain.value = 0.0003;
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

let sessaoAtual = 0;
let prontos = [];
let tocando = false;
let produtorTerminou = false;
let fonteAtual = null;

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
  const proximo = prontos.shift();
  if (!proximo) {
    if (produtorTerminou) emitir(sessao, -1, "fim");
    return;
  }
  const { item, audio } = proximo;
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
    if (item.ultima) emitir(sessao, item.bloco, "end");
    tocarProximo(sessao);
  };
  src.start();
}

async function falar({ sessao, textos, voz, velocidade }) {
  parar();
  sessaoAtual = sessao;
  const { nome: nomeMotor, voz: vozId } = separar(voz);

  const itens = [];
  textos.forEach((texto, bloco) => {
    const partes = partirTexto(texto).filter((p) => /[\p{L}\p{N}]/u.test(p));
    if (!partes.length) itens.push({ bloco, texto: null, primeira: true, ultima: true });
    else partes.forEach((p, k) => itens.push({ bloco, texto: p, primeira: k === 0, ultima: k === partes.length - 1 }));
  });

  try {
    await carregar(voz);
    if (sessao !== sessaoAtual) return;
    obterCtx();
    const vel = Math.min(2.5, Math.max(0.5, velocidade || 1));

    for (const item of itens) {
      // Mantém no máximo 3 trechos prontos à frente para não gastar CPU/memória à toa.
      while (prontos.length >= 3 && sessao === sessaoAtual) await new Promise((r) => setTimeout(r, 100));
      if (sessao !== sessaoAtual) return;
      const audio = item.texto ? await chamar(nomeMotor, { tipo: "sintetizar", texto: item.texto, voz: vozId, velocidade: vel }) : null;
      if (sessao !== sessaoAtual) return;
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
