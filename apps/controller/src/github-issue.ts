export interface IncidentIssue {
  number: number;
  url: string;
}

const SECTION_LINE = /^(Findings|Conclusion|Proposed method|Question for the repository owner):\s*$/i;
const FIELD_LINE = /^(Repository|Checked-out revision|Revision):\s+(.+)$/i;

/** Turn a prose diagnosis into GitHub-flavored Markdown. Existing headings and code fences stay intact. */
export function structureMarkdown(source: string): string {
  let fence = false;
  const lines = source.replace(/\r\n/g, '\n').split('\n').map(line => {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      return line;
    }
    if (fence) return line;
    const trimmed = line.trim();
    const section = trimmed.match(SECTION_LINE);
    if (section) {
      const title = section[1].toLowerCase() === 'question for the repository owner' ? 'Question' : section[1];
      return `### ${title}`;
    }
    const field = trimmed.match(FIELD_LINE);
    if (field) {
      const label = /^checked-out revision$/i.test(field[1]) ? 'Revision' : field[1];
      return `- **${label}:** \`${field[2].trim()}\``;
    }
    return wrapIdentifiers(line);
  });
  return collapseBlank(separateLists(spaceHeadings(lines))).join('\n').trim();
}

export function incidentIssueBody(input: {
  incidentId: string;
  diagnosis: string;
  question: string;
  testPath: string;
}): string {
  return [
    `Incident \`${input.incidentId}\`.`,
    '',
    '### What the sandbox found',
    '',
    boundedMarkdown(structureMarkdown(input.diagnosis), 4000),
    '',
    '### Question',
    '',
    boundedMarkdown(structureMarkdown(input.question), 2000),
    '',
    '### Regression test',
    '',
    `- Test: \`${input.testPath}\``,
    '- It fails on the broken revision and passes only after the defect is gone.',
    '',
    'Comment on this issue with the method to use. The fix starts after that comment, and the pull request will reference this issue.',
  ].join('\n');
}

function spaceHeadings(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (out.at(-1) && /^#{1,6}\s/.test(out.at(-1) ?? '') && line.trim() !== '') out.push('');
    out.push(line);
  }
  return out;
}

function separateLists(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const list = /^\s*[-*]\s+/.test(line);
    const previous = [...out].reverse().find(item => item.trim() !== '');
    if (list && previous && !/^\s*[-*]\s+/.test(previous) && out.at(-1)?.trim() !== '') out.push('');
    out.push(line);
  }
  return out;
}

function collapseBlank(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() === '' && (out.length === 0 || out.at(-1)?.trim() === '')) continue;
    out.push(line);
  }
  while (out.at(-1)?.trim() === '') out.pop();
  return out;
}

function boundedMarkdown(markdown: string, limit: number): string {
  const text = markdown.trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const line = cut.lastIndexOf('\n');
  const body = (line > limit * 0.6 ? cut.slice(0, line) : cut).trimEnd();
  const fences = body.match(/^```/gm)?.length ?? 0;
  return fences % 2 === 1 ? `${body}\n\`\`\`` : body;
}

function wrapIdentifiers(line: string): string {
  const quotes: string[] = [];
  const held = line.split('`').map((part, index) => index % 2 === 1 ? part : part.replace(/"[^"\n]*"/g, quote => {
    quotes.push(quote);
    return `\uE000${quotes.length - 1}\uE000`;
  })).join('`');
  const wrapped = held.split('`').map((part, index) => {
    if (index % 2 === 1) return part;
    return part
      .replace(/\b((?:GET|POST|PUT|PATCH|DELETE)\s+\/[A-Za-z0-9_./{}:-]*[A-Za-z0-9_/{}\-])/g, '`$1`')
      .replace(/\b((?:apps|packages)\/[A-Za-z0-9_./-]*[A-Za-z0-9_\-])/g, '`$1`')
      .replace(/\b([0-9a-f]{40})\b/gi, '`$1`');
  }).join('`');
  return wrapped.replace(/\uE000(\d+)\uE000/g, (_, index: string) => {
    const quote = quotes[Number(index)] ?? '';
    const inner = quote.slice(1, -1);
    return inner.includes('/') || inner.includes('`') ? quote : `\`${inner}\``;
  });
}

/** Record the incident before diagnosis, without claiming a test or fix exists. */
export async function openPendingIncidentIssue(repository: string, token: string, incidentId: string): Promise<IncidentIssue> {
  const response = await fetch(`https://api.github.com/repos/${repository}/issues`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'sentinel', 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `Incident ${incidentId}`, body: `Incident \`${incidentId}\`.\n\nDiagnosis is in progress. Sentinel will update this issue with evidence and a proposed method before requesting an owner comment.` }),
  });
  if (!response.ok) throw new Error(`GitHub did not open an issue (${response.status}).`);
  const body = await response.json() as { number?: unknown; html_url?: unknown };
  if (typeof body.number !== 'number' || typeof body.html_url !== 'string') throw new Error('GitHub issue response had no number.');
  return { number: body.number, url: body.html_url };
}

/** Replace the pending issue text with the verified diagnosis and owner question. */
export async function updateIncidentIssue(repository: string, token: string, issueNumber: number, input: {
  incidentId: string; diagnosis: string; question: string; testPath: string;
}): Promise<void> {
  const response = await fetch(`https://api.github.com/repos/${repository}/issues/${issueNumber}`, {
    method: 'PATCH',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'sentinel', 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: incidentIssueBody(input) }),
  });
  if (!response.ok) throw new Error(`GitHub did not update the issue (${response.status}).`);
}

/** Open a GitHub issue the repository owner can answer. The token stays in the request header. */
export async function openIncidentIssue(repository: string, token: string, input: {
  incidentId: string;
  diagnosis: string;
  question: string;
  testPath: string;
}): Promise<IncidentIssue> {
  const response = await fetch(`https://api.github.com/repos/${repository}/issues`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'sentinel',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: `Incident ${input.incidentId}`,
      body: incidentIssueBody(input),
    }),
  });
  if (!response.ok) throw new Error(`GitHub did not open an issue (${response.status}).`);
  const body = await response.json() as { number?: unknown; html_url?: unknown };
  if (typeof body.number !== 'number' || typeof body.html_url !== 'string') throw new Error('GitHub issue response had no number.');
  return { number: body.number, url: body.html_url };
}

export async function commentOnIssue(repository: string, token: string, issueNumber: number, body: string): Promise<void> {
  const response = await fetch(`https://api.github.com/repos/${repository}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'sentinel',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body: body.slice(0, 6000) }),
  });
  if (!response.ok) throw new Error(`GitHub did not accept the issue comment (${response.status}).`);
}
