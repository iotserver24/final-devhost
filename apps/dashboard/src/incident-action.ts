/** Label the destination actually stored on the incident. */
export function incidentActionLabel(url: string, rollbackRecorded: boolean): string {
  try {
    const target = new URL(url);
    if (target.hostname.toLowerCase() === 'github.com') {
      if (/^\/[^/]+\/[^/]+\/issues\/\d+\/?$/.test(target.pathname)) return 'Open GitHub issue';
      if (/^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(target.pathname)) return 'Open pull request';
    }
  } catch { /* Other destinations use a neutral label. */ }
  return rollbackRecorded ? 'View rollback target' : 'View action';
}
