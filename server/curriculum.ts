// The course map: where concepts are taught, gathered opportunistically from the pages the
// librarian finds while explaining. Shared by every canvas on this server; it grows with use.
// See docs/BRAINSTORM.md, "Course level". Step 1: log sightings and show them on cards.
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { CourseLevel, CourseSighting, FoundSource } from "../shared/canvas.ts";
import { COURSE_LEVELS } from "../shared/canvas.ts";
import { DATA_DIR } from "./canvas.ts";
import { loadConfig } from "./config.ts";
import { chatJson } from "./llm.ts";

const FILE = path.join(DATA_DIR, "curriculum.jsonl");

/** A concept's name as a lookup key: "The Biot–Savart law" and "biot-savart law" are one concept. */
export function conceptKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[–—‐-]/g, "-")
    .replace(/^(the|a|an)\s+/, "")
    .replace(/[^a-z0-9+\- ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

let loaded: Promise<CourseSighting[]> | null = null;

function all(): Promise<CourseSighting[]> {
  loaded ??= readFile(FILE, "utf8").then(
    (text) =>
      text
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as CourseSighting];
          } catch {
            return [];
          }
        }),
    () => [],
  );
  return loaded;
}

/** Every sighting, for looking at the whole map. */
export function allSightings(): Promise<CourseSighting[]> {
  return all();
}

/** Where a concept has been seen taught or used, most informative first. */
export async function sightingsFor(concept: string): Promise<CourseSighting[]> {
  const key = conceptKey(concept);
  const order = { introduces: 0, unclear: 1, uses: 2 };
  return (await all()).filter((s) => s.concept === key).sort((a, b) => order[a.role] - order[b.role]);
}

async function add(sightings: CourseSighting[]) {
  const list = await all();
  const fresh = sightings.filter((s) => !list.some((o) => o.concept === s.concept && o.url === s.url));
  if (!fresh.length) return;
  list.push(...fresh);
  await appendFile(FILE, fresh.map((s) => `${JSON.stringify(s)}\n`).join(""));
}

const CLASSIFY = `Below are web pages found while researching the concept named at the top.
For each page, decide whether it belongs to a university or college course: lecture notes, a syllabus, slides, a problem set,
a course web page, or a textbook chapter written for a named course.
For each course page, give:
- "institution": the university or college, as commonly named (e.g. "UC Berkeley", "MIT"). Empty if you can't tell from the page.
- "code": the course code exactly as written (e.g. "MATH 54", "18.06", "CS 229", "Math 44A"). Empty if none is visible.
- "title": the course's title, if visible.
- "level": "intro undergraduate" | "upper undergraduate" | "graduate" | "unknown".
- "role": "introduces" if the course teaches the concept, "uses" if it treats the concept as already known, "unclear" otherwise.
- "quote": a few words from the title or snippet that show it's a course page and what it does with the concept.
Judge only from the URL, title and snippet. Never guess an institution or code that isn't there.
Return JSON only: {"pages": [{"n": 1, "course": true, "institution": "", "code": "", "title": "", "level": "", "role": "", "quote": ""}, ...]}
Include every page, with "course": false for the others.`;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Reads the course pages among some found pages, logs them, and returns the concept's sightings so far. */
export async function logCourses(concept: string, pages: FoundSource[]): Promise<CourseSighting[]> {
  const key = conceptKey(concept);
  if (!key || !pages.length) return sightingsFor(concept);
  const r = await chatJson<{ pages?: unknown }>((await loadConfig()).llm, [
    { role: "system", content: CLASSIFY },
    {
      role: "user",
      content: `Concept: ${concept}\n\n${pages.map((p) => `[${p.n}] ${p.title}\n${p.url}\n${p.snippet.slice(0, 400)}`).join("\n\n")}`,
    },
  ]);
  const at = new Date().toISOString();
  const found: CourseSighting[] = [];
  for (const item of Array.isArray(r.pages) ? r.pages : []) {
    const p = item as Record<string, unknown>;
    if (p.course !== true) continue;
    const page = pages.find((x) => x.n === Number(p.n));
    if (!page) continue;
    const institution = str(p.institution);
    const code = str(p.code);
    if (!institution && !code) continue; // a course page nobody can place says nothing about level
    const level = str(p.level) as CourseLevel;
    const role = str(p.role);
    found.push({
      concept: key,
      name: concept,
      institution,
      code,
      title: str(p.title),
      level: COURSE_LEVELS.includes(level) ? level : "unknown",
      role: role === "introduces" || role === "uses" ? role : "unclear",
      url: page.url,
      quote: str(p.quote).slice(0, 200),
      at,
    });
  }
  await add(found);
  return sightingsFor(concept);
}
