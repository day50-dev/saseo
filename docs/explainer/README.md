# The explainer video

A short video about what Librarian is for: why it exists, the problem it takes on, and how it
works: boxes and descents, growing shapes, lectures, whole pages kept whole, hands-free calls, and
example notebooks. Its footage is the real app, recorded on the live site; its narration is
[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) text-to-speech. The home page shows it when
the server has `data/explainer.mp4` (and `data/explainer.jpg` as its poster).

| File | What it does |
| --- | --- |
| `script.json` | The scenes: what's said, and what's on screen. Voice `af_heart`. |
| `prep.mjs` | Builds the demo canvases on the site as a fresh anonymous visitor: a slide from a research talk with a box, a descent and a grown shape; a lecture stopped at a moment with a box on its frame. Answers the librarian's question if it asks one. |
| `prep-page.mjs` | The Wikipedia article on eigenvalues as a canvas, and an example notebook asked for in its chat. |
| `prep-call.mjs` | Makes the call the call scene shows, for real (pointing at a piece, words selected); the scene replays its answer. |
| `prep-figures.mjs` | The Wikipedia article on Lagrangian mechanics as a canvas, with lectures, a plot, a graph, a table and a map asked for in its chat (goals file themselves as they arrive). |
| `prep-goals.mjs` | A descent on "generalized coordinates" there, so the goals scene has a subgoal. |
| `prep-call-which.mjs` | The second call scene's turns, for real: pointing at Berlin on the map, then "take the chart off" (numbered three ways) and a pick; whatever it removes is put back. |
| `narrate.mjs` | Narrates scenes through the site's own speech route (`/api/speech/say`, Kokoro), when the speech server isn't reachable directly. |
| `titles.mjs` | Renders the title cards (the opening, the climb, the end) to PNGs. |
| `record.mjs` | Records one clip per app scene with Playwright, gliding the canvas like a person would, and notes where each shot starts. |
| `compose.py` | Cuts each scene's picture to its narration plus a breath either side, with soft fades, and joins them. Scenes naming the same `"clip"` in a row play one shot straight through, without fades (the opening: scenes 01 to 04 over `00-open`). |

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

- The opening is one shot (`00-open`): the slide, a caption, the climb card faded in over the canvas, a box
  drawn around the words, and the card building section by section as the narration names each. Its timings
  are seconds into the shot, worked out from the narration's lengths; the recorder logs where it really was.
- Headless Chrome draws no cursor: the recorder draws one (and captions, title cards, the box being dragged)
  as fixed overlays. Move the drawn one with a CSS transition and the real pointer in one step; stepping the
  real pointer makes everything run late.
- A map's places are found by their own label (`place 3 of 7 …`), via the map element's `__ol`: a vector
  source doesn't keep features in the order they were added.
- The call bar covers the bottom of the screen: frame what's pointed at in the top half.
- A narration shorter than its shot cuts the shot off: time the shot (the recorder logs key moments) and
  write the narration to cover it.

- Playwright records through its own ffmpeg build; pointing `PLAYWRIGHT_BROWSERS_PATH` at a folder with
  `ffmpeg-<rev>/ffmpeg-linux` linked to the system ffmpeg works.
- Recording a persistent profile hangs; record plain contexts that load a saved session instead.
- Headless Chrome can't draw YouTube's video once it seeks, and a page that sends work to the server
  while being screen-recorded can lock up. The shots that need those (drawing a box, pressing Stop)
  stop just short of them and show the result already made.
- Scroll the canvas by sending wheel events to it directly: a video player under the cursor swallows them.
- Hide things for the shot with CSS, never by removing them: React still owns them, and removing one
  crashes the page the next time it re-renders.
- Headless Chrome has no speech service: the call scene drives the recognizer from the script.
- The server's YouTube fetches can be refused as a bot ("Sign in to confirm you're not a bot"); a
  lecture moment needs them, so make it while they work (or give yt-dlp cookies).
