import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownMessage } from '../src/MarkdownMessage';

test('renders agent formatting as Markdown, including lists, inline code, and fenced code', () => {
  const message = '**Fixed the failing task-read path.** The route `/api/tasks/crash` returns 404 for unknown IDs.\n\n**Verification passed:**\n- `bun test src/tests`\n- `bun run build`\n\n### Changed files\n\n```ts\nreturn Response.json(task);\n```';
  const html = renderToStaticMarkup(<MarkdownMessage>{message}</MarkdownMessage>);
  expect(html).toContain('<strong>Fixed the failing task-read path.</strong>');
  expect(html).toContain('<code>/api/tasks/crash</code>');
  expect(html).toContain('<ul>');
  expect(html).toContain('<li><code>bun test src/tests</code></li>');
  expect(html).toContain('<h3>Changed files</h3>');
  expect(html).toContain('<pre><code class="language-ts">');
});

test('blocks raw HTML, executable links, and remote images while allowing ordinary links', () => {
  const html = renderToStaticMarkup(<MarkdownMessage>{'<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)\n\n![tracker](https://example.com/track.png)\n\n[PR](https://github.com/example/app/pull/1)'}</MarkdownMessage>);
  expect(html).not.toContain('<script');
  expect(html).not.toContain('javascript:');
  expect(html).not.toContain('<img');
  expect(html).not.toContain('track.png');
  expect(html).toContain('href="https://github.com/example/app/pull/1"');
  expect(html).toContain('rel="noopener noreferrer"');
});
