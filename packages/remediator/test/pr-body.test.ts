import { describe, expect, test } from 'bun:test';
import { formatPullRequestBody } from '../src/pr-publisher';

describe('pull request body', () => {
  test('puts the result first and the command logs behind disclosures', () => {
    const body = formatPullRequestBody({
      incidentId: 'inc-demo',
      issueUrl: 'https://github.com/iotserver24/final-devhost/issues/6',
      baseSha: '19bd56b40651c3ed736b7463a63e7778f2b0c85b',
      mcpConfigured: true,
      baseline: '1 fail',
      testOutput: '1 pass',
      buildOutput: 'built',
    });
    expect(body.indexOf('## Result')).toBeLessThan(body.indexOf('<details>'));
    expect(body).toContain('https://github.com/iotserver24/final-devhost/issues/6');
    expect(body).toContain('`19bd56b40651c3ed736b7463a63e7778f2b0c85b`');
    expect(body).toContain('<summary>Reproduction before the fix</summary>');
    expect(body).toContain('```text\n1 fail\n```');
    expect(body).toContain('```text\n1 pass\n```');
    expect(body).toContain('Nothing is merged automatically.');
  });
});
