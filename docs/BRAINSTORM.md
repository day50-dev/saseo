# Brainstorm

Ideas still being worked out. Each topic says what problem it's for, what we know, the options, and
what's still open. When a topic settles, its decision moves into [DESIGN.md](DESIGN.md) and its notes
here shrink to a pointer.

A standing note on scope: this is an experiment, not a product. Don't spend effort on quotas, rate
limits, abuse protection or terms-of-service caution unless something is actually on fire.

Topics:

- [Video lectures: the side quest and the way back](#video-lectures-the-side-quest-and-the-way-back)
- [Course level: noticing when an explanation reaches ahead](#course-level-noticing-when-an-explanation-reaches-ahead)

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

---

## Course level: noticing when an explanation reaches ahead

*Status: step 1 built (2026-11-22): sightings are gathered and shown. The "reaches ahead" flag is next.*

### What's built (step 1)

- After each explanation is written (and each linked page is shaped), `mapCourses` in
  `server/explain.ts` runs one more search aimed at course material ("X syllabus lecture notes"),
  adds those hits to the sources already found, and has the model classify which are course pages:
  institution, code as written, title, level band, and whether the course introduces or assumes the
  concept (`server/curriculum.ts`).
- Sightings go to `data/curriculum.jsonl`, shared by every canvas on the server, keyed by a
  normalized concept name. `GET /api/curriculum` returns the whole map so far.
- Cards show **Taught in** and **Assumed known in** as course chips (one per course, each linking to
  where it was seen) with the usual level. Cards written before this get looked up when their canvas
  opens.
- Early results: the Biot-Savart law was found at Muhlenberg (Physics 122), Oxford, Houston (ECE 3318)
  and Purdue (ECE 604, graduate); the Hardy-Littlewood-Sobolev inequality at MIT 18.S997, UCSD 240C and
  Rutgers 640:521 (graduate), and assumed known in UCLA 247a.

Next: look up the explanation's own terms (`sem.terms`) in the map and flag the ones whose usual
level is later than the subject's ("reaches ahead"), and feed that to the climb check.

### The problem

Spanish I words shouldn't be defined in Spanish II language. In maths: if a topic is taught in
Berkeley's Math 44A, and its explanation leans on ideas that first appear in Math 44D, the
explanation has reached ahead of where the reader probably is. That isn't always wrong (the order
of teaching isn't sacred, and sometimes the later idea is the clearest way in), but it should be
**noticed**, so the librarian can choose to pivot rather than do it by accident.

This is principle 1 (descend, never climb) with evidence behind it. Today the System One check asks
a model "does this climb?" and gets a hunch. Course data would let it say *why*: "this uses
*eigenvector*, which is usually taught a term after *linear map*".

### Where the evidence comes from

- **What we already fetch.** Every search returns pages, and many of them are course pages: lecture
  notes, syllabi, problem sets, slides (`math.berkeley.edu/~…/44A/`, MIT OCW 18.06, a Stanford
  201C handout). Each is a free sighting: *concept X appears in course Y*.
- **What people feed in.** Slides and papers dropped on canvases often say which course they're
  from (a title slide, a footer, the URL of the PDF).
- **Asking on purpose (later).** A "where is this taught?" search on the subject ("X syllabus
  lecture notes") when nothing is known yet.
- It fills in opportunistically: every explanation adds sightings, and the map gets better the
  more Librarian is used.

### What gets stored

A store shared across canvases (not per canvas), something like:

- **Course**: institution, code as written ("MATH 44A", "18.06", "201C"), title, URL, level hints
  (lower or upper division, graduate), listed prerequisites. Kept as found; no attempt to force one
  naming scheme.
- **Sighting**: concept, course, where it was seen (URL, a short quote), when. Whether the course
  *introduces* the concept or *uses* it already is the key distinction, and the quote is what
  tells them apart.
- **Order**: within one institution, which course comes before which (from prerequisites, or from
  the sequence itself: 44A, 44B, 44C, 44D).

### Lining institutions up

There's no shared schema for course names, so courses are lined up by content, not name:

- Within an institution, order comes from prerequisites and numbering.
- Across institutions, two courses are the same *stage* when they teach the same concepts with the
  same prerequisites, whatever they're called. Berkeley 44A ≈ Stanford 201C is a judgement made
  from their topic lists (a model can make it; embeddings can help).
- Out of that comes a rough global band for each concept (intro undergraduate, upper undergraduate,
  graduate, research), plus the specific courses as evidence. It's one-to-many: a concept has many
  sightings, and they may disagree.

### What the reader sees

- On a card, quietly: **Usually taught in** Berkeley Math 44A · MIT 18.06 (about 2nd-year
  undergraduate), each linking to where it was seen.
- When the explanation's own terms come from a later stage than its subject, a flag: **Reaches
  ahead**, with a list like "*eigenvector* (usually Math 44D, after this)". The librarian can then
  rewrite it from the earlier stage, or keep it and say why ("this is easiest to see with
  eigenvectors; here is the one idea you need").
- Never a block: a flag is information.

### How it fits what exists

- The explanation already lists its own terms of art (`sem.terms`) and stand-ins; those are what
  get looked up.
- The climb check can take the flags as input, and the rewrite prompt can name the later terms to
  avoid.
- Sightings can be gathered in the search step that already runs for every card, classified
  cheaply ("is this a course page? which institution, course and level?").

### Open questions

- Introduces versus uses: how reliably can a model tell from a syllabus line or a page of notes?
- How many sightings before a concept's level is trusted, and what to show before that?
- Sightings that disagree (taught early at one school, late at another): show the spread, or the
  earliest?
- Does the map belong to one Librarian server, or should it be shareable (an open dataset that
  grows across instances)?
- Beyond maths: the same idea works for any sequenced subject (languages, physics, chemistry), but
  course codes are maths-heavy evidence. What plays that role elsewhere?

