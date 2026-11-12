import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyIncidentRegression } from '../src/incident-regression.ts';

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

async function candidate(options: { original?: number; patched?: number; expected?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'incident-regression-'));
  directories.push(directory);
  const repo = join(directory, 'repo');
  await mkdir(join(repo, 'app/tests'), { recursive: true });
  const run = async (command: string) => {
    const proc = Bun.spawn(['sh', '-c', command], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, exitCode };
  };
  const source = join(repo, 'app/value.ts');
  await writeFile(source, `export const value = ${options.original ?? 1};\n`);
  expect((await run('git init -q && git add app && git -c user.name=Test -c user.email=test@example.com commit -qm baseline')).exitCode).toBe(0);
  await writeFile(source, `export const value = ${options.patched ?? 2};\n`);
  const testPath = 'app/tests/incident-test.test.ts';
  await writeFile(join(repo, testPath), `import { expect, test } from 'bun:test';\nimport { value } from '../value';\ntest('incident', () => expect(value).toBe(${options.expected ?? 2}));\n`);
  const result = await verifyIncidentRegression({
    repositoryDirectory: repo, pathPrefix: 'app/', testPath, maxPatchBytes: 256 * 1024, run,
    files: { read: path => readFile(path, 'utf8'), write: (path, content) => writeFile(path, content) },
  });
  return { result, source, repo, testPath, run };
}

test('proves the new test fails on original source and passes on the restored candidate', async () => {
  const { result, source, repo, testPath, run } = await candidate();
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.baseline.exitCode).not.toBe(0);
  expect(await readFile(source, 'utf8')).toContain('value = 2');
  expect(await readFile(join(repo, testPath), 'utf8')).toContain("test('incident'");
  expect((await run('git diff --cached --name-only')).stdout).toContain(testPath);
});

test('rejects a test that already passed on original source and still restores the candidate', async () => {
  const { result, source } = await candidate({ expected: 1 });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe('not_reproducible');
  expect(await readFile(source, 'utf8')).toContain('value = 2');
});

test('rejects a candidate whose new incident regression still fails after the patch', async () => {
  const { result } = await candidate({ patched: 3 });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe('test_failed');
});
