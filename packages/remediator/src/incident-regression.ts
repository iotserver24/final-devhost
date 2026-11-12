import { shellQuote } from './validation.js';

interface CommandOutput { exitCode: number; stdout: string; stderr: string }

/** Verify an agent-authored reproduction against both revisions in an isolated checkout. */
export async function verifyIncidentRegression(options: {
  repositoryDirectory: string;
  pathPrefix: string;
  testPath: string;
  maxPatchBytes: number;
  run: (command: string, timeoutMs: number) => Promise<CommandOutput>;
  files: { read: (path: string) => Promise<string>; write: (path: string, content: string) => Promise<unknown> };
}): Promise<{ ok: true; baseline: CommandOutput } | { ok: false; reason: 'unsafe_patch' | 'not_reproducible' | 'test_failed'; message: string; output?: string }> {
  const { run, files, repositoryDirectory, testPath, pathPrefix } = options;
  const checked = async (command: string, timeoutMs: number) => {
    const result = await run(command, timeoutMs);
    if (result.exitCode !== 0) throw new Error(`Incident regression checkout operation failed: ${result.stderr || result.stdout}`);
    return result;
  };
  const test = await files.read(`${repositoryDirectory}/${testPath}`);
  await checked(`git add -A -- ${shellQuote(pathPrefix)}`, 15_000);
  const modified = await checked(`git diff --cached --name-only --diff-filter=MD HEAD -- ${shellQuote(pathPrefix)}`, 10_000);
  if (modified.stdout.split('\n').some(path => /(^|\/)(__tests__|tests?|specs?)\/|\.(test|spec)\.[^/]+$/.test(path))) {
    return { ok: false, reason: 'unsafe_patch', message: 'The incident investigation modified or deleted an existing test' };
  }
  const candidate = await checked('git diff --cached --binary --no-ext-diff HEAD', 20_000);
  if (!candidate.stdout || Buffer.byteLength(candidate.stdout) > options.maxPatchBytes) {
    return { ok: false, reason: 'unsafe_patch', message: 'Candidate patch is empty or exceeds 256 KiB' };
  }
  const patchPath = `${repositoryDirectory}/../incident-candidate.patch`;
  await files.write(patchPath, candidate.stdout);
  await checked(`git restore --source=HEAD --staged --worktree -- ${shellQuote(pathPrefix)}`, 15_000);
  await checked(`mkdir -p ${shellQuote(`${repositoryDirectory}/${pathPrefix}tests`)}`, 10_000);
  await files.write(`${repositoryDirectory}/${testPath}`, test);
  const command = `export PATH="$HOME/.bun/bin:$PATH"; bun test ${shellQuote(testPath)}`;
  const baseline = await run(command, 120_000);
  // Restore the candidate even when the test passes against the original source.
  await checked(`rm -f -- ${shellQuote(testPath)}`, 10_000);
  await checked(`git apply --index ${shellQuote(patchPath)}`, 15_000);
  if (baseline.exitCode === 0) {
    return { ok: false, reason: 'not_reproducible', message: 'The incident test also passes against the original source; no verified fix PR can be published' };
  }
  const patched = await run(command, 120_000);
  if (patched.exitCode !== 0) {
    return { ok: false, reason: 'test_failed', message: 'The incident-specific regression still fails after the patch', output: patched.stderr || patched.stdout };
  }
  return { ok: true, baseline };
}
