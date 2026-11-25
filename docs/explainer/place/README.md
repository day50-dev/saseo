# "A place to think" (video 3)

About two minutes: the web's promise, the attention economy that buried it, what exploring a hard
subject actually takes, then a real call on the Hamiltonian demo canvas (expand, a set of examples, a
phase-space diagram), the space itself (connections, notes, a lecture, goals, coming back), and a
zoom out over everything.

Run from a working folder holding `state.json` (a demo visitor's session), `canvases.json` and
Playwright's ffmpeg (`PLAYWRIGHT_BROWSERS_PATH=$PWD/pw`):

1. `node layout4.mjs`, `node prep-call4.mjs`: lay out the demo canvas and run the real call
   (`redoturn.mjs <old card> <turn>` asks one turn again). Saved as `call4.json`.
2. `python3 lines_v3.py`, then on the TTS box: Breeze for the narration (Oxford voice) and the
   questions ("you" voice), Kokoro (`af_heart`) for the librarian's answers.
   `python3 build_v3_audio.py` joins each scene's lines and builds the call's track and schedule.
3. `node opshots.mjs` (Wikipedia screenshots for the opener), `node rec_op.mjs` (the opener, from
   `op.html`), `node record_v3.mjs` (the canvas scenes), `node endcard.mjs`.
4. `SCRIPT=script-v3.json python3 ../compose.py out.mp4`, then loudness to −16 LUFS.

**Clock strips.** Screen recording falls behind when the page is busy (the opener ran 4 s long over
36 s). Every page here draws its own clock as a strip of squares under the picture; `retime.py` reads
each frame's stamp and rebuilds the clip at 30 fps on the page's clock, cropping the strip off.

The opener is original: generic feeds, reels, thumbnails and pop-ups, no real app's look or logo.
