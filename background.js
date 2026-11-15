// A fala roda no service worker para continuar mesmo depois que o popup fecha.
let pausado = false;
let sessao = 0; // identifica a leitura atual; eventos de leituras antigas são ignorados
let abaDestaque = null;

// Divide em frases (com posições no texto original) para poder destacar a frase atual.
function dividir(texto, max = 3000) {
  const re = /[^.!?\n]+[.!?]*["'”)\]]*\s*|[.!?]+\s*|\n+/g;
  const blocos = [];
  let m, atual = null;
  while ((m = re.exec(texto))) {
    const ini = m.index, fim = ini + m[0].length;
    if (atual && atual.fim - atual.ini < 40) atual.fim = fim; // junta fragmentos curtos ("Sr.", títulos)
    else {
      if (atual) blocos.push(atual);
      atual = { ini, fim };
    }
  }
  if (atual) blocos.push(atual);

  return blocos
    .flatMap((b) => {
      const partes = [];
      for (let i = b.ini; i < b.fim; i += max) partes.push({ ini: i, fim: Math.min(b.fim, i + max) });
      return partes;
    })
    .filter((b) => texto.slice(b.ini, b.fim).trim());
}

function avisarAba(msg) {
  if (abaDestaque == null) return;
  chrome.tabs.sendMessage(abaDestaque, msg).catch(() => {});
}

function limparDestaque() {
  avisarAba({ type: "limpar" });
}

let leitura = null; // { text, rate, voiceName, blocos, neural, inicio }
let blocoAtual = 0;
let ultimoEstadoNeural = null; // { estado: baixando|pronto|erro, pct, msg }
let neuralAtivo = false; // há uma leitura neural em andamento (ou pausada)

// O service worker do MV3 "dorme" após ~30 s parado e perde as variáveis; o estado fica em storage.session
// e é restaurado antes de tratar qualquer mensagem.
const restaurado = chrome.storage.session
  .get(["leitura", "estado"])
  .then(({ leitura: l, estado: e }) => {
    if (l) leitura = l;
    if (e) ({ pausado, sessao, blocoAtual, abaDestaque, ultimoEstadoNeural, neuralAtivo } = e);
  })
  .catch(() => {});
const salvarLeitura = () => chrome.storage.session.set({ leitura }).catch(() => {});
const salvarEstado = () =>
  chrome.storage.session
    .set({ estado: { pausado, sessao, blocoAtual, abaDestaque, ultimoEstadoNeural, neuralAtivo } })
    .catch(() => {});

// "piper:<id>" = voz neural offline (roda no offscreen document); o resto são vozes do sistema.
const ehNeural = (v) => typeof v === "string" && /^(piper|kokoro):/.test(v);

// Vozes neurais (Piper) rodam num offscreen document: service worker não toca áudio.
async function garantirOffscreen() {
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (ctxs.length) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Sintetizar e reproduzir voz neural (Piper/Kokoro) em segundo plano.",
  });
}

function offscreen(msg) {
  return chrome.runtime.sendMessage({ alvo: "offscreen", ...msg }).catch(() => {});
}

function destacarBloco(idx) {
  const b = leitura?.blocos[idx];
  if (!b) return;
  const trecho = leitura.text.slice(b.ini, b.fim);
  avisarAba({
    type: "destacar",
    fraseIni: b.ini + (trecho.length - trecho.trimStart().length),
    fraseFim: b.ini + trecho.trimEnd().length,
  });
}

function falar({ text, rate, voiceName, tabId }) {
  abaDestaque = tabId ?? null; // null = texto editado, sem mapa para destacar
  leitura = { text, rate, voiceName, blocos: dividir(text, ehNeural(voiceName) ? 3000 : 200), neural: ehNeural(voiceName), inicio: 0 };
  falarDe(0);
  salvarLeitura();
}

// Pula frases: delta > 0 avança, delta < 0 volta. Reinicia a fila a partir da frase escolhida.
function pular(delta) {
  if (!leitura) return;
  const alvo = blocoAtual + delta;
  if (alvo >= leitura.blocos.length) {
    sessao++;
    chrome.tts.stop();
    offscreen({ tipo: "p-parar" });
    pausado = false;
    neuralAtivo = false;
    limparDestaque();
    salvarEstado();
    return;
  }
  falarDe(Math.max(0, alvo));
}

// Troca velocidade/voz no meio da leitura: recomeça na frase em que estava (blocoAtual).
let reiniciarAoContinuar = false;
function reconfigurar({ rate, voiceName }) {
  if (!leitura) return false;
  if (rate != null) leitura.rate = rate;
  if (voiceName) {
    leitura.voiceName = voiceName;
    const eraNeural = leitura.neural;
    leitura.neural = ehNeural(voiceName);
    if (eraNeural !== leitura.neural) {
      // Tamanho dos blocos depende do tipo de voz: refaz a divisão e mantém a posição no texto.
      const pos = leitura.blocos[blocoAtual]?.ini ?? 0;
      leitura.blocos = dividir(leitura.text, leitura.neural ? 3000 : 200);
      blocoAtual = Math.max(0, leitura.blocos.findLastIndex((b) => b.ini <= pos));
    }
  }
  salvarLeitura();
  const ativa = leitura.neural ? neuralAtivo : true;
  if (!ativa && !pausado) return false; // leitura já terminou: só guarda a nova config
  if (pausado) {
    // Pausado: não começa a falar sozinho; aplica a config quando o usuário continuar.
    chrome.tts.stop();
    offscreen({ tipo: "p-parar" });
    reiniciarAoContinuar = true;
    return true;
  }
  falarDe(blocoAtual);
  return true;
}

