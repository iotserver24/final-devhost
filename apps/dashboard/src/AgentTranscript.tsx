'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityEvent, ActivityRun } from './activity';
import { MarkdownMessage } from './MarkdownMessage';

const labels: Record<ActivityEvent['kind'], string> = {
  stage: 'Stage', tool: 'Tool', tool_input: 'Tool input', tool_output: 'Tool result',
  message: 'Agent message', summary: 'What changed', usage: 'Usage', status: 'Status',
};
const filters = ['All', 'Messages', 'Tools', 'Checks'] as const;
type Filter = typeof filters[number];

export function AgentTranscript({ events, run }: { events: ActivityEvent[]; run: ActivityRun }) {
  const [filter, setFilter] = useState<Filter>('All');
  const [following, setFollowing] = useState(true);
  const feed = useRef<HTMLOListElement>(null);
  const shown = useMemo(() => events.filter(event => filter === 'All'
    || filter === 'Messages' && ['message', 'summary'].includes(event.kind)
    || filter === 'Tools' && ['tool', 'tool_input', 'tool_output'].includes(event.kind)
    || filter === 'Checks' && ['reproduction', 'verification', 'patch'].includes(event.phase)), [events, filter]);

  useEffect(() => {
    if (following && feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [events.length, following, filter]);

  function download() {
    const transcript = { ...run, events };
    const url = URL.createObjectURL(new Blob([JSON.stringify(transcript, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${run.id}-transcript.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <>
    <div className="transcript-toolbar">
      <div className="transcript-filters" role="group" aria-label="Filter agent transcript">
        {filters.map(item => <button key={item} type="button" aria-pressed={filter === item} onClick={() => setFilter(item)}>{item}</button>)}
      </div>
      <button type="button" className="transcript-download" onClick={download}>Download transcript</button>
    </div>
    <div className="transcript-caption">
      <span>{shown.length} of {events.length} entries · messages, actions, and results</span>
      <label><input type="checkbox" checked={following} onChange={event => setFollowing(event.target.checked)} /> Follow latest</label>
    </div>
    {events[0]?.seq > 1 && <p className="activity-empty">Earlier entries are outside the saved 500-entry window.</p>}
    <ol className="activity-feed transcript-feed" ref={feed} aria-label="Agent transcript" tabIndex={0}
      onScroll={() => {
        const node = feed.current;
        if (node && node.scrollHeight - node.scrollTop - node.clientHeight > 80) setFollowing(false);
      }}>
      {shown.map(event => {
        const [heading, ...rest] = event.message.split('\n');
        const isDetail = ['tool_input', 'tool_output'].includes(event.kind);
        const time = new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        return <li key={event.seq} className={`transcript-entry kind-${event.kind}`}>
          <div className="transcript-meta"><span>{labels[event.kind]} <span className="transcript-phase">/ {event.phase}</span></span><time dateTime={event.at}>{time}</time></div>
          {isDetail ? <details className="transcript-detail"><summary>{heading}</summary><pre>{rest.length ? rest.join('\n') : event.message}</pre></details>
            : event.kind === 'message' || event.kind === 'summary' ? <MarkdownMessage>{event.message}</MarkdownMessage>
            : <p className="transcript-line">{event.message}</p>}
        </li>;
      })}
    </ol>
    {shown.length === 0 && <p className="activity-empty">{events.length ? 'No entries match this filter yet.' : 'Waiting for the first agent update…'}</p>}
  </>;
}
