// A card as plain text (Markdown), for copying out: what was asked, the explanation section by
// section in the card's own order, what was made, and where it came from.
import type { CardItem, Sem } from "../shared/canvas.ts";

const REGISTER = { term: "Term of art", idiom: "Idiom", casual: "Informal", notation: "Loosened notation" } as const;

const SECTION: Record<"why" | "what" | "parts" | "here", string> = { why: "Why it exists", what: "What it is", parts: "Its parts", here: "How it's used here" };

function semMarkdown(sem: Sem, labels: Partial<Record<keyof typeof SECTION, string>> = {}): string[] {
  const out: string[] = [];
  const head = (k: keyof typeof SECTION) => `## ${labels[k] ?? SECTION[k]}`;
  if (sem.why.length) out.push(head("why"), ...sem.why.map((s, i) => `${i + 1}. ${s}`), "");
  if (sem.what.gist) out.push(head("what"), sem.what.gist, ...sem.what.details.map((d) => `- ${d}`), "");
  if (sem.parts.length) {
    out.push(head("parts"), ...sem.parts.map((p) => `- **${p.symbol}**: ${p.meaning}${p.note ? ` (${p.note})` : ""}`));
    if (sem.together) out.push("", sem.together);
    out.push("");
  }
  if (sem.here.length) out.push(head("here"), ...sem.here.map((s, i) => `${i + 1}. ${s}`), "");
  if (sem.name) out.push(`**The name:** ${sem.name}`, "");
  return out;
}

export function cardMarkdown(card: CardItem, labels?: Partial<Record<keyof typeof SECTION, string>>): string {
  const out: string[] = [`# ${card.subject ?? card.selection ?? "Explanation"}`, ""];
  if (card.selection) out.push(`> ${card.selection.replace(/\n/g, "\n> ")}`, "");
  else if (card.transcription) out.push(`> ${card.transcription.replace(/\n/g, "\n> ")}`, "");
  if (card.register) out.push(`*${REGISTER[card.register.register]}:* ${card.register.means}`, "");
  if (card.sem) out.push(...semMarkdown(card.sem, labels));
  else if (card.facets) out.push(...[card.facets.why, card.facets.what, card.facets.how].filter(Boolean).flatMap((t) => [t!, ""]));
  if (card.origin && !card.sem && card.pageText) out.push(card.pageText, "");
  const o = card.object;
  if (o) {
    if (o.type === "links") out.push(...o.links.map((l) => `- [${l.title || l.url}](${l.url})`));
    else if (o.type === "papers") out.push(...o.papers.map((p) => `- [${p.title}](${p.url}), ${p.authors.slice(0, 3).join(", ")} (${p.published})`));
    else if (o.type === "videos") out.push(...o.videos.map((v) => `- [${v.title}](${v.url})`));
    else if (o.type === "set") out.push(...o.entries.map((e) => `- **${e.title}**${e.subtitle ? `, ${e.subtitle}` : ""}${e.note ? `: ${e.note}` : ""}${e.url ? ` (${e.url})` : ""}`));
    else if (o.type === "gallery") out.push(...o.images.map((g) => `- ${g.caption}${g.when ? ` (${g.when})` : ""}: ${g.page}`));
    else if (o.type === "table") out.push(`| ${o.columns.join(" | ")} |`, `| ${o.columns.map(() => "---").join(" | ")} |`, ...o.rows.map((r) => `| ${r.join(" | ")} |`));
    out.push("");
  }
  if (card.sources?.length) out.push("## Sources", ...card.sources.map((s) => `${s.n}. [${s.title || s.url}](${s.url})`), "");
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
