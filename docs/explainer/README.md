# The explainer video

A two-and-a-half-minute video about what Librarian is for: why it exists, the problem it takes on, and
how it works. Its footage is the real app, recorded on the live site; its narration is
[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) text-to-speech. The home page shows it when
the server has `data/explainer.mp4` (and `data/explainer.jpg` as its poster).

| File | What it does |
| --- | --- |
| `script.json` | The scenes: what's said, and what's on screen. Voice `af_heart`. |
| `prep.mjs` | Builds the demo canvases on the site as a fresh anonymous visitor: a slide from a research talk with a box, a descent and a grown shape; a lecture stopped at a moment with a box on its frame. Answers the librarian's question if it asks one. |
| `titles.mjs` | Renders the title cards (the opening, the climb, the end) to PNGs. |
| `record.mjs` | Records one clip per app scene with Playwright, gliding the canvas like a person would, and notes where each shot starts. |
| `compose.py` | Cuts each scene's picture to its narration plus a breath either side, with soft fades, and joins them. |

## Making it

You need Node, Python 3, ffmpeg, Google Chrome, `playwright-core` (installed wherever you work), and an
OpenAI-compatible text-to-speech endpoint serving Kokoro.

1. Narrate each scene into `$WORK/audio/<id>.wav` from `script.json` (`POST /v1/audio/speech` with
   `{"input": say, "voice": "af_heart", "response_format": "wav"}`).
2. `SLIDE=slide.png node prep.mjs` (a slide image of your choosing), then save that visitor's session to
   `$WORK/state.json` (Playwright's `storageState`) for recording.
3. `node titles.mjs`, then `PLAYWRIGHT_BROWSERS_PATH=… node record.mjs`.
4. `python3 compose.py out.mp4`, then copy it to the server's `data/explainer.mp4`.

Things learned on the way:

- Playwright records through its own ffmpeg build; pointing `PLAYWRIGHT_BROWSERS_PATH` at a folder with
  `ffmpeg-<rev>/ffmpeg-linux` linked to the system ffmpeg works.
- Recording a persistent profile hangs; record plain contexts that load a saved session instead.
- Headless Chrome can't draw YouTube's video once it seeks, and a page that sends work to the server
  while being screen-recorded can lock up. The shots that need those (drawing a box, pressing Stop)
  stop just short of them and show the result already made.
- Scroll the canvas by sending wheel events to it directly: a video player under the cursor swallows them.
