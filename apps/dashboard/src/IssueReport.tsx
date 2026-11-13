'use client';

import { useEffect, useState } from 'react';
import type { Incident } from '@nexathon/contracts';
import { MarkdownMessage } from './MarkdownMessage';
import { incidentIssueRef } from './issue-link';

/** Show the GitHub issue as rendered Markdown. The repository is public, so no token is sent. */
export function IssueReport({ incident }: { incident: Incident }) {
  const ref = incidentIssueRef(incident);
  const [body, setBody] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    if (!ref) return;
    const controller = new AbortController();
    setState('loading');
    setBody('');
    fetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error(String(response.status));
      const json = await response.json() as { body?: unknown };
      setBody(typeof json.body === 'string' ? json.body : '');
      setState('ready');
    }).catch(error => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setState('error');
    });
    return () => controller.abort();
  }, [ref?.owner, ref?.repo, ref?.number]);

  if (!ref) return null;
  const href = `https://github.com/${ref.owner}/${ref.repo}/issues/${ref.number}`;
  return <section className="panel issue-report" aria-label="GitHub issue">
    <div className="section-heading">
      <h2>GitHub issue</h2>
      <a href={href} target="_blank" rel="noreferrer">#{ref.number}</a>
    </div>
    {state === 'loading' && <p className="activity-empty">Loading the issue.</p>}
    {state === 'error' && <p className="activity-error" role="status">The GitHub issue could not be loaded. <a href={href} target="_blank" rel="noreferrer">Open it on GitHub.</a></p>}
    {state === 'ready' && body && <MarkdownMessage document>{body}</MarkdownMessage>}
    {state === 'ready' && !body && <p className="activity-empty">This issue has no description.</p>}
  </section>;
}
