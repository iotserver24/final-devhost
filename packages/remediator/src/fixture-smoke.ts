import { readFile } from 'node:fs/promises';
import { CommandExitError, Sandbox } from 'e2b';
import { validatePatch } from './pr-publisher.js';

/** Deterministic pipeline rehearsal. It does not call a model or write to GitHub. */
const sha = process.env.SMOKE_CLONE_SHA;
const template = process.env.E2B_REMEDIATOR_TEMPLATE;
if (!process.env.E2B_API_KEY || !template || !sha || !/^[0-9a-f]{40}$/i.test(sha)) {
  throw new Error('E2B_API_KEY, E2B_REMEDIATOR_TEMPLATE (4 GiB+), and full SMOKE_CLONE_SHA are required');
}

const repo = '/home/user/nexathon';
const sandbox = await Sandbox.create(template, { timeoutMs: 300_000, metadata: { purpose: 'nexathon-fixture-smoke' } });
try {
  await sandbox.commands.run(`git clone --no-checkout --filter=blob:none https://github.com/iotserver24/nexathon.git ${repo} && git -C ${repo} checkout --detach ${sha}`, { timeoutMs: 90_000 });
  await sandbox.commands.run('if [ -x "$HOME/.bun/bin/bun" ]; then "$HOME/.bun/bin/bun" --version; else curl -fsSL https://bun.com/install -o /tmp/bun-install.sh && bash /tmp/bun-install.sh bun-v1.3.11; fi', { timeoutMs: 90_000 });
  await sandbox.commands.run('export PATH="$HOME/.bun/bin:$PATH"; bun install --frozen-lockfile --filter ./apps/sample', { cwd: repo, timeoutMs: 120_000 });

  const fixture = await readFile(new URL('../fixtures/task-filter.repro.ts.txt', import.meta.url), 'utf8');
  await sandbox.files.write(`${repo}/apps/sample/tests/filter.repro.test.ts`, fixture);
  let failedBefore = false;
  try {
    await sandbox.commands.run('export PATH="$HOME/.bun/bin:$PATH"; bun test apps/sample/tests/filter.repro.test.ts', { cwd: repo, timeoutMs: 30_000 });
  } catch (error) {
    if (!(error instanceof CommandExitError) || error.exitCode === 0) throw error;
    failedBefore = error.stdout.includes('filtering tasks by status') || error.stderr.includes('filtering tasks by status');
  }
  if (!failedBefore) throw new Error('Regression fixture did not fail in the expected test');
  console.log('Baseline: targeted reproduction failed as expected.');

  const routePath = `${repo}/apps/sample/src/app/api/tasks/route.ts`;
  const original = await sandbox.files.read(routePath);
  if (typeof original !== 'string' || !original.includes('export function GET()') || !original.includes('count: tasks.length,\n    tasks,')) {
    throw new Error('Sample route changed; update this test-only deterministic fixture');
  }
  const patched = original
    .replace('export function GET() {', 'export function GET(request: Request) {')
    .replace('  return NextResponse.json({\n    ok: true,\n    count: tasks.length,\n    tasks,',
      '  const status = new URL(request.url).searchParams.get("status");\n  const selected = status ? tasks.filter((task) => task.status === status) : tasks;\n\n  return NextResponse.json({\n    ok: true,\n    count: selected.length,\n    tasks: selected,');
  if (patched === original || !patched.includes('tasks: selected')) throw new Error('Deterministic fix was not applied');
  await sandbox.files.write(routePath, patched);
  // Keep the existing API tests type-correct after Next requires a non-optional Request parameter.
  const apiTestPath = `${repo}/apps/sample/tests/api.test.ts`;
  const apiTests = await sandbox.files.read(apiTestPath);
  if (typeof apiTests !== 'string' || !apiTests.includes('getTasks()')) throw new Error('Sample API tests changed');
  await sandbox.files.write(apiTestPath, apiTests.replaceAll('getTasks()', "getTasks(new Request('http://localhost/api/tasks'))"));
  await sandbox.commands.run('export PATH="$HOME/.bun/bin:$PATH"; bun test apps/sample/tests/filter.repro.test.ts && bun run --cwd apps/sample test && bun run --cwd apps/sample build && test -f apps/sample/.next/BUILD_ID', { cwd: repo, timeoutMs: 180_000 });
  const staged = await sandbox.commands.run('git add -A -- apps/sample && git diff --cached --binary --no-ext-diff HEAD', { cwd: repo, timeoutMs: 20_000 });
  const changed = validatePatch(staged.stdout);
  if (!changed.includes('apps/sample/src/app/api/tasks/route.ts') || !changed.includes('apps/sample/tests/filter.repro.test.ts')) {
    throw new Error('Patch did not contain both the fix and regression test');
  }
  console.log(`After deterministic fix: targeted test, sample tests, build, and patch validation passed (${changed.length} files).`);
} finally {
  await sandbox.kill().catch(() => undefined);
}
