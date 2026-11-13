import { readFile } from 'node:fs/promises';
import { generateFixInE2B } from './e2b-runner.js';
import type { ProviderConfig, RemediationRequest } from './types.js';

/** Manual fix-path demonstration, independent of the unfinished controller. */
const sha = process.argv.find((arg) => arg.startsWith('--sha='))?.slice('--sha='.length);
if (process.argv.includes('--publish')) throw new Error('Use the controller incident workflow to open an issue and wait for an owner comment before publishing a PR.');
if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) throw new Error('Usage: bun run demo:fix --sha=<full SHA>');
const required = ['E2B_API_KEY', 'E2B_REMEDIATOR_TEMPLATE', 'REMEDIATOR_MODEL_ID', 'REMEDIATOR_MODEL_BASE_URL', 'REMEDIATOR_MODEL_API_KEY', 'GITHUB_READ_TOKEN'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) throw new Error(`Missing dedicated credentials/configuration: ${missing.join(', ')}`);
const backend = process.env.REMEDIATOR_MODEL_API_BACKEND || 'responses';
if (!['responses', 'chat_completions', 'messages'].includes(backend)) throw new Error('Invalid REMEDIATOR_MODEL_API_BACKEND');

const fixturePath = 'apps/sample/tests/filter.repro.test.ts';
const request: RemediationRequest = {
  incidentId: `demo-filter-${Date.now()}`,
  repository: 'iotserver24/final-devhost',
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
console.log(`Starting isolated fixture diagnosis at ${sha.slice(0, 12)}; production and GitHub are unchanged.`);
const fix = await generateFixInE2B(request, provider);
if (!fix.ok) {
  console.error(JSON.stringify({ incidentId: fix.incidentId, reason: fix.reason, message: fix.message, evidence: fix.evidence }, null, 2));
  process.exitCode = 1;
} else if ('patch' in fix) {
  console.log(JSON.stringify({ incidentId: fix.incidentId, changedFiles: fix.changedFiles, mcpConfigured: fix.mcpConfigured, tests: 'passed', build: 'passed' }, null, 2));
  console.log('No PR opened. Use the controller incident workflow to open an issue and wait for an owner comment.');
} else if (fix.phase === 'awaiting_comment') {
  console.log(JSON.stringify({ incidentId: fix.incidentId, phase: fix.phase, sandboxId: fix.sandboxId, question: fix.question, testPath: fix.testPath }, null, 2));
  console.log('Sandbox is paused. A repository comment has to choose the method before a pull request is opened.');
} else {
  console.log(JSON.stringify({ incidentId: fix.incidentId, phase: fix.phase, sandboxId: fix.sandboxId, reply: fix.reply }, null, 2));
}
