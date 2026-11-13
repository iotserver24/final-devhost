import { MarkdownMessage } from './MarkdownMessage';
import { textKind } from './rich-text';

/** Render incident copy. Markdown stays structured. Logs keep their line breaks. */
export function RichText({ text }: { text: string }) {
  const kind = textKind(text);
  if (kind === 'markdown') return <MarkdownMessage>{text.trim()}</MarkdownMessage>;
  if (kind === 'log') return <pre className="log-block">{text.trim()}</pre>;
  return <p>{text}</p>;
}
