import { readFile } from 'node:fs/promises';
import { generateFixInE2B } from './e2b-runner.js';
import { publishDraftPr } from './pr-publisher.js';
import type { ProviderConfig, RemediationRequest } from './types.js';

/** Manual fix-path demonstration, independent of the unfinished controller. */
const sha = process.argv.find((arg) => arg.startsWith('--sha='))?.slice('--sha='.length);
const publish = process.argv.includes('--publish');
if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) throw new Error('Usage: bun run demo:fix --sha=<full SHA> [--publish]');
const required = ['E2B_API_KEY', 'E2B_REMEDIATOR_TEMPLATE', 'REMEDIATOR_MODEL_ID', 'REMEDIATOR_MODEL_BASE_URL', 'REMEDIATOR_MODEL_API_KEY', 'GITHUB_READ_TOKEN'];
if (publish) required.push('GH_TOKEN');
const missing = required.filter((key) => !process.env[key]);
if (missing.length) throw new Error(`Missing dedicated credentials/configuration: ${missing.join(', ')}`);
const backend = process.env.REMEDIATOR_MODEL_API_BACKEND || 'responses';
if (!['responses', 'chat_completions', 'messages'].includes(backend)) throw new Error('Invalid REMEDIATOR_MODEL_API_BACKEND');

const fixturePath = 'apps/sample/tests/filter.repro.test.ts';
const request: RemediationRequest = {
  incidentId: `demo-filter-${Date.now()}`,
  repository: 'iotserver24/nexathon',
  commitSha: sha,
  evidence: ['Fixture demonstration: GET /api/tasks?status=Done returns the unfiltered list instead of Done tasks only.'],
  setupCommand: 'bun install --frozen-lockfile --filter ./apps/sample',
  reproduceCommand: `bun test ${fixturePath}`,
  testCommand: 'bun run --cwd apps/sample test',
  buildCommand: 'bun run --cwd apps/sample build',
  reproductionFixture: {
    path: fixturePath,
    content: await readFile(new URL('../fixtures/task-filter.repro.ts.txt', import.meta.url), 'utf8'),
  },
};
const provider: ProviderConfig = {
  modelName: 'dedicated-remediator',
  modelId: process.env.REMEDIATOR_MODEL_ID!,
  baseUrl: process.env.REMEDIATOR_MODEL_BASE_URL!,
  apiBackend: backend as ProviderConfig['apiBackend'],
  apiKey: process.env.REMEDIATOR_MODEL_API_KEY!,
  githubReadToken: process.env.GITHUB_READ_TOKEN!,
};
console.log(`Starting isolated fixture remediation at ${sha.slice(0, 12)}; production and GitHub are unchanged unless --publish succeeds.`);
const fix = await generateFixInE2B(request, provider);
if (!fix.ok) {
  console.error(JSON.stringify({ incidentId: fix.incidentId, reason: fix.reason, message: fix.message, evidence: fix.evidence }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ incidentId: fix.incidentId, changedFiles: fix.changedFiles, mcpConfigured: fix.mcpConfigured, tests: 'passed', build: 'passed' }, null, 2));
  if (publish) {
    const pr = await publishDraftPr(request, fix);
    console.log(`Draft PR opened for human review: ${pr.url}`);
  } else {
    console.log('No PR opened. Pass --publish with a repository-scoped GH_TOKEN to publish a new verified run.');
  }
}
