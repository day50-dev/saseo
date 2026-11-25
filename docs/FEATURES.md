# Features, and the tests that check them

Each feature has an ID. The tests carry the same ID in their `describe` names, so `grep -rn "F-CALL" test/` finds them.

## How the tests work

| Suite | Command | What it runs against | Time |
|---|---|---|---|
| Unit | `npm run test:unit` | Modules imported directly, with a fake model where they ask one | under a second |
| API | `npm run test:api` | The real server (`server/index.ts`) on a free port, with a throwaway data folder and a fake model | about a minute |
| Browser | `npm run test:browser` | The built client in headless Chrome, served by the real server, with a fake model | about 30 s |
| Live | `npm run test:live` | The real server and **the real model** in `data/config.json` | a few minutes; costs model calls |

`npm test` runs the unit, API and browser suites, building the client before the browser suite. None of them leave the machine. Web search is off, and the fake model answers by matching each request's system prompt.

**The fake model** (`test/helpers/fakeLlm.ts`) is an OpenAI-compatible endpoint and also stands in for the speech servers. A test tells it, for example, "when the system prompt says *You plot mathematics*, answer with this plot". It records every request, so a test can check what was asked as well as what came back.

**What the fake checks, and what the live suite checks.** Tests with the fake check what Librarian does with an answer: what it keeps, what it rejects, where the card goes, and what reaches the page. The live suite checks whether a real model's answers are good: does it ask before removing when two cards fit, and does "plot y = x³" become a plot? Run it after changing a prompt.

**Starting state** comes from `test/helpers/seed.ts`, which writes the same files the server keeps: an index of canvases, and one append-only log each.

**Browser tests** use the system Chrome at `/usr/bin/google-chrome`; set `CHROME` to use another. Headless Chrome has no speech service, so the test plays the reader's speech recogniser.

---

## F-START: bringing what stopped you

| ID | Feature | Checked by |
|---|---|---|
| F-START | A link is told apart from a typed question. YouTube links are recognised in every form (watch, youtu.be, shorts, embed, live), as are arXiv and `.pdf` links. | `unit/text` |
| F-START-1 | A screenshot is stored once by its content hash and served back. Only image types are accepted, and paths can't escape the folder. Boxing part of it makes a region and a card, and the boxed crop goes to the model as an image. | `unit/store` F-DESK-4, `api/canvas` F-START-1 |
| F-VIDEO | Moments in a lecture: clock times, and what was said around a moment (with what came after marked). | `unit/text` |
| F-PDF | arXiv abs and pdf links, and links to `.pdf` files, are recognised; arXiv ids are read in both styles. | `unit/text` |
| F-ARXIV | arXiv search is part of **+ Add**, not a button of its own. Under the box, "Search arXiv for papers" opens the search, already searching for whatever words you typed. A pasted arXiv link is just added, like any PDF. | `browser/app` |

**Not covered automatically:** reading a linked page and restructuring it section by section; fetching a video, its captions and frames (needs yt-dlp and YouTube); slicing a PDF into pages (needs poppler); searching arXiv.

## F-SHAPES and F-DESCEND: explanations as diagrams, going one level down

