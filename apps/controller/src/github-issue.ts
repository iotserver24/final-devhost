export interface IncidentIssue {
  number: number;
  url: string;
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
      body: [
        `Incident \`${input.incidentId}\`.`,
        '',
        '### What the sandbox found',
        input.diagnosis.slice(0, 4000),
        '',
        '### Question',
        input.question.slice(0, 2000),
        '',
        `A regression test is in the paused sandbox at \`${input.testPath}\`. It fails on the broken revision. Comment on this issue with the method to use. The fix starts after that comment, and the pull request will reference this issue.`,
      ].join('\n'),
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
