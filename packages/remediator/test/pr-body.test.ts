import { describe, expect, test } from 'bun:test';
import { formatPullRequestBody, publishDraftPr } from '../src/pr-publisher';

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

describe('pull request publishing gates', () => {
  test('rejects an unverified fix or a missing or unrelated issue before touching GitHub', async () => {
    const request = {
      incidentId: 'inc-test', repository: 'iotserver24/final-devhost', commitSha: 'a'.repeat(40),
      evidence: [], setupCommand: 'bun install', reproduceCommand: 'bun test', testCommand: 'bun test', buildCommand: 'bun run build',
    };
    const fix = {
      ok: true as const, incidentId: request.incidentId, baseSha: request.commitSha, patch: 'patch', changedFiles: [],
      baseline: 'fail', agentSummary: 'fix', testOutput: 'pass', buildOutput: 'pass', mcpConfigured: true,
    };
    await expect(publishDraftPr(request, fix)).rejects.toThrow('Only a verified fix');
    const verified = { ...fix, verifiedRegression: true };
    await expect(publishDraftPr(request, verified)).rejects.toThrow('matching incident issue');
    await expect(publishDraftPr({ ...request, issueUrl: 'https://github.com/other/repo/issues/42' }, verified)).rejects.toThrow('matching incident issue');
    await expect(publishDraftPr({ ...request, issueUrl: 'https://github.com/iotserver24/final-devhost/issues/42' }, verified)).rejects.toThrow('Patch has no valid file headers');
  });
});
