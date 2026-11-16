// Roda dentro da página. Extrai o texto mantendo o mapa (offset do texto -> nó do DOM)
// para poder destacar o trecho que está sendo lido, sem alterar o DOM da página.
(() => {
  if (window.__leitorCarregado) return;
  window.__leitorCarregado = true;

  const RUIDO =
    "script,style,noscript,nav,header:not(article header),footer,aside,form,iframe,svg,button," +
    "[role=navigation],[role=banner],[role=complementary],[aria-hidden=true]";
  const BLOCO = "p,div,li,h1,h2,h3,h4,h5,h6,blockquote,section,article,tr,td,th,pre,figcaption,dd,dt";

  let segmentos = []; // { ini, len, node, mapa[] } — mapa: índice no texto normalizado -> índice em node.data
  let ultimaFrase = "";

  const temHighlight = !!(window.CSS && CSS.highlights && window.Highlight);
  const hlFrase = temHighlight ? new Highlight() : null;
  const hlPalavra = temHighlight ? new Highlight() : null;
  if (temHighlight) {
    hlPalavra.priority = 1;
    CSS.highlights.set("leitor-frase", hlFrase);
    CSS.highlights.set("leitor-palavra", hlPalavra);
  }

  // Cor/opacidade configuráveis. Stylesheet construída (adoptedStyleSheets) não é bloqueada por CSP.
  const folhaCor = temHighlight && "adoptedStyleSheets" in document ? new CSSStyleSheet() : null;
  function aplicarCor(hlCor = "#2f6fed", hlOp = 50) {
    if (!folhaCor || !/^#[0-9a-f]{6}$/i.test(hlCor)) return;
    const n = parseInt(hlCor.slice(1), 16);
    const rgb = `${n >> 16}, ${(n >> 8) & 255}, ${n & 255}`;
    const a = Math.min(1, Math.max(0.05, Number(hlOp) / 100));
    folhaCor.replaceSync(
      `::highlight(leitor-frase){background-color:rgba(${rgb},${(a * 0.55).toFixed(3)});}` +
      `::highlight(leitor-palavra){background-color:rgba(${rgb},${a.toFixed(3)});}`
    );
  }
  if (folhaCor) {
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, folhaCor];
    chrome.storage.local.get(["hlCor", "hlOp"], ({ hlCor, hlOp }) => aplicarCor(hlCor, hlOp));
    chrome.storage.onChanged.addListener((mud, area) => {
      if (area !== "local" || !(mud.hlCor || mud.hlOp)) return;
      chrome.storage.local.get(["hlCor", "hlOp"], ({ hlCor, hlOp }) => aplicarCor(hlCor, hlOp));
    });
  }

  function escolherRaiz() {
    const direta = document.querySelector("article") || document.querySelector("main, [role=main]");
    if (direta) return direta;
    let melhor = document.body, melhorTam = 0;
    document.querySelectorAll("div, section").forEach((el) => {
      const tam = [...el.children]
        .filter((c) => c.tagName === "P")
        .reduce((s, p) => s + p.innerText.length, 0);
      if (tam > melhorTam) { melhorTam = tam; melhor = el; }
    });
    return melhor;
  }

  function extrair() {
    segmentos = [];
    const sel = getSelection();
    let intervalo = null, raiz, origem = "página";
    if (sel && !sel.isCollapsed && sel.toString().trim()) {
      intervalo = sel.getRangeAt(0);
      raiz = intervalo.commonAncestorContainer;
      origem = "seleção";
    } else {
      raiz = escolherRaiz();
    }

    const cacheVis = new Map(), cacheRuido = new Map();
    const visivel = (el) => {
      if (!cacheVis.has(el)) cacheVis.set(el, el.checkVisibility ? el.checkVisibility() : true);
      return cacheVis.get(el);
    };
    const ruido = (el) => {
      if (!cacheRuido.has(el)) {
        // Ruído só conta se estiver dentro da raiz: um <form> que envolve a página inteira (ASP.NET) não é ruído.
        const r = el.closest(RUIDO);
        cacheRuido.set(el, !!r && r !== raiz && raiz.contains(r));
      }
      return cacheRuido.get(el);
    };

    const walker = document.createTreeWalker(raiz.nodeType === 3 ? raiz.parentNode : raiz, NodeFilter.SHOW_TEXT);
    let texto = "", blocoAnterior = null;

    for (let n; (n = walker.nextNode()); ) {
      const pai = n.parentElement;
      if (!pai) continue;
      if (intervalo && !intervalo.intersectsNode(n)) continue;
      if (!visivel(pai)) continue;
      if (!intervalo && ruido(pai)) continue;

      let ini = 0, fim = n.data.length;
      if (intervalo) {
        if (n === intervalo.startContainer) ini = intervalo.startOffset;
        if (n === intervalo.endContainer) fim = intervalo.endOffset;
      }

      const bloco = pai.closest(BLOCO);
      const mudouBloco = texto && bloco !== blocoAnterior;
      let ult = !texto || mudouBloco ? "\n" : texto[texto.length - 1];
      let norm = "";
      const mapa = [];
      for (let i = ini; i < fim; i++) {
        let c = n.data[i];
        if (/\s/.test(c)) {
          if (/\s/.test(ult)) continue;
          c = " ";
        }
        norm += c;
        mapa.push(i);
        ult = c;
      }
      if (!norm) continue;

      // A quebra de linha guarda a estrutura (a voz neural a transforma em pausa): título = 3 (pausa longa),
      // itens de lista seguidos = 1 (curta), o resto = 2 (parágrafo). Os offsets dos segmentos seguem corretos.
      if (mudouBloco) {
        const titulo = (b) => b && /^H[1-6]$/.test(b.tagName);
        const item = (b) => b && b.tagName === "LI";
        texto += titulo(bloco) || titulo(blocoAnterior) ? "\n\n\n" : item(bloco) && item(blocoAnterior) ? "\n" : "\n\n";
      }
      segmentos.push({ ini: texto.length, len: norm.length, node: n, mapa });
      texto += norm;
      blocoAnterior = bloco;
    }

    return { texto: texto.trimEnd(), origem };
  }

  // Primeiro segmento cujo fim é > pos.
  function acharSeg(pos) {
    let a = 0, b = segmentos.length;
    while (a < b) {
      const m = (a + b) >> 1;
      const s = segmentos[m];
      if (s.ini + s.len > pos) b = m; else a = m + 1;
    }
    return a;
  }

  function criarRange(ini, fim) {
    if (ini == null || fim == null || fim <= ini || !segmentos.length) return null;
    const i = acharSeg(ini);
    if (i >= segmentos.length) return null;
    const si = segmentos[i];
    const offIni = si.mapa[Math.max(0, ini - si.ini)];

    const j = acharSeg(fim - 1);
    let noFim, offFim;
    if (j < segmentos.length && segmentos[j].ini <= fim - 1) {
      const s = segmentos[j];
      noFim = s.node;
      offFim = s.mapa[fim - 1 - s.ini] + 1;
    } else if (j > 0) {
      const s = segmentos[j - 1];
      noFim = s.node;
      offFim = s.mapa[s.len - 1] + 1;
    } else {
      return null;
    }

    try {
      const r = document.createRange();
      r.setStart(si.node, offIni);
      r.setEnd(noFim, offFim);
      return r.collapsed ? null : r;
    } catch {
      return null; // a página mudou o DOM depois da extração
    }
  }

  function limpar() {
    if (!temHighlight) return;
    hlFrase.clear();
    hlPalavra.clear();
    ultimaFrase = "";
  }

  function destacar({ fraseIni, fraseFim, palavraIni, palavraFim }) {
    if (!temHighlight) return;
    const frase = criarRange(fraseIni, fraseFim);
    const palavra = criarRange(palavraIni, palavraFim);
    hlFrase.clear();
    hlPalavra.clear();
    if (frase) hlFrase.add(frase);
    if (palavra) hlPalavra.add(palavra);

    // Rola até a frase apenas quando ela muda e está fora da tela.
    const chave = `${fraseIni}-${fraseFim}`;
    if (frase && chave !== ultimaFrase) {
      ultimaFrase = chave;
      const r = frase.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) {
        frase.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, responder) => {
    if (msg.type === "extrair") responder(extrair());
    else if (msg.type === "destacar") destacar(msg);
    else if (msg.type === "limpar") limpar();
  });
})();