| ID | Feature | Checked by |
|---|---|---|
| F-SHAPES | An explanation draws as a diagram of pieces (why, what, details, how it's used), each with a **+**. | `browser/app` |
| F-COURSES | A concept is one key however it's written ("The Biot–Savart law", "biot-savart LAW"), so the course map gathers its sightings together. | `unit/text` |
| F-DESCEND | Selected words become a new card hanging from the card they're in, carrying the sentence around them. An empty selection or an unknown card is refused. | `api/canvas` |

**Not covered automatically:** the quality of explanations; the register check (strict term, idiom, casual or notation); the System One climb check and its rewrite; pointing at the page (cropped spots shown under a piece); course sightings on cards. They need real model judgment, and none of them has a live test yet.

## F-GROW: grow the diagram from any piece

| ID | Feature | Checked by |
|---|---|---|
| F-GROW | A picked shape grows from a piece, and the model is told what that piece says. Steps, parts with what they add up to, and a fork that must have two branches. What grows has its own pieces, which grow in turn, with the chain of pieces sent along. Taking a shape away takes what grew from it, and Undo restores it. A vague "more" gives more of the same kind; other words let the model pick the shape. Asking a piece for a *thing* ("can you plot the stretch?") makes that thing on its own card, hung from the piece's words. | `api/grow-goals` |

## F-ASK: ask about anything, right where it is

| ID | Feature | Checked by |
|---|---|---|
| F-ASK | A question on a card is answered there, with the card's explanation sent to the model. An empty message is refused, and so is a second one while the first is still being answered. A model failure is said on the card. In the page, Enter sends and the answer appears on the card. | `api/conversation`, `browser/app` |
| (live) | A message is routed to the right kind of answer: a plot, a graph, a map, a table, or words. | `live/judgment` |

## F-FIG: figures (tables, plots, graphs)

| ID | Feature | Checked by |
|---|---|---|
| F-FIG | Asking a card for a figure makes it on its own card beside the card, linked from the conversation. Asking the figure card for a change redoes it in place, with the previous figure sent to the model. The earlier one can be brought back, and swapped again. A question about what the card holds is answered in words, not redone. A figure that can't be made says why on its card. | `api/conversation` |
| F-FIG-1 | **Tables:** cells are read as numbers where they hold one; years stay years. A table is charted as a line over numbers and as bars over names. Rows are trimmed to the columns. A table not read off any page is flagged as from the model's memory. In the page, rows and sources are listed, **Chart it** charts it, and **Copy as CSV** copies it. | `unit/figureMath`, `unit/figures`, `browser/app` |
| F-FIG-2 | **Plots:** the model's math is parsed, never run, including implicit multiplication, `sin^2(x)`, `x!`, a curve in t, and θ. Anything else is refused, including names on `Object.prototype`. Ticks fall on round numbers, and curves break at asymptotes. Series that can't be read are dropped, backwards ranges are ignored, and marks need numbers. In the page, curves draw, marks are labelled, and values show under the cursor. | `unit/expr`, `unit/figureMath`, `unit/figures`, `browser/app` |
| F-FIG-3 | **Graphs:** a hierarchy is drawn in layers, parents above children. A cycle or an undirected graph uses springs instead, laid out the same way every time, inside the box, with nodes kept apart. The model's own drawing is used only when every node has a place. Duplicate nodes and edges to nowhere are dropped. In the page, nodes can be dragged and **Reset layout** puts them back. | `unit/figureMath`, `unit/figures`, `browser/app` |

## F-MAP: maps

| ID | Feature | Checked by |
|---|---|---|
| F-MAP | Places come from the geocoder, which is told who is asking. A hit more than 600 km from the model's guess, or no hit at all, falls back to the guess, flagged as approximate. Places with neither go under "Couldn't find", as do areas with no outline. A route keeps its order. In the page, places are listed in order, the roughly placed one says so, and clicking a place goes to it. | `unit/figures` (geocoder stubbed), `browser/app` |

## F-CALL: calling the librarian

| ID | Feature | Checked by |
|---|---|---|
| F-CALL | Noise gets no answer and costs nothing. A number on its own ("two", "the second one") picks a numbered thing. | `unit/text`, `api/conversation` |
| F-CALL-1 | The glance is small: what they point at (a piece, a selection with its sentence, a part of a figure in the figure's own terms, or nothing), the last eight turns, what they said, and the reader's notes. The rest of the canvas is left out. | `unit/call` |
| F-CALL-2 | "This" and "that" mean what the pointer was on as each word was said, so "compare this … with that" names two things in order. | `unit/call` |
| F-CALL-3 | Look-ups happen only when the model asks for them, at most two rounds: `cards` (with which are on screen and which is pointed at), `card` (its pieces by key), `recent`, and `goals`. | `unit/call` |
| F-CALL-4 | What it does on the canvas: grow the piece pointed at (an unknown shape becomes an aside); open a card on the selection or a phrase; find something beside what's pointed at, about that piece (or beside the newest card); remove only cards that exist (a made-up id is admitted to aloud). At most three actions per turn. Plain words are spoken; junk is not. Over HTTP: removing hides cards and showing undoes it, finding puts a card beside the pointed card, and a failed turn is said briefly. | `unit/call`, `api/conversation` |
| F-CALL-5 | When more than one thing fits, it numbers them on screen and asks, removing nothing. Only cards that exist are numbered, at most five. Marks still showing are in the next glance. A pick is given as the answer to its question, and the picked card is labelled. In the page, numbered badges and call-bar chips appear, clicking one removes that card, and the numbers go. | `unit/call`, `browser/app` |
| F-CALL-6 | A card opened from a call goes to the right of its card, below anything already there. | `unit/call` |
| F-CALL-7 | **Typing into a call.** The call has a small box for a link or a passage. Enter shows it in the call as `[text 1: …]`, marked "the librarian will see this the next time you speak". Nothing is sent until you talk; then every typed text goes with your words, numbered, with the new ones flagged. You can refer to one as "the link", "what I sent" or "text 2". Asking to "open it as a new card" puts it on the canvas as **+ Add** would: a page is read, a YouTube link plays, a PDF becomes its pages, and words are explained. It goes beside what you're pointing at (otherwise to the right of everything), and the canvas moves to show it. | `api/notes`, `browser/app` |
| F-CALL-8 | **What you say, as you say it, and a pause you set.** Your words show in the call as you speak, wrapping and growing, with the part still being recognized in grey. Nothing is sent until you've paused for the chosen time. A bar beside Mute shrinks to nothing over that pause; talking again stops it, and what you add joins the same turn. Use − and + to change the pause, from 0.5 to 10 seconds (it's remembered); a longer one leaves room to think mid-question. Clicking the bar while it runs sends at once. Without the browser's own recognizer, the pause is how long a silence ends what you said. | `browser/app` (browser recognizer only) |
| F-CALL-9 | **Connecting two things from a call.** "Connect these two cards" (or link, relate, compare) makes the same relation card as dragging between two cards' edge circles. It hangs from both with a Y connector, explains how they're related, goes below and between them, and comes into view. The librarian uses the ids it was given, or else what you pointed at as you said "this" and "that". | `api/notes` |
| (live) | A real model answers a pointed question directly with no look-ups. It numbers and asks for "get rid of the graph" with two graphs, and for "take the chart off" with a plot and a table. A pick removes the one picked. | `live/judgment` |

**Not covered automatically:** a real microphone and speech recognition; talking over the librarian; mute.

## F-SPEECH: the server's voice and ears

| ID | Feature | Checked by |
|---|---|---|
| F-SPEECH | `/api/me` says whether the server has a voice and ears. Words become speech (wav). Speech becomes words, primed with the canvas's subjects. What a recogniser invents from room noise ("Thank you.", "[Music]") is dropped. | `api/conversation` |

## F-RELATE: how two things are related

| ID | Feature | Checked by |
|---|---|---|
| F-RELATE | A relation card between two cards (or images) depends on both: removing either one removes it. A card can't be related to itself. | `api/canvas` |

## F-DESK: the desk stays put

| ID | Feature | Checked by |
|---|---|---|
| F-DESK-1 | Canvases can be named, renamed, trashed and restored, duplicated with everything on them, and deleted for good, each at a stable `/c/<id>`. An untitled canvas is named after what it was started with, once; a name someone chose is never replaced. An unknown canvas is "not found" on every route. Reader notes keep the last twelve. | `unit/store`, `api/canvas` |
| F-DESK-2 | Nothing is lost. Every change is a numbered line in the log, and replaying the log after a restart gives the same state. Removing hides and showing brings it back; collapse and restack work too. Work in progress is shown but never written. Concurrent edits don't overwrite each other. A card left mid-flight by a restart is marked failed, and an interrupted chat says so. In the page, × removes a card, Ctrl+Z brings it back, and Ctrl+Shift+Z removes it again. | `unit/store`, `api/canvas`, `browser/app` |
| F-DESK-3 | Nothing moves unless you move it. What goes with what: an image takes its boxes, a box its cards, a card the cards below it, and a relation goes with either side. Removing the only card on a box removes the box too. An explanation can sit on any side of what it explains, but not on it. Moves are checked and rounded, and only cards change width, within limits. | `unit/store`, `api/canvas` |
| F-PHONE | A canvas opens at phone width without the page scrolling sideways. | `browser/app` |

**Not covered automatically:** Untangle; pinch-to-zoom and panning; the pointer at the screen's edge for work out of view.

## F-GOALS: goals (experimental)

| ID | Feature | Checked by |
|---|---|---|
| F-GOALS | A card the librarian makes is placed under a goal. You can add your own goals, with subgoals. Rewording a goal keeps what it was, and a goal can be marked done. A goal never goes under itself or one of its own. A card works toward one goal at a time: giving it to another moves it. Undo puts a goal back exactly as it was. | `api/grow-goals` |

## F-RETRY: failed work tries again by itself

| ID | Feature | Checked by |
|---|---|---|
| F-RETRY | A card that fails tries again by itself, waiting longer each time (2, 4, 8, 16, then 32 seconds), up to 5 tries. The card counts down to the next try ("Trying again in 6 s, try 2 of 5"). After the last, it says so and waits for **↻ Retry**, which tries at once and gives back all 5 tries. A card a server restart interrupted starts over by itself within a second, and a card waiting for your answer to its question just keeps waiting. Tries that were due when the server stopped are picked up again when it starts. A box on a slide is retried by the page, which draws its crop. | `api/retry` |

## F-NOTES: notes, from you or the librarian

| ID | Feature | Checked by |
|---|---|---|
| F-NOTES-1 | **Leaving a note.** Press N, or use ✎ Note in the toolbar. With a card or image selected, the note is about it: it lands beside it, below any earlier notes there, joined to it by a dotted line. With nothing selected, it's a loose note in the middle of the screen. Ctrl+Enter or clicking away saves it, and Escape drops an empty one. Undo takes a note away. | `api/notes`, `browser/app` |
| F-NOTES-2 | **What a note keeps.** Its words as written (line breaks kept), who left it (you or the librarian), when, and where from: the canvas, a call, or a card's conversation. It also keeps what had just been said, and what it's about: a card, a piece of one, and the words there. A note on a box goes on the image. | `api/notes` |
| F-NOTES-3 | **History.** A note can just sit there, or you can look into it. History shows how it came to be, then its earlier wordings, each with who wrote it and when. "Before it" is what happened on the canvas up to the moment it was left. "Since" is what has happened to the note, and to what it's about, after that. Double-click or Edit rewords it, and the earlier wording is kept. | `api/notes`, `browser/app` |
| F-NOTES-4 | **Notes the librarian leaves.** On a call it can leave a note: when you ask it to note or remember something, or when something is worth keeping for later. The note goes beside what you're pointing at, or is loose if you're pointing at nothing. Asking a card's conversation to note something, or growing a piece with "note this", leaves a note beside the card instead of an answer. | `api/notes` |
| F-NOTES-6 | **The librarian reads notes on a call.** Pointing at a note, or selecting words in one, tells it what the note says. Its look-ups list notes with the cards and read one by id, so "what did I write about the book?" works too. It's told never to claim to see what it wasn't shown. | `api/notes`, `browser/app` |
| F-NOTES-5 | **A note goes with what it's about.** Dragging the thing moves its notes too; removing it removes them, and bringing it back brings them back. A note can also be moved on its own. | `api/notes` |

**Not covered automatically:** whether a real model chooses to leave a note when it should (and only then); growing a piece with "note this" (it goes through the same decision as a card's conversation, but no test drives it).

## F-SETTINGS and F-HOST: your models; hosting it for others

| ID | Feature | Checked by |
|---|---|---|
| F-SETTINGS | Keys never reach the browser; it only sees whether a key is set, and a hint of it. Models are listed from the endpoint, and the endpoint can be tested. Changing a setting keeps the key unless a new one is given. The model client strips `<think>` sections, streams (or falls back when the server doesn't), suggests `/v1` on a 404, pulls JSON out of prose and code fences, asks once more when the JSON is malformed (saying why), and doubles LaTeX backslashes the model forgot to. | `api/canvas`, `unit/llm`, `unit/text` |
| F-HOST | With accounts on: nobody signed in is asked to sign in. A visitor can use it straight away and keeps what they made when they sign up. Each person sees only their own canvases, on every route. Only admins see or change the models and searchers. Sign-ups can be limited to a list. Signing in again finds the same canvases. | `api/accounts` |
| F-DIAGRAM | Diagrams a model drew are cleaned before they're kept. Scripts, event handlers, outside links, embedded HTML and `url()` styles are removed. A diagram still being written draws what's finished. Its title and caption come from the drawing itself. | `unit/text` |

**Not covered automatically:** GitHub and Google sign-in; finding videos, reading, papers and notebooks (they need web search); running a notebook in the browser (Pyodide).
