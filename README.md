# Librarian

A medium for deep, self-directed learning. Design doc: https://claude.ai/artifact/AdyuLsx3xpbK9x6SrcPSRy

This first piece is the settings panel: where you configure the models and searchers the librarian uses.

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
