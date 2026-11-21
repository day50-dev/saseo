# Librarian

A research librarian with unlimited time, on an infinite desk that never gets rearranged.

Drop a screenshot of something beyond you (a slide from a research talk, a page of a paper), box the
part that stopped you, and the librarian finds introductory material and draws an explanation that
starts with *why*, descending toward what you already know instead of climbing into more jargon.
Select any words in it to go one level further down. Everything stays where it was placed.

The design, principles and roadmap are in [docs/DESIGN.md](docs/DESIGN.md).

## Use

1. Open the panel and set up the models and searchers under **Settings**.
2. Drop or paste an image (a slide, a page, a screenshot) onto the canvas.
3. Drag a box over the part that stopped you. The librarian reads it, searches the enabled
   searchers, and writes a card beside it: why it exists, what it is, how it's used here,
   and what the name means, citing what it found. If a System One model is configured,
   it checks the card doesn't lean on harder terms than its subject and asks for one rewrite if it does.
4. Select any words in a card and click **Explain** to go one level further down.

Scroll to pan, Ctrl+scroll (or pinch) to zoom. Nothing on the canvas moves once placed.
The canvas is an append-only log in `data/canvas.jsonl`; dropped images are kept in `data/assets/`.

## Run

```bash
npm install
npm run dev        # API on 127.0.0.1:8787, panel on http://localhost:5173
```

Or `npm run build && npm start` to serve the built panel from the API on port 8787.

## What it configures

- **Language model**: any OpenAI-compatible `/chat/completions` endpoint (base URL, model, key).
- **System One decision model**: a System One `/systemone` endpoint, e.g. TypeSafe Jev (`https://api.typesafe.ai/v1`, `jev-latest`) or a LiteLLM proxy.
- **Searchers**: Keenable (works with no key), SearXNG, Brave, Exa, Perplexity Sonar, Parallel, You.com, Tavily.
  Keenable uses its official SDK; the rest go through [agent-web-search](https://github.com/hbmartin/agent-web-search).

Each section has a Test button, and the searchers section has a side-by-side test search.

## Keys

Keys are stored in `data/config.json` (mode 600, gitignored), or the path in `SEMSHAPES_CONFIG`.
The server never sends them to the browser; the panel only sees whether a key is set and its last four characters.
The server listens on 127.0.0.1 only.
