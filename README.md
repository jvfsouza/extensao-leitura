<div align="center">

# 🔊 Leitor de Páginas

**Extensão do Chrome que extrai o texto de qualquer página e lê em voz alta, destacando o que está sendo lido.**

![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-F7DF1E?logo=javascript&logoColor=black)
![Voz neural](https://img.shields.io/badge/voz%20neural-Piper%20(offline)-ff8a00)
![Idiomas](https://img.shields.io/badge/idiomas-pt--BR%20%C2%B7%20English-009c3b)

</div>

---

## ✨ Funcionalidades

- 📄 **Extrai o texto principal** da página, ignorando menus, rodapés, anúncios e outros ruídos.
- ✂️ **Lê só um trecho:** selecione o que quiser na página antes de clicar em *Ler*.
- 🎙️ **Três tipos de voz:**
  - **Vozes neurais offline (Piper):** 4 em português do Brasil e 5 em inglês (EUA e Reino Unido). Rodam no próprio navegador e são leves (~60 MB cada).
  - **Vozes Kokoro (IA, offline):** modelo Kokoro-82M (82M parâmetros, Apache 2.0) com vozes em inglês (EUA/Reino Unido) e, em modo experimental, português do Brasil. Um único download de ~90 MB. Veja [Kokoro](#-kokoro-ia).
  - **Vozes do sistema** (`chrome.tts`): funcionam na hora, sem baixar nada, em qualquer idioma que o seu sistema tiver.
- 🖍️ **Destaque ao vivo na página:** a frase atual fica marcada e a palavra também (nas vozes do sistema). A página rola sozinha acompanhando a leitura.
- 🎨 **Cor e opacidade do destaque** ajustáveis no popup.
- ⏯️ **Controles estilo player:** ler, parar, pausar/continuar, voltar e avançar uma frase.
- ⚡ **Velocidade** de 0,5x a 2,5x.
- ✏️ **Texto editável:** edite o texto extraído antes de ler, copie ou baixe como `.txt`.
- 🔁 **Continua lendo com o popup fechado.**

## 🚀 Instalação

Requisitos: [Node.js](https://nodejs.org/) e Google Chrome.

```bash
git clone https://github.com/jvfsouza/extensao-leitura.git
cd extensao-leitura
npm install
npm run build      # gera a pasta dist/ (motor de voz neural + arquivos .wasm)
```

Depois, no Chrome:

1. Abra `chrome://extensions`.
2. Ative o **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e escolha a pasta do projeto.

> 💡 Sempre que mexer em algo dentro de `src/`, rode `npm run build` de novo e recarregue a extensão.
> As vozes do sistema funcionam mesmo sem o build.

## 🕹️ Como usar

1. Abra uma página com texto e clique no ícone da extensão.
2. *(Opcional)* Selecione um trecho da página para ler só ele.
3. Escolha a **voz** e a **velocidade**.
4. Clique em **Ler**.
5. Use ⏮ ⏯ ⏭ para voltar, pausar/continuar e avançar frases, ou **Parar** para encerrar.

> ⏳ Na **primeira vez** que você usa uma voz neural, ela (~60 MB) é baixada do Hugging Face e fica em cache. Depois disso funciona offline. O download só acontece quando você escolhe a voz.

## 🎙️ Vozes disponíveis

| Idioma | Vozes |
| --- | --- |
| 🇧🇷 Português (Brasil) | Faber, Cadu, Jeff, Edresson (leve) |
| 🇺🇸 English (US) | Lessac, Amy, Ryan |
| 🇬🇧 English (UK) | Alba, Alan |

O Piper tem muito mais vozes (alemão, espanhol, francês...). Para adicionar uma, veja [Dicas para quem for mexer](#-dicas-para-quem-for-mexer).

## 🤖 Kokoro (IA)

Segundo motor neural, ao lado do Piper (que continua igual). Usa o pacote [`kokoro-js`](https://github.com/hexgrad/kokoro) (v1.2.1) com o modelo [`onnx-community/Kokoro-82M-v1.0-ONNX`](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) quantizado em **q8** (cai para **q4** se o q8 falhar), rodando em **WebAssembly** num Web Worker (`src/worker-kokoro.js`), 100% no navegador.

- **Tamanho:** ~92 MB do modelo na primeira vez + ~0,5 MB por voz. Fica na Cache API; depois funciona offline. O popup mostra o progresso do download e o estado "carregando".
- **Vozes:** grupo "Kokoro (IA)" no seletor.
  - English (US): `af_heart`, `af_bella`, `am_michael`
  - English (UK): `bf_emma`, `bm_george`
  - Português (Brasil), **experimental**: `pf_dora`, `pm_alex`, `pm_santa`
- **Português:** os ids `pf_dora`, `pm_alex` e `pm_santa` existem no repositório do modelo, mas o `kokoro-js` 1.2.1 só aceita vozes em inglês (valida a voz e o fonemizador embutido só conhece inglês). Para contornar, a extensão fonemiza o texto com o espeak-ng `pt-br` que já vem empacotado para o Piper e entrega os fonemas ao modelo (`generate_from_ids`). A pronúncia pode ser menos natural que a do Piper em português, então prefira o Piper se não gostar.
- **Desempenho:** em CPU (WASM) a síntese é mais pesada que a do Piper; o texto é dividido em trechos de até ~200 caracteres e sintetizado à frente da reprodução (até 3 trechos na fila). Em máquinas lentas ou com velocidade alta pode haver pequenas pausas. WebGPU não é usado (exigiria o modelo fp32 de ~300 MB).
- **Licença:** modelo e pesos Apache 2.0.

## 🧠 Como funciona

A extensão tem quatro partes, cada uma rodando em um contexto diferente do Chrome:

```
┌─────────────┐  extrair / destacar   ┌──────────────┐
│  content.js │ ◄───────────────────► │              │
│ (na página) │                       │              │
└─────────────┘                       │ background.js│
                                      │  (service    │
┌─────────────┐  ler, pausar, pular   │   worker)    │   ┌───────────────────────────┐
│ popup.html  │ ────────────────────► │              │──►│ offscreen.html            │
│ popup.js    │                       │ divide texto │   │  └ worker.js (Piper)      │
└─────────────┘                       │ em frases    │   │  toca o áudio da voz      │
                                      └──────┬───────┘   │  neural                   │
                                             │           └───────────────────────────┘
                                             ▼
                                        chrome.tts
                                      (vozes do sistema)
```

### 1. Extração do texto: `content.js`

Injetado na página só quando você clica em *Ler* ou *Extrair* (permissão `activeTab`).

- Escolhe a raiz do conteúdo: o `<article>` ou `<main>`, ou o bloco com mais parágrafos.
- Percorre os nós de texto com um `TreeWalker`, descartando elementos invisíveis e ruído (`nav`, `footer`, `aside`, `script`, `button`...).
- Normaliza espaços e guarda um **mapa** entre cada posição do texto extraído e o nó do DOM original.

Esse mapa é a base do destaque: o DOM da página **nunca é alterado**.

### 2. Destaque: CSS Custom Highlight API

Com o mapa de posições, o `content.js` cria `Range`s do DOM e os registra com `CSS.highlights`. O estilo (`highlight.css`) é injetado com `chrome.scripting.insertCSS`, então funciona mesmo em páginas com CSP restritiva. A cor e a opacidade escolhidas no popup ficam no `chrome.storage` e são aplicadas ao vivo.

### 3. Orquestração: `background.js`

A fala fica no **service worker** para continuar com o popup fechado.

- Divide o texto em **frases**, guardando a posição de cada uma. Fragmentos curtos como "Sr." são unidos à frase seguinte.
- Para **vozes do sistema**, enfileira cada frase em `chrome.tts.speak`. Os eventos `start` e `word` indicam qual frase e qual palavra destacar.
- Para **vozes neurais**, manda as frases ao documento offscreen.
- **Pular e voltar** funcionam reiniciando a fila a partir da frase escolhida.

### 4. Voz neural: `offscreen.html` + `src/`

Service workers não tocam áudio, então o Chrome oferece o *Offscreen Document*.

| Arquivo | Papel |
| --- | --- |
| `src/offscreen.js` | Fila de reprodução: toca o áudio por `AudioContext`, controla pausa e parada, avisa o início de cada frase. |
| `src/worker-piper.js` | Web Worker do Piper: baixa a voz, fonemiza e sintetiza fora da thread de áudio. |
| `src/worker-kokoro.js` | Web Worker do Kokoro: baixa/carrega o modelo e sintetiza (inglês via `kokoro-js`, português via espeak pt-br). |


Cada frase passa por três etapas:

1. **Fonemização** com o `piper_phonemize` (espeak-ng em WebAssembly), no idioma da voz (pt-BR ou inglês).
2. **Inferência** do modelo [Piper](https://github.com/rhasspy/piper) (VITS, formato ONNX) via `onnxruntime-web`. A velocidade ajusta o `length_scale` do modelo, então a fala acelera ou desacelera sem mudar o tom.
3. **Áudio** em PCM, enviado de volta ao offscreen para tocar.

A síntese acontece **à frente da reprodução**, com até 3 trechos prontos na fila, então o áudio toca sem pausas entre as frases.

As vozes vêm de [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) e ficam na Cache API do navegador.

A síntese acontece **à frente da reprodução**, com até 3 trechos prontos na fila. O áudio toca sem pausas entre as frases.

## 📁 Estrutura do projeto

```
extensao-leitura/
├── manifest.json        # configuração da extensão (Manifest V3)
├── popup.html / .js     # interface: botões, voz, velocidade, destaque
├── background.js        # service worker: divide frases, controla a leitura
├── content.js           # roda na página: extrai o texto e aplica o destaque
├── highlight.css        # estilo base do destaque
├── offscreen.html       # documento que hospeda o motor de voz neural
├── src/
│   ├── offscreen.js     # fila de áudio e controle de reprodução
│   ├── worker-piper.js  # download das vozes, fonemização e inferência do Piper
│   └── worker-kokoro.js # modelo Kokoro-82M (kokoro-js): download, fonemização e inferência
├── build.mjs            # empacota src/ e copia os .wasm para dist/
├── icons/               # ícones da extensão
└── dist/                # gerado por `npm run build` (não vai pro git)
```

## 🔧 Dicas para quem for mexer

- **Adicionar uma voz do Piper:** escolha uma em [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices/tree/main) e acrescente o id (ex.: `es_ES-davefx-medium`) em `VOZES_PIPER`, no `popup.js`. O download usa o id para montar o caminho, então não precisa mexer em mais nada.
- **Vozes mais leves:** as de qualidade `low` e `x_low` pesam menos, com som um pouco menos natural.
- **Por que o build?** O Manifest V3 não permite carregar código remoto. O `build.mjs` empacota tudo com o esbuild e copia os `.wasm` para `dist/`.

## 🔒 Privacidade

- O texto da página **não sai do seu computador**: tanto as vozes do sistema quanto as neurais sintetizam localmente.
- A única conexão externa é o download de cada voz neural (ou do modelo Kokoro) no Hugging Face, na primeira vez que ela é usada.
- As permissões são mínimas: `activeTab`, `scripting`, `tts`, `storage` e `offscreen`, mais acesso ao Hugging Face para baixar as vozes.

## ⚠️ Limitações

- Não funciona em páginas internas do Chrome (`chrome://`) nem na Chrome Web Store.
- Se você **editar o texto** no popup antes de ler, a leitura ocorre normalmente, mas sem destaque na página, pois o texto deixa de bater com o mapa.
- Nas vozes neurais, o destaque é por **frase**. O destaque por palavra só existe nas vozes do sistema.
