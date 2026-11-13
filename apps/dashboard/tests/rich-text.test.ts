import { describe, expect, test } from 'bun:test';
import { groupCopies, textKind } from '../src/rich-text';

describe('incident copy', () => {
  test('markdown structure is recognized and a raw log is not', () => {
    expect(textKind('### Findings\n\n- `GET /api/tasks/crash`')).toBe('markdown');
    expect(textKind('error: Task service failed while reading a task.\n    at GET route.ts:7')).toBe('log');
    expect(textKind('Waiting for a comment on issue #6.')).toBe('line');
  });

  test('repeated evidence collapses and keeps the first order', () => {
    expect(groupCopies(['git failed', 'probe failed', 'git failed', 'git failed'])).toEqual([
      { text: 'git failed', count: 3 },
      { text: 'probe failed', count: 1 },
    ]);
  });
});
