// Reading what was said on a call, apart from the call itself.

/** What a number said on its own picks: "two", "number 2", "the second one". */
const NUMBER: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5 };
export function pickedNumber(text: string): number | undefined {
  const m = text
    .toLowerCase()
    .replace(/[.!?,]/g, "")
    .trim()
    .match(/^(?:the\s+)?(?:number\s+)?(one|two|three|four|five|first|second|third|fourth|fifth|[1-5])(?:\s+one)?(?:\s+please)?$/);
  return m ? NUMBER[m[1]] : undefined;
}
