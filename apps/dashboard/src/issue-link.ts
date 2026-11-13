/** The public GitHub issue this incident already names. */
export function incidentIssueRef(incident: {
  actionUrl?: string;
  events: { message: string }[];
}): { owner: string; repo: string; number: number } | null {
  const blob = [incident.actionUrl ?? '', ...incident.events.map(event => event.message)].join('\n');
  const repo = blob.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
  const issue = blob.match(/\/issues\/(\d+)/) ?? blob.match(/issue #(\d+)/i);
  if (!repo || !issue) return null;
  return { owner: repo[1], repo: repo[2], number: Number(issue[1]) };
}
