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

// Topics with a very large body of teaching material behind them (textbooks, course notes,
// lectures), so the librarian has plenty to find and descend into.
export const EXAMPLES: Example[] = [
  {
    key: "video",
    kind: "A video lecture",
    title: "Eigenvectors and eigenvalues (3Blue1Brown)",
    input: "https://www.youtube.com/watch?v=PFDu9oVAE-g",
  },
  {
    key: "wiki",
    kind: "A Wikipedia page",
    title: "Eigenvalues and eigenvectors",
    input: "https://en.wikipedia.org/wiki/Eigenvalues_and_eigenvectors",
  },
  {
    key: "paper",
    kind: "A research paper",
    title: "A Tutorial on Spectral Clustering (the graph Laplacian)",
    arxiv: { id: "0711.0189", pages: "1" },
  },
  {
    key: "question",
    kind: "A question",
    title: "What is a Hamiltonian, and why is it the energy?",
    input: "What is a Hamiltonian, and why is it the energy?",
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
