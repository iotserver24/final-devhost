import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DraftPrResult, RemediationRequest, RemediationResult } from './types.js';
import { allowedPathPrefix, truncate, validateChangedFiles, validateRequest } from './validation.js';

const exec = promisify(execFile);
const MAX_PATCH_BYTES = 256 * 1024;

/** Validate again on the trusted controller; the sandbox result is untrusted input. */
export function validatePatch(patch: string): string[] {
  if (!patch || Buffer.byteLength(patch) > MAX_PATCH_BYTES) throw new Error('Empty or oversized patch');
  if (patch.includes('GIT binary patch') || /^(?:new file mode|deleted file mode) 120000$/m.test(patch)) {
    throw new Error('Binary and symlink patches are not allowed');
  }
  const headers = [...patch.matchAll(/^diff --git a\/([^\s]+) b\/([^\s]+)$/gm)];
  if (headers.length === 0 || headers.length > 40) throw new Error('Patch has no valid file headers or is too large');
  const paths = headers.flatMap(([, before, after]) => [before, after]);
  const prefix = allowedPathPrefix();
  validateChangedFiles(paths, prefix);
  if (/^(?:rename from|rename to|copy from|copy to) /m.test(patch)) throw new Error('Renames and copies require human review');
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ b/') || line.startsWith('--- a/')) {
      const path = line.slice(6);
      if (!path.startsWith(prefix) || path.includes('..')) throw new Error('Patch has a path outside the demo app');
    }
  }
  return [...new Set(paths)];
}

/** A pre-existing regression test may stay untouched. A patch may only write the trusted fixture. */
export function regressionTestPreserved(paths: string[], testPath: string, content: string, trusted: string): void {
  const touched = paths.some(path => path === testPath);
  if (touched && content !== trusted) throw new Error('Patch modified the regression test');
}

async function run(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await exec(file, args, { cwd, env, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Run only in the trusted controller. GH_TOKEN needs Contents and Pull requests
 * write access scoped to the one repository. No write credential enters E2B.
 */
export async function publishDraftPr(request: RemediationRequest, fix: RemediationResult): Promise<DraftPrResult> {
  validateRequest(request);
  if (!fix.ok || fix.incidentId !== request.incidentId || fix.baseSha.toLowerCase() !== request.commitSha.toLowerCase()) {
    throw new Error('Only a verified fix for the same incident and base revision can be published');
  }
  const patchedPaths = validatePatch(fix.patch);
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error('GH_TOKEN is required on the trusted controller');
  const branch = `agent/incident-${request.incidentId.toLowerCase()}`;
  const env = { ...process.env, GH_TOKEN: token, GIT_TERMINAL_PROMPT: '0' };
  const directory = await mkdtemp(join(tmpdir(), 'nexathon-pr-'));
  const bodyFile = join(directory, 'pr-body.md');
  const patchFile = join(directory, 'fix.patch');
  try {
    const existing = await run('gh', ['pr', 'list', '--repo', request.repository, '--head', branch, '--state', 'all', '--json', 'url', '--jq', '.[0].url // ""'], directory, env);
    if (existing) return { branch, url: existing };

    const repoDir = join(directory, 'repo');
    await run('git', ['clone', '--no-checkout', `https://github.com/${request.repository}.git`, repoDir], directory, env);
    await run('git', ['checkout', '-B', branch, request.commitSha], repoDir, env);
    const sha = await run('git', ['rev-parse', 'HEAD'], repoDir, env);
    if (sha.toLowerCase() !== fix.baseSha.toLowerCase()) throw new Error('Repository base SHA changed unexpectedly');
    await writeFile(patchFile, fix.patch, { mode: 0o600 });
    await run('git', ['apply', '--check', patchFile], repoDir, env);
    await run('git', ['apply', '--index', patchFile], repoDir, env);
    if (request.reproductionFixture) {
      const fixture = await readFile(join(repoDir, request.reproductionFixture.path), 'utf8');
      regressionTestPreserved(patchedPaths, request.reproductionFixture.path, fixture, request.reproductionFixture.content);
    }
    const staged = await run('git', ['diff', '--cached', '--name-only'], repoDir, env);
    validateChangedFiles(staged.split('\n').filter(Boolean));
    await run('git', ['-c', 'user.name=Nexathon Remediation Agent', '-c', 'user.email=agent@users.noreply.github.com', 'commit', '-m', `fix: remediate incident ${request.incidentId}`], repoDir, env);
    // Git invokes gh as a credential helper. The token is in the process env, not the URL, patch, or child arguments.
    await run('git', ['-c', 'credential.helper=!gh auth git-credential', 'push', 'origin', `HEAD:refs/heads/${branch}`], repoDir, env);
    const body = [
      `Automated fix for incident \`${request.incidentId}\`. The pull request is open for review. Nothing is merged automatically.`,
      '',
      `Base revision: \`${fix.baseSha}\``,
      `GitHub MCP configured during diagnosis: ${fix.mcpConfigured ? 'yes' : 'no'}`,
      '',
      '### Reproduction before fix (failed as expected)',
      '```text', truncate(fix.baseline, 2000), '```',
      '### Verification after fix',
      '```text', truncate(fix.testOutput, 3000), '```',
      '### Build',
      '```text', truncate(fix.buildOutput, 2000), '```',
      '',
      'No automatic merge or production deployment was performed.',
    ].join('\n');
    await writeFile(bodyFile, body, { mode: 0o600 });
    const url = await run('gh', ['pr', 'create', '--repo', request.repository, '--base', 'main', '--head', branch, '--title', `fix: incident ${request.incidentId}`, '--body-file', bodyFile], repoDir, env);
    return { branch, url };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
