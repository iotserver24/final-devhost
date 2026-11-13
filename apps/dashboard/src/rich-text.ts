/** Identical evidence lines collapse to one entry, in first-seen order. */
export function groupCopies(items: string[]): { text: string; count: number }[] {
  const groups: { text: string; count: number }[] = [];
  const seen = new Map<string, number>();
  for (const item of items) {
    const key = item.trim();
    const index = seen.get(key);
    if (index === undefined) {
      seen.set(key, groups.length);
      groups.push({ text: item, count: 1 });
    } else {
      groups[index].count += 1;
    }
  }
  return groups;
}

/** Markdown is rendered. A multi-line log keeps its line breaks. A short note stays a paragraph. */
export function textKind(value: string): 'markdown' | 'log' | 'line' {
  const text = value.trim();
  if (!text) return 'line';
  if (/(^|\n)\s{0,3}#{1,6} |(^|\n)\s*[-*+] |(^|\n)\s*\d+\. |(^|\n)```|`[^`\n]+`|\*\*[^*\n]+\*\*/.test(text)) return 'markdown';
  if (text.includes('\n')) return 'log';
  return 'line';
}