function falarDe(inicio) {
  reiniciarAoContinuar = false;
  const { text, rate, voiceName, blocos } = leitura;
  const minha = ++sessao;
  chrome.tts.stop();
  limparDestaque();
  pausado = false;
  blocoAtual = inicio;
  leitura.inicio = inicio;
  neuralAtivo = leitura.neural;
  salvarLeitura();
  salvarEstado();

  if (leitura.neural) {
    garantirOffscreen()
      .then(() => {
        if (minha !== sessao) return;
        return offscreen({
          tipo: "p-falar",
          sessao: minha,
          voz: voiceName, // id completo, com o prefixo do motor
          velocidade: rate,
          textos: blocos.slice(inicio).map((b) => text.slice(b.ini, b.fim)),
        });
      })
      .catch((e) => {
        ultimoEstadoNeural = { estado: "erro", msg: String(e?.message || e) };
        neuralAtivo = false;
        salvarEstado();
      });
    return;
  }
  offscreen({ tipo: "p-parar" }); // veio de uma voz neural para uma voz do sistema

  blocos.forEach((b, i) => {
    if (i < inicio) return;
    const trecho = text.slice(b.ini, b.fim);
    const fraseIni = b.ini + (trecho.length - trecho.trimStart().length);
    const fraseFim = b.ini + trecho.trimEnd().length;

    chrome.tts.speak(trecho, {
      rate,
      voiceName,
      enqueue: true,
      onEvent: (ev) => {
        if (minha !== sessao) return;
        if (ev.type === "start") {
          blocoAtual = i;
          avisarAba({ type: "destacar", fraseIni, fraseFim });
        } else if (ev.type === "word") {
          const ini = b.ini + ev.charIndex;
          let fim;
          if (ev.length > 0) fim = ini + ev.length;
          else {
            const esp = /\s/.exec(text.slice(ini, ini + 80));
            fim = esp ? ini + esp.index : ini + 1;
          }
          avisarAba({ type: "destacar", fraseIni, fraseFim, palavraIni: ini, palavraFim: fim });
        } else if (ev.type === "end" && i === blocos.length - 1) {
          limparDestaque();
        } else if (ev.type === "error" || ev.type === "interrupted" || ev.type === "cancelled") {
          limparDestaque();
        }
      },
    });
  });
}

// Mensagens vindas do motor neural (offscreen).
function aoReceberDoMotor(msg) {
  if (msg.tipo === "p-estado") {
    ultimoEstadoNeural = { estado: msg.estado, pct: msg.pct, msg: msg.msg };
    salvarEstado();
  } else if (msg.tipo === "p-evento") {
    if (msg.sessao !== sessao || !leitura) return;
    if (msg.ev === "start") {
      const idx = msg.i + leitura.inicio;
      blocoAtual = idx;
      destacarBloco(idx);
      salvarEstado();
    } else if (msg.ev === "fim" || msg.ev === "erro") {
      neuralAtivo = false;
      limparDestaque();
      salvarEstado();
    }
  }
}

function tratar(msg, responder) {
  switch (msg.type) {
    case "speak":
      falar(msg);
      responder({ ok: true });
      break;
    case "pular":
      pular(msg.delta);
      responder({ ok: true });
      break;
    case "config":
      responder({ ok: reconfigurar(msg) });
      break;
    case "pause":
      if (leitura?.neural) offscreen({ tipo: "p-pausar" });
      else chrome.tts.pause();
      pausado = true;
      salvarEstado();
      responder({ ok: true });
      break;
    case "resume":
      if (reiniciarAoContinuar && leitura) {
        reiniciarAoContinuar = false;
        falarDe(blocoAtual);
        responder({ ok: true });
        break;
      }
      if (leitura?.neural) offscreen({ tipo: "p-continuar" });
      else chrome.tts.resume();
      pausado = false;
      salvarEstado();
      responder({ ok: true });
      break;
    case "stop":
      sessao++;
      chrome.tts.stop();
      offscreen({ tipo: "p-parar" });
      pausado = false;
      neuralAtivo = false;
      limparDestaque();
      salvarEstado();
      responder({ ok: true });
      break;
    case "status":
      if (leitura?.neural) responder({ falando: neuralAtivo, pausado, neural: ultimoEstadoNeural });
      else chrome.tts.isSpeaking((falando) => responder({ falando, pausado, neural: ultimoEstadoNeural }));
      break;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, responder) => {
  if (msg.tipo) {
    restaurado.then(() => aoReceberDoMotor(msg));
    return;
  }
  if (!msg.type) return;
  restaurado.then(() => tratar(msg, responder));
  return true; // resposta assíncrona (espera o estado ser restaurado)
});
