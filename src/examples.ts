// Ready-made starting points, so a first visit has something to try with one click.
import type { Paper } from "../shared/canvas.ts";
import { searchArxiv } from "./arxiv.ts";

export interface Example {
  key: string;
  /** What kind of starting point it shows off. */
  kind: string;
  title: string;
  /** A link or question to start from, or an arXiv paper and the pages to add. */
  input?: string;
  arxiv?: { id: string; pages: string };
}

export const EXAMPLES: Example[] = [
  {
    key: "paper",
    kind: "A research paper",
    title: "The Cauchy problem for Manton's Chern–Simons–Schrödinger equation",
    arxiv: { id: "2609.13096", pages: "1" },
  },
  { key: "wiki", kind: "A Wikipedia page", title: "Bialgebra", input: "https://en.wikipedia.org/wiki/Bialgebra" },
  {
    key: "question",
    kind: "A question",
    title: "Why does quantum mechanics need complex numbers?",
    input: "Why does quantum mechanics need complex numbers?",
  },
];

export const exampleByKey = (key: string | null) => EXAMPLES.find((e) => e.key === key);

/** Starts a canvas from an example: reads the link or asks the question, or adds the paper's pages. */
export async function runExample(
  ex: Example,
  start: (input: string) => Promise<void>,
  addPaper: (paper: Paper, pages: string) => Promise<void>,
): Promise<void> {
  if (ex.input) return start(ex.input);
  if (!ex.arxiv) return;
  const { papers } = await searchArxiv(ex.arxiv.id);
  if (!papers[0]) throw new Error("arXiv didn't find the example paper");
  await addPaper(papers[0], ex.arxiv.pages);
}
