# Brainstorm

Ideas still being worked out. Each topic says what problem it's for, what we know, the options, and
what's still open. When a topic settles, its decision moves into [DESIGN.md](DESIGN.md) and its notes
here shrink to a pointer.

A standing note on scope: this is an experiment, not a product. Don't spend effort on quotas, rate
limits, abuse protection or terms-of-service caution unless something is actually on fire.

Topics:

- [Video lectures: the side quest and the way back](#video-lectures-the-side-quest-and-the-way-back)

---

## Video lectures: the side quest and the way back

*Status: open. Started 2026-11-21.*

### The moment

Someone is watching a lecture (say, on higher-dimensional orientable surfaces). Something goes by
and they think: wait, what is that? They need to stop the video, take a side quest to find out, and
come back. Today that is a pain, and it's squarely what the librarian is for.

### Why it's hard now, and why it's ours

- **What stopped you is spread across three things**: a frame (what's on the board), a span of speech
  (what the lecturer said while writing it), and a moment in time. A screenshot alone loses the
  sentence; "then we glue along the boundary" is meaningless without the picture, and the picture is
  half-meaningless without the sentence.
- **A video doesn't wait.** A paper sits where you left it. A video forces you to pause, remember the
  timestamp, search for jargon you can only spell by ear, get lost three levels deep, then scrub back
  and rewind two minutes to recover the thread. The way back is half the pain.
- That is principles 2 and 3 failing together: no stable place to return to, and no record of the
  detour.
- **Speech is heavy on register (principle 9).** "This guy", "morally", "glue these up", "it's
  basically a donut with handles": casual words standing in for strict terms, which a transcript lets
  the librarian flag.

### What it could look like

- The video is a placed object on the canvas (principle 4), playing inline.
- At the moment something stops you: pause (or a key), and a **moment card** lands, pinned to that
  timestamp, holding the frame and the transcript around it (say ±30 s).
- Box part of the frame, or select words in the transcript, and descend as usual.
- The moment card is also the **bookmark**: clicking it resumes the video there, with the detour
  sitting beside it.
- A lecture watched this way leaves a trail of timestamped cards: a map of the lecture made of the
  places where it lost you. Time becomes one axis of the graph.
- Possibly: the lecture's transcript restructured into shapes, like a linked page, with each piece
  anchored to a time range instead of a paragraph.

### Pieces and options

**1. Timestamped transcript (ASR)**

- YouTube captions, both human and auto-generated, come with timestamps and can be fetched for free
  (the timedtext endpoint, or yt-dlp `--write-auto-subs`). Auto-captions are rough on math words.
- No captions, or bad ones: run Whisper (or a faster variant such as faster-whisper or
  whisper.cpp) on the audio. That needs the audio (yt-dlp) and compute; word-level timestamps are
  available.
- Maybe: let the language model correct the transcript using the lecture's topic ("Morse" heard as
  "more"), keeping the timestamps.

**2. Playing and pausing**

- The YouTube IFrame Player API embeds the player and gives play, pause, seek and the current time.
  That's enough for moment cards and bookmarks.
- Other hosts (Vimeo, university lecture sites, a local file): later, case by case.

**3. Frames**

- The catch: the browser can't read pixels out of an embedded YouTube player (it's cross-origin).
- Options:
  - The server fetches the video (yt-dlp) and cuts the frame at the timestamp (ffmpeg). Sharpest,
    and it works on any frame. The cost is downloading the video; caching it once per lecture is
    fine.
  - YouTube's storyboard thumbnails: no download, but too small to read a board.
  - The user shares their screen or tab (`getDisplayMedia`) and we grab the frame: works for any
    site, but needs a permission prompt each session.
  - Play the downloaded file ourselves in a `<video>` element (same-origin), so the browser can grab
    frames directly, and skip the YouTube embed entirely.
- Leaning: server-side yt-dlp + ffmpeg, since the download is also the source of the audio for ASR.

**4. What the librarian gets**

- The frame (as an image, like a slide), the transcript window, the lecture's title and description,
  and the trail so far.
- Maybe the slides or notes, when the lecture links to them, as a better source than frames.

### Open questions

- Pause-then-capture, or one key that does both?
- How wide a transcript window: fixed ±30 s, or cut at sentence or topic boundaries?
- Should the whole transcript be read up front (so the librarian knows what's coming), or only up
  to the moment (so it doesn't spoil, and answers from what's been said so far)?
- Where does the video sit on the canvas while you're off on a side quest, so the way back is one
  click and nothing moves (principle 2)?
- Frames from a talk with slides versus a blackboard lecture: the same pipeline, or different?
