import Markdown from 'react-markdown';

/** Agent output is untrusted: render Markdown without HTML or remote images. */
export function MarkdownMessage({ children }: { children: string }) {
  return <div className="transcript-prose transcript-markdown">
    <Markdown skipHtml components={{
      h1: ({ children }) => <h3>{children}</h3>,
      h2: ({ children }) => <h3>{children}</h3>,
      a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
      img: ({ alt }) => <span>{alt}</span>,
    }}>{children}</Markdown>
  </div>;
}
