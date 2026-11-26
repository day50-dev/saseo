# "A place to think" (video 3)

The product is now Saseo (사서), said "sah soe"; the narration spells it that way for the voice. About a minute and a half (the fourth cut): the web's promise, the attention economy, the tabs it
takes to understand one subject, then Librarian named and a real call from an empty page on the
Hamiltonian demo canvas (the first card building, expand, a set of examples, a phase-space diagram),
the page filled in and opened again a week later, and the closing line.

The fourth cut's files are `lines_v4.py`, `build_v4_audio.py`, `record_v4.mjs` and `script-v4.json`;
the third cut's (`lines_v3.py`, `build_v3_audio.py`, `record_v3.mjs`, `script-v3.json`) are kept
because the fourth reuses some of its takes (copied into `v4raw`).

Run from a working folder holding `state.json` (a demo visitor's session), `canvases.json` and
Playwright's ffmpeg (`PLAYWRIGHT_BROWSERS_PATH=$PWD/pw`):

1. `node layout4.mjs`, `node prep-call4.mjs`: lay out the demo canvas and run the real call
   (`redoturn.mjs <old card> <turn>` asks one turn again). Saved as `call4.json`.
2. `python3 lines_v4.py`, then on the TTS box: Breeze for the narration (Oxford voice) and the
   questions ("you" voice), Kokoro (`af_heart`) for the librarian's answers.
   `python3 build_v4_audio.py` joins each scene's lines and builds the call's track and schedule.
3. `python3 build_first.py` (the opening: 1994 web footage, DEC's "Glimpse of the Future" from 0:43,
   its narrator for six seconds and then ours over it; the video goes in `first/src.mp4`),
   `node opshots.mjs` (Wikipedia screenshots for the opener), `node rec_op.mjs` (the promise and the
   tabs, from `op.html`), `node rec_real.mjs` then `python3 build_noise.py` (the noise: real YouTube
   Shorts, Instagram Reels and YouTube clickbait, recorded logged out and cut faster and faster),
   `node record_v4.mjs` (the canvas scenes), `node endcard.mjs`.
4. `SCRIPT=script-v4.json python3 compose.py out.mp4` (this folder's compose: a shared clip runs on
   the film's clock, so the noise can sit between the opener's scenes), then loudness to −16 LUFS.

**Clock strips.** Screen recording falls behind when the page is busy (the opener ran 4 s long over
36 s). Every page here draws its own clock as a strip of squares under the picture; `retime.py` reads
each frame's stamp and rebuilds the clip at 30 fps on the page's clock, cropping the strip off.

The narration runs 8% faster than recorded and the call's voices 5% (atempo, pitch kept).
