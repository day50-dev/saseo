# The Librarian: a medium for deep self-directed learning

## The problem

The web is built for brief, shallow reading, so deep self-directed study of graduate-level material has no good medium. Browsers, articles, course platforms and chat all reward the skim: open a tab, read a paragraph, click away, lose the thread.

**The jargon loop.** Ask what a specialist term means and the answer uses more specialized terms, each defined by still more arcane ones. It is like sitting in Spanish I, asking what a word means, and being answered in Spanish II, then III, then IV, until you hold a useless pile of words you don't know. Where the loop starts differs for everyone, but defining the general through the more specialized is always the wrong direction.

**No onramp.** Textbooks go bottom-up and are years away from the thing you are curious about. Papers, talks and Wikipedia go top-down and climb. Wikipedia mathematics is the clearest case: a Spanish–Spanish dictionary when most readers need Spanish–English.

**Shallow plateaus.** Brilliant and Duolingo solved engagement but run it over a fixed, shallow curriculum, so learners plateau at level 1 or 2. The common defense, "do I need to explain negative numbers to you?", is a false choice: the ask was never to explain everything, only to stop explaining down-the-hall concepts with across-town ones.

## Thesis: a research librarian with unlimited time

The goal is a medium where deep exploration of hard material, such as Sobolev inequalities, holds attention the way a feed does. That means sustained flow (in Csikszentmihalyi's sense) with a short, rewarding loop, pointed at depth instead of a feed. The model is research with a very good librarian who has the time to work with you.

> A research librarian with unlimited time, on an infinite desk that never gets rearranged.

| Librarian | In the app |
| --- | --- |
| The reference interview: works out what you actually need from what you walked in with | Drop an image, point at the part that stopped you |
| Knows the collection and fetches; doesn't author | Go fish: find lectures, notes and books before generating anything |
| Matches material to you: the primer, not the monograph | Explanations descend toward your floor |
| The stacks don't move | Fixed geography on the canvas |
| Follows your detours without losing the thread | Branching history |
| Never grades you | Personal enrichment only |
| Has time | Software can supply what real librarians lack |

The AI's role is librarian, not lecturer or tutor. It works out what you're after, brings and annotates material, offers to quiz you, then steps back. You set the direction.

### The library is the spatial model

The library is the place where self-directed deep study already succeeds, and it is a large physical space: floors, rooms, long hallways, shelves, reading desks, copy machines. That is why space matters here. Regions of the canvas are rooms, subjects are shelved near related subjects, your work area is a reading desk, and excerpts you take are photocopies that keep their citation. You find things again by where they are.

## Use case

A person meets something beyond them, drops it onto the canvas, and follows a path down from exactly the part that stopped them.

1. **Drop.** "This math is beyond me." They drag or paste a PNG, JPG or WebP (a slide, a screenshot, a page) onto the canvas.
2. **Select.** They drag a rectangle over the part that stopped them. No math OCR is needed: a vision model reads the region.
3. **Go fish.** The librarian searches the enabled searchers for introductory material on the general idea, before writing anything.
4. **Ground it.** The answer starts with *why* the thing exists, so it reads as an answer to a real question rather than arbitrary furniture labelled "the Acme-Bugs-Bunny method". Then *what*, its *parts*, how it's used *here*, and what the name means, citing what was found.
5. **Keep going.** Any words in the explanation can be selected in turn. Every step moves toward what the learner knows, and everything stays where it was put.

Later: the system identifies where the image came from (a slide title and theorem text leading to an arXiv paper) and uses it as the authority, and says when it couldn't.

## Principles

Nine principles define the medium. Each one is also a condition for flow: right difficulty, clear small goals, instant feedback, visible progress, and no lost context.

### 1. Explanations descend

Every explanation moves toward what this learner already knows and never climbs into more specialized jargon. The floor is personal and never measured up front: people keep clicking until they don't need to, and where they stop is the floor. Nobody is taught negative numbers. A new term may appear only if it is more general or already known, so the regress always terminates. This is challenge just above skill.

The same applies to sources: a search for "electric field" that includes the page's topic finds the specialist paper again, which is a climb through the sources. Descent searches look for the plain concept.

### 2. The geography doesn't move

Position is part of an item's identity. Expanding grows outward into empty space and never reflows what is already placed. Layout is deterministic: no physics simulation, no jiggling mind-map nodes, nothing like notes that have been riffle-shuffled. You navigate by pan and zoom; the map stays put, like the stacks.

The system never moves anything. The learner may: dragging a container brings everything hanging off it, so relationships keep their shape, within the semantic rule that an explanation stays to the right of what it explains.

### 3. History branches

Undo and redo never destroy anything. Going back to b in a→b→c→d→e and changing something forks, so c, d and e remain reachable. In learning this preserves explanation attempts that didn't land, so they can be compared or revisited later. Removal is a *hide* event; nothing is deleted.

### 4. Tools are placed objects

LLMs, decision models (such as [Jev](https://www.sanity.io/glossary/jev-typesafe-ai-model)), graphs and embedding spaces are invoked at a location and take their context from where they sit. "Make me a short quiz on the Ampère tension field" at that node gets that subtree, the slide and the learner's floor. Results stay where they were made, so there is no 500k-token conversation to scroll back through.

### 5. Semantics are separate from presentation

The map stores what things mean, and a stylesheet decides how they look: `class=important`, never `class=bright-red`. This is WYSIWYM, as in LyX, notebooks or early HTML. Node kinds (goal, definition, claim, step, aside, example) and relations (decomposes-into, defines, therefore, because, depends-on, joins, explains-in-terms-of) are stored; colours, arrows and line weights are a theme. The shape vocabulary is called **semshapes** for now. Position is the exception: it is semantic, so themes never move anything.

### 6. Sources are chosen, and you find before you generate

Sources are selected, not scraped. For the Linux kernel the authorities are the code, git history and LKML, not Reddit. A source set is simply an allowlist of domains (khanacademy.org, arxiv.org, a course site), toggled per topic. Sources are judged on two axes: *authority* (correct and primary) and *direction* (explains downward). Facts come from authorities; phrasing comes from onramp material. The system goes fishing for human-made explainers first and generates only to fill gaps, with provenance on every claim.

### 7. Restructure, don't summarize

Breaking text into the canvas is a change of notation, not a dilution. The words stay as nodes, and the relationships hidden in connectives ("by", "for", "therefore", "taking") become edges and positions. A test: regenerate prose from the canvas and every claim, condition and connective must survive. Explanations are added beside the restructured source and never replace it.

### 8. Personal enrichment only

No grades, rankings, leagues or credentials. Understanding is checked by masked self-tests, a human version of a train/test split: hide a node or edge of material the learner hasn't been shown and ask "what goes here?", with hints that descend until they reach it. The point is to separate "I think I get it" from getting it, never to compare people.

### 9. Mark the register

Mathematical writing code-switches without warning between strict terms of art and casual description, and to an outsider both are just English words. It is like a fan convention where someone quotes a line from season 4, episode 5: insiders laugh, and you are left asking what show this is. The insider decodes the register without thinking; the outsider gets no signal at all. That is a barrier separate from the jargon loop: searching "worst term" goes nowhere, and treating "energy space" as casual gets a vague answer to a question that has an exact one.

| On the slide | Register | What an insider hears |
| --- | --- | --- |
| "energy space", "well-posed", "Coulomb gauge", "log-Lipschitz" | Term of art | A strict definition exists, and every word of it matters |
| "tension field" | Term of art, borrowed | Imported from harmonic maps; "tension" isn't loose here |
| "+ better" | Casual | "plus terms that are easier to control, which I'm not writing out" |
| "the worst term", "rougher" | Casual, pointing at something precise | "the hardest term to bound", "less regular" |
| "closes the bootstrap" | Idiom | A standard move with a precise meaning that's rarely written down |
| "≲" and ":=" in quotes | Notation, deliberately loosened | "morally this, up to details I'm skipping" |

So the register is classified and shown everywhere:

- **Selected words are classified before they are explained**, a typed choice made by the System One model when one is configured. A term of art gets its actual definition, reached by descending, and the card says it has a strict definition. Casual language gets "this is informal; the speaker means …" and the precise thing it points at. Loosened notation gets what the quotes are hiding.
- **Explanations mark their own words.** Terms of art carry a distinct style (a dotted underline), and the everyday stand-ins an explanation uses ("an invisible push") are marked with the real term they stand in for.
- **Boxing part of a page lists its terms by register**, so the first card says which words are strict and which are informal.

### Explanation facets and their semshapes

Every explanation is stored as structure (`Sem` in `shared/canvas.ts`), not prose, and each facet maps to a shape:

| Facet | Meaning | Semshape |
| --- | --- | --- |
| Why it exists | The question it answers, as a chain of steps | Path: a story arrow into the first step, bended arrows to each next |
| What it is | A gist and a few details | Category with Descriptions: the 45° description bend, a bus, an arrow to each line |
| Its parts | A formula's pieces, in its own order, and what they add up to | Horizontal category bus into each part, then a Y-connector into the connecting idea |
| How it's used here | Its role on this page | Path |
| The name | What the words mean | Aside |

*Why* comes first and is never omitted. The 2013 shape grammar is the v1 stylesheet; the plan is to move away from it quickly.

## Worked examples: the Chern-Simons-Schrödinger talk

The development fixture is Jason Zhao's (Berkeley) research talk, "The Cauchy problem for Manton's Chern-Simons-Schrödinger equation" ([arXiv:2609.13096](https://arxiv.org/html/2609.13096)). It was attended over Zoom, streamed by Terence Tao from a small room at UCLA. Perhaps a thousand people could follow it live. If an outsider can be drawn into it, the idea is proven.

### Slide 8: "What's the Ampère tension field?"

The usual answer climbs: "the residual of the Maxwell–Ampère constraint, defined via the curvature of the U(1) connection and the gauge-covariant current." That's six new terms. A descending answer segments the formula into its parts:

```latex
\boxed{\mathrm{AMP}} := \underbrace{F_{tj}}_{\text{1}} + \varepsilon_{jk}\Big(\underbrace{\mathrm{Im}(\bar\phi\,\mathbf{D}^k\phi)}_{\text{2}} + \underbrace{\partial^\ell F_\ell{}^k}_{\text{3}}\Big)
```

- **The box:** they took the second equation, "stuff = 0", and named the left side. AMP is how far you are from solving it; zero means solved. "Tension" is the pull back toward a solution.
- **1** is the electric field: how the potential changes over time.
- **2** is the current: where the charge of φ is flowing.
- **3** is how the magnetic field swirls in space. ε rotates a 2-D arrow by 90°.
- **Together:** current and swirling magnetism must balance the electric field, which is Ampère's law from intro physics with a twist.
- **Why the talk cares:** the proof never solves the equations directly. It tracks these error terms, starts them at zero, and shows they stay small.

### Slide 20: "What's a linear paradifferential equation?"

- **Why:** CSS is nonlinear: the unknown φ shapes its own coefficients, since **D** contains A, which depends on φ. Standard tools fail on nonlinear equations, and the nonlinear part isn't small enough to ignore.
- **What:** split the solution into a slow, coarse part and fast, fine detail. Freeze the coarse part as known background, like a gently curving road, and study the fine detail against it, like small corrections at the steering wheel. With the background frozen, the equation is linear in the detail.
- **How, here:** given a solution (A, φ), the new unknown u solves (i**D**ₜ + **D**ʲ**D**ⱼ)u = N with the known A inside **D**. The speaker proves an energy estimate (how frequency content moves) and a Strichartz estimate (how waves spread and smooth), which feed the bootstrap on slide 23.
- **The name:** "para" means beside. Paradifferential calculus (Bony, 1981) splits a product into coarse × fine pieces, so the name says how the problem is split.

### Slide 23: restructuring the bootstrap

The slide is a dense paragraph, but its real structure is a goal, a split, two independent branches and a join. Every word survives; the connectives become edges.

```
          Goal: show ‖φ‖ in L²L∞ is ≤ ε
                       │  by the fundamental theorem of calculus
                       ▼
     φ = low-frequency part − high-frequency part
                       │
         ┌─────────────┴──────────────┐
         ▼                            ▼
 Low-frequency part           High-frequency part
 φ at heat-time s̲             ∫ (sD⁽²⁾)φ ds/s
         │ Sobolev +                  │ Strichartz
         │ parabolic smoothing        │
         ▼                            ▼
     ≲ T^(1/2)            ≲ T^(1/4) · s^(1/2 − 1/4 − 1/8)
         └─────────────┬──────────────┘
                       │  taking T ≪ 1
                       ▼
              Closes the bootstrap
```

## Neighbours and prior art

A scan in November 2026 found nothing that combines these pieces for graduate-level material. Partial matches exist for each piece. Most entries are vendor pages or preprints, and their claims are unverified.

| Neighbour | What it gets right | What it lacks |
| --- | --- | --- |
| [Knowledge Canvas](https://github.com/LaplaceYoung/knowledge-canvas) (open source) | Local-first learning workspace on an infinite canvas, with branching chat and PDF OCR | No descent rule, source allowlists or fixed geography, as far as described |
| [CanvasConvo](https://arxiv.org/html/2605.15848v1) (research, 2026) | Lays out an LLM conversation as a tree on a canvas; users found earlier states easier to revisit | General chat, not learning; reports impressions, not learning gains |
| [Llmcanvas](https://9bests.com/blog/llmcanvas/), Canvas Chat | Branching chat on an infinite canvas | General-purpose chat; no sourcing |
| [SnapIQ](https://chromewebstore.google.com/detail/snapiq-ai-screen-capture/goiakbnglnlkbbbgedniblbblpbjdiad), [MathPad](https://mathpad.ai/features), [Math AI](https://math.photos/math-screenshot-solver) | Drag a rectangle over a screenshot and get an explanation | Homework solvers: answers, not understanding; nothing persists |
| [Explainpaper](https://www.explainpaper.com/), NotebookLM, LLM tutors | Highlight text in a paper and get a plain or grounded explanation | Not tailored to the reader; chat-shaped; nothing prevents climbing |
| ScholarPhi / Semantic Reader | Hover a symbol in a paper to see its definition | Shows the paper's own definition, which often climbs |
| Paper Plain, [Reading.help](https://arxiv.org/pdf/2505.14031) (research) | Plain-language reading aids; Reading.help detects what a reader doesn't know | Medical papers and English grammar, not mathematics |
| [Aibrary](https://finance.yahoo.com/news/aibrary-launches-worlds-first-ai-050200676.html), [Morso](https://www.morso.app/blog/best-ai-study-app-for-self-learners), [Gauth](https://finance.yahoo.com/technology/ai/articles/one-learning-platform-gauth-launches-143000977.html) | An AI "librarian" or generated courses for self-learners | Personal-growth or K-12 level; fixed courses |
| Brilliant, Duolingo | The engagement loop | Fixed shallow curricula; learners plateau at level 1–2 |
| Khan Academy, 3Blue1Brown | Material that points downward | A library you visit, not a medium that comes to your problem |
| Explorable explanations, Distill.pub, Quantum Country | New media for deep understanding | Handcrafted, so they don't scale to arbitrary material |
| Heptabase, Obsidian Canvas, Muse | Stable spatial memory | You supply all the content |
| Lean blueprints | Proof dependency graphs | Built for formalizers, not learners |

Knowledge Canvas has the most parts right but lacks too much to be worth building on. Its author may be interested in this work.

It has stayed open because graduate learners are a small market for edtech, and per-person explanation at depth needed a human advisor. LLMs, fast decision models such as Jev, and capable vision models now make it feasible.

## System

```
 Drop image ──▶ Select a box ──▶ Read it (vision LLM) ──▶ Go fish (searchers)
                                                               │
                                                               ▼
                    Descent engine: the LLM writes a Sem from what was found;
                    the System One model checks it doesn't climb and keeps
                    the better of two drafts
                                                               │
                                                               ▼
     Canvas: an append-only event log (add, update, move, hide, show).
     Fixed positions, branching history, a stylesheet over the semantics.
     Selecting words in a card runs the engine again, one level down.
```

The split between a fast decision layer and a slow LLM layer follows the research on Jev: decision models do well on local choices with explicit evidence and poorly on latent knowledge ([2610.03935](https://arxiv.org/pdf/2610.03935), [2610.24929](https://arxiv.org/pdf/2610.24929)). An append-only event log gives fixed geography and branching history together, since nothing is ever overwritten.

| Piece | Where |
| --- | --- |
| Settings: LLM, System One model, searchers (Keenable keyless, SearXNG, Brave, Exa, Perplexity Sonar, Parallel, You.com, Tavily) | `server/config.ts`, `server/providers.ts`, `src/Settings.tsx` |
| Canvas log and assets | `server/canvas.ts`, `data/canvas.jsonl`, `data/assets/` |
| Read, fish, write, check | `server/explain.ts`, `server/llm.ts` |
| Canvas UI: select and pan, undo and redo, move, remove, retry | `src/Canvas.tsx`, `src/Card.tsx` |
| Semshape renderer | `src/SemShapes.tsx`, `src/styles.css` |

## Status and milestones

Development is driven by the CSS talk as a fixture, and each milestone has a test that can pass or fail.

**Fixture contents:** the 14 captured slide images; the paper's arXiv LaTeX source; hand-annotated gold data for slides 3, 8 and 23 (regions, types, dependencies, provenance); three synthetic learners: a software engineer with calculus and linear algebra, an undergraduate physicist with E&M but no PDE theory, and a mathematician from another field with analysis but no gauge theory.

1. **M0, fixture.** Fetch the paper's LaTeX source and write the gold annotations for slides 3, 8 and 23. *Not started.*
2. **M1, restructure.** Dropped slide images produce regions, identify the paper, and build an ontology matching the gold set. Passes the fidelity test: prose regenerated from the canvas keeps every claim and connective. *Regions work; source identification and restructuring the source itself are not started.*
3. **M2, descent.** For AMP, the boxed G, DeTurck gauge, the linear paradifferential equation and the bootstrap, crossed with the three personas: measure how often explanations climb, faithfulness to the paper, and whether found material beats generated text. *The loop runs end to end; first results: descent cards such as "electric field" descend well, while the first card on a dense formula (AMP) still rates "may climb" after a rewrite.*
4. **M3, canvas.** Slides pinned in place, box selection, descents growing outward, history, a first stylesheet. *Built: semshapes v1, select/pan modes, undo/redo, move with the right-of-parent rule, remove, retry.*
5. **M4, loop.** Placed tools and masked self-tests at slide 23, and the real test: does a person starting from one screenshot keep going voluntarily for an hour or more, and come back the next day? *Not started.*

## Open questions

- How forks are shown is a presentation question (principle 5) and is undecided. One candidate: open a history graph and traverse it.
- Undo history currently lives in the open page and resets on reload; the log already holds what's needed to keep it.
- The first card on a dense formula still tends to climb; better onramp sources and a stronger rewrite are the levers.
- Selections are shown as raw LaTeX; they should be rendered.

### Later: meet people in the tools they already use

People already work in Jupyter, Google Colab, Lean and Zotero. Integrations with these are for later, but the design should leave room for them: a notebook cell, a Lean goal or a Zotero item should be droppable onto the canvas like an image, and canvas content should be able to flow back out.
