import { describe, expect, test } from 'bun:test';
import { incidentIssueBody, structureMarkdown } from '../src/github-issue';

const diagnosis = [
  'Incident inc-demo — diagnosis',
  '',
  'Repository: iotserver24/final-devhost',
  'Checked-out revision: 19bd56b40651c3ed736b7463a63e7778f2b0c85b',
  '',
  'Findings:',
  '- The log names POST /api/sites/break. The handler is apps/sample/src/app/api/tasks/crash/route.ts.',
  '- The handler throws "Task service failed while reading a task."',
  '',
  'Conclusion:',
  'The logged route is absent from this revision.',
  '',
  '```text',
  'POST /api/sites/break',
  '```',
].join('\n');

describe('incident issue markdown', () => {
  test('promotes section labels and wraps paths, routes, and revisions', () => {
    const body = structureMarkdown(diagnosis);
    expect(body).toContain('- **Repository:** `iotserver24/final-devhost`');
    expect(body).toContain('- **Revision:** `19bd56b40651c3ed736b7463a63e7778f2b0c85b`');
    expect(body).toContain('### Findings');
    expect(body).toContain('### Conclusion');
    expect(body).toContain('`POST /api/sites/break`');
    expect(body).toContain('`apps/sample/src/app/api/tasks/crash/route.ts`');
    expect(body).toContain('`Task service failed while reading a task.`');
    expect(body).toContain('```text\nPOST /api/sites/break\n```');
    expect(body.indexOf('### Findings')).toBeLessThan(body.indexOf('- The log names'));
  });

  test('leaves a blank line before a list that follows a heading', () => {
    const body = structureMarkdown('Findings:\n- one\n- two');
    expect(body).toBe('### Findings\n\n- one\n- two');
  });

  test('the issue body keeps the diagnosis, the question, and the regression test', () => {
    const body = incidentIssueBody({
      incidentId: 'inc-demo',
      diagnosis,
      question: 'Question for the repository owner:\nShould the fix target GET /api/tasks/crash?',
      testPath: 'apps/sample/tests/incident-inc-demo.test.ts',
    });
    expect(body).toContain('### What the sandbox found');
    expect(body).toContain('### Question');
    expect(body).toContain('### Regression test');
    expect(body).toContain('`apps/sample/tests/incident-inc-demo.test.ts`');
    expect(body).toContain('`GET /api/tasks/crash`');
    expect(body).not.toContain('Findings:');
  });
});
