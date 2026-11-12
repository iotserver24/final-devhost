import { CommandExitError, Sandbox, type CommandResult } from 'e2b';
import { verifyIncidentRegression } from './incident-regression.js';
import { boundActivityText, createAgentActivityParser, type RemediationActivity } from './activity.js';
import { remediationPrompt, superchargeConfig } from './prompt.js';
import type { ProviderConfig, RemediationFailure, RemediationRequest, RemediationResult } from './types.js';
import { allowedPathPrefix, shellQuote, truncate, validateChangedFiles, validateProvider, validateRequest } from './validation.js';

const REPO_DIR = '/home/user/nexathon';
const SC_VERSION = '1.3.30'; // Latest verified published release at initial implementation.
const BUN_VERSION = '1.3.11'; // Team's pinned Bun runtime; update together.
const MAX_PATCH_BYTES = 256 * 1024;

function redacted(text: string, config: ProviderConfig, max = 6000): string {
  let output = text;
  for (const secret of [config.apiKey, config.githubReadToken]) {
    if (secret && secret.length >= 4) output = output.replaceAll(secret, '[REDACTED]');
  }
  return truncate(output
    .replace(/((?:[\"']?[\w.-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie)[\w.-]*[\"']?)\s*[:=]\s*)(?!(?:Bearer|Basic)\s)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, '[REDACTED authorization]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|sk-[A-Za-z0-9_-]{8,})\b/g, '[REDACTED token]')
    .replace(/https:\/\/hooks\.slack(?:-gov)?\.com\/services\/[^\s<>"']+/gi, '[REDACTED webhook]'), max);
}

function failure(request: RemediationRequest, reason: RemediationFailure, message: string, evidence?: string): RemediationResult {
  return { ok: false, incidentId: request.incidentId, reason, message, ...(evidence ? { evidence } : {}) };
}

async function command(sandbox: Sandbox, cmd: string, timeoutMs: number, cwd?: string, envs?: Record<string, string>,
  callbacks?: { onStdout?: (data: string) => void; onStderr?: (data: string) => void }): Promise<CommandResult> {
  try {
    return await sandbox.commands.run(cmd, { cwd, envs, timeoutMs, ...callbacks });
  } catch (error) {
    if (error instanceof CommandExitError) return { exitCode: error.exitCode, error: error.error, stdout: error.stdout, stderr: error.stderr };
    throw error;
  }
}

async function checked(sandbox: Sandbox, cmd: string, timeoutMs: number, cwd?: string): Promise<CommandResult> {
  const result = await command(sandbox, cmd, timeoutMs, cwd);
  if (result.exitCode !== 0) throw new Error(`Sandbox setup command failed (${result.exitCode}): ${truncate(result.stderr || result.stdout, 1500)}`);
  return result;
}

/**
 * Clone at an exact revision, reproduce the failure, run a bounded coding agent,
 * verify tests/build, and return a data-only patch. No GitHub write token enters E2B.
 */
export async function generateFixInE2B(request: RemediationRequest, provider: ProviderConfig,
  options?: { onEvent?: (event: RemediationActivity) => void | Promise<void> }): Promise<RemediationResult> {
  validateRequest(request);
  validateProvider(provider);
  if (!process.env.E2B_API_KEY) throw new Error('E2B_API_KEY is required on the controller');
  const template = process.env.E2B_REMEDIATOR_TEMPLATE;
  if (!template) throw new Error('E2B_REMEDIATOR_TEMPLATE is required; the default base sandbox cannot install/build the sample app');

  const emit = async (phase: RemediationActivity['phase'], kind: RemediationActivity['kind'], message: string) => {
    try { await options?.onEvent?.({ at: new Date().toISOString(), phase, kind, message: boundActivityText(redacted(message, provider, 100_000)) }); }
    catch { /* Dashboard transport failure must not abort remediation. */ }
  };
  let sandbox: Sandbox | undefined;
  try {
    await emit('sandbox', 'stage', 'Starting isolated E2B sandbox');
    const options = {
      timeoutMs: 600_000,
      metadata: { purpose: 'nexathon-remediation', incident: request.incidentId },
    };
    sandbox = await Sandbox.create(template, options);
    await emit('checkout', 'stage', 'Cloning the allowlisted repository at the incident revision');
    await checked(sandbox, `git clone --no-checkout --filter=blob:none ${shellQuote(`https://github.com/${request.repository}.git`)} ${REPO_DIR}`, 90_000);
    await checked(sandbox, `git checkout --detach ${shellQuote(request.commitSha)}`, 60_000, REPO_DIR);
    const head = (await checked(sandbox, 'git rev-parse HEAD', 10_000, REPO_DIR)).stdout.trim();
    if (head.toLowerCase() !== request.commitSha.toLowerCase()) throw new Error('Cloned revision does not match incident SHA');

    await emit('setup', 'stage', 'Preparing pinned Bun and sample dependencies');
    // Bun is used for dependency setup, tests, and build in the target repo.
    await checked(sandbox, `if [ -x "$HOME/.bun/bin/bun" ] && [ "$("$HOME/.bun/bin/bun" --version)" = "${BUN_VERSION}" ]; then "$HOME/.bun/bin/bun" --version; else curl -fsSL https://bun.com/install -o /tmp/bun-install.sh && bash /tmp/bun-install.sh bun-v${BUN_VERSION}; fi`, 90_000);
    await emit('setup', 'tool_input', `Dependency setup command\n${request.setupCommand}`);
    const setup = await command(sandbox, `export PATH="$HOME/.bun/bin:$PATH"; ${request.setupCommand}`, 180_000, REPO_DIR);
    await emit('setup', 'tool_output', `Dependency setup · exit ${setup.exitCode}\n${setup.stdout}\n${setup.stderr}`);
    if (setup.exitCode !== 0) return failure(request, 'setup_failed', 'Project dependency setup failed', redacted(setup.stderr || setup.stdout, provider));

    let protectedTest: string | undefined;
    if (request.reproductionFixture) {
      const destination = `${REPO_DIR}/${request.reproductionFixture.path}`;
      const existing = await command(sandbox, `test -e ${shellQuote(destination)}`, 10_000);
      if (existing.exitCode === 0) {
        protectedTest = await sandbox.files.read(destination);
        await emit('reproduction', 'status', 'Using the regression test already committed at this revision');
      } else {
        await command(sandbox, `mkdir -p ${shellQuote(destination.slice(0, destination.lastIndexOf('/')))}`, 10_000);
        await sandbox.files.write(destination, request.reproductionFixture.content);
        protectedTest = request.reproductionFixture.content;
      }
    }
    await emit('reproduction', 'stage', 'Checking that the incident reproduces before a patch');
    await emit('reproduction', 'tool_input', `Initial reproduction command\n${request.reproduceCommand}`);
    const baseline = await command(sandbox, `export PATH="$HOME/.bun/bin:$PATH"; ${request.reproduceCommand}`, 120_000, REPO_DIR);
    await emit('reproduction', 'tool_output', `Initial reproduction · exit ${baseline.exitCode}\n${baseline.stdout}\n${baseline.stderr}`);
    const baselinePassed = baseline.exitCode === 0;
    const regressionTestPath = `${allowedPathPrefix()}tests/incident-${request.incidentId}.test.ts`;
    if (baselinePassed) {
      const exists = await command(sandbox, `test -e ${shellQuote(`${REPO_DIR}/${regressionTestPath}`)}`, 10_000);
      if (exists.exitCode === 0) return failure(request, 'not_reproducible', 'Incident regression test path already exists; refusing to overwrite a committed test');
    }
    await emit('reproduction', 'status', baselinePassed
      ? 'Configured test passes; agent will inspect the code and logs and add an incident-specific reproduction'
      : 'Baseline failed as expected; agent will inspect the code and logs before fixing');

    await checked(sandbox,
      `if "$HOME/.local/bin/supercharge" --version 2>/dev/null | grep -q '^supercharge ${SC_VERSION} '; then "$HOME/.local/bin/supercharge" --version; else curl -fsSL https://www.superchargeai.in/install.sh -o /tmp/supercharge-install.sh && SUPERCHARGE_VERSION=${SC_VERSION} SUPERCHARGE_GITHUB_REPO=iotserver24/supercharge-releases SUPERCHARGE_NO_MODIFY_PATH=1 bash /tmp/supercharge-install.sh && "$HOME/.local/bin/supercharge" --version; fi`,
      90_000);
    await sandbox.files.write('/home/user/.supercharge/config.toml', superchargeConfig(provider));
    await checked(sandbox, 'chmod 700 /home/user/.supercharge && chmod 600 /home/user/.supercharge/config.toml', 10_000);
    await sandbox.files.write('/home/user/incident-prompt.txt', remediationPrompt(request, { baselinePassed, regressionTestPath }));
    const envs = { GITHUB_READ_TOKEN: provider.githubReadToken };
    const parser = createAgentActivityParser((kind, message) => { void emit('agent', kind, message); },
      (text) => redacted(text, provider, 1_000_000));
    let diagnosticsNoted = false;
    await emit('agent', 'stage', 'Supercharge is diagnosing and editing in E2B');
    const agent = await command(sandbox,
      'export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"; supercharge --cwd /home/user/nexathon --prompt-file /home/user/incident-prompt.txt --always-approve --no-subagents --disable-web-search --output-format streaming-json',
      270_000, REPO_DIR, envs, {
        onStdout: (data) => parser.push(data),
        onStderr: () => { if (!diagnosticsNoted) { diagnosticsNoted = true; void emit('agent', 'status', 'Agent emitted diagnostics; raw stderr is hidden'); } },
      });
    parser.finish();
    if (agent.exitCode !== 0) return failure(request, 'agent_failed', 'Supercharge failed before a verified patch was available', redacted(agent.stderr || agent.stdout, provider));
    if (request.reproductionFixture && protectedTest !== undefined) {
      const current = await sandbox.files.read(`${REPO_DIR}/${request.reproductionFixture.path}`);
      if (current !== protectedTest) return failure(request, 'unsafe_patch', 'Agent modified the regression test');
    }

    const changed = await checked(sandbox,
      'git diff --name-only -z HEAD; git ls-files --others --exclude-standard -z', 15_000, REPO_DIR);
    const changedFiles = [...new Set(changed.stdout.split('\0').filter(Boolean))];
    try {
      validateChangedFiles(changedFiles);
    } catch (error) {
      return failure(request, changedFiles.length ? 'unsafe_patch' : 'no_patch', (error as Error).message);
    }

    let incidentBaseline: { stdout: string; stderr: string } | undefined;
    if (baselinePassed) {
      if (!changedFiles.includes(regressionTestPath)) {
        return failure(request, 'not_reproducible', 'Agent investigated the repository but did not produce an incident-specific regression test');
      }
      await emit('reproduction', 'stage', 'Verifying the new incident test against the original and patched source');
      const activeSandbox = sandbox;
      const regression = await verifyIncidentRegression({
        repositoryDirectory: REPO_DIR, pathPrefix: allowedPathPrefix(),
        testPath: regressionTestPath, maxPatchBytes: MAX_PATCH_BYTES,
        run: (cmd, timeoutMs) => command(activeSandbox, cmd, timeoutMs, REPO_DIR),
        files: {
          read: path => activeSandbox.files.read(path),
          write: (path, content) => activeSandbox.files.write(path, content),
        },
      });
      if (!regression.ok) return failure(request, regression.reason, regression.message,
        regression.output ? redacted(regression.output, provider) : undefined);
      incidentBaseline = regression.baseline;
    }

    await emit('verification', 'stage', 'Re-running the reproduction, project tests, and build');
    await emit('verification', 'tool_input', `Verification commands\n${request.reproduceCommand}\n${request.testCommand}\n${request.buildCommand}`);
    const repro = await command(sandbox, `export PATH="$HOME/.bun/bin:$PATH"; ${request.reproduceCommand}`, 120_000, REPO_DIR);
    await emit('reproduction', 'tool_output', `Repro · exit ${repro.exitCode}\n${repro.stdout}\n${repro.stderr}`);
    if (repro.exitCode !== 0) return failure(request, 'test_failed', 'Reproduction still fails after the patch', redacted(repro.stderr || repro.stdout, provider));
    const tests = await command(sandbox, `export PATH="$HOME/.bun/bin:$PATH"; ${request.testCommand}`, 120_000, REPO_DIR);
    await emit('verification', 'tool_output', `Tests · exit ${tests.exitCode}\n${tests.stdout}\n${tests.stderr}`);
    if (tests.exitCode !== 0) return failure(request, 'test_failed', 'Project tests failed after the patch', redacted(tests.stderr || tests.stdout, provider));
    const build = await command(sandbox, `export PATH="$HOME/.bun/bin:$PATH"; ${request.buildCommand}`, 120_000, REPO_DIR);
    await emit('verification', 'tool_output', `Build · exit ${build.exitCode}\n${build.stdout}\n${build.stderr}`);
    if (build.exitCode !== 0) return failure(request, 'build_failed', 'Project build failed after the patch', redacted(build.stderr || build.stdout, provider));

    // Stage only the demo target. Never return provider config, tokens, or edits elsewhere.
    await checked(sandbox, `git add -A -- ${allowedPathPrefix()}`, 15_000, REPO_DIR);
    const staged = await checked(sandbox, 'git diff --cached --name-only -z', 15_000, REPO_DIR);
    validateChangedFiles(staged.stdout.split('\0').filter(Boolean));
    const diff = await checked(sandbox, 'git diff --cached --binary --no-ext-diff HEAD', 20_000, REPO_DIR);
    if (!diff.stdout || Buffer.byteLength(diff.stdout) > MAX_PATCH_BYTES) return failure(request, 'unsafe_patch', 'Patch is empty or exceeds 256 KiB');
    if (diff.stdout.includes(provider.apiKey) || (provider.githubReadToken && diff.stdout.includes(provider.githubReadToken))) {
      return failure(request, 'unsafe_patch', 'Patch contains a controller-provided secret');
    }
    if (/^(?:new file mode|deleted file mode) 120000$/m.test(diff.stdout) || diff.stdout.includes('GIT binary patch')) {
      return failure(request, 'unsafe_patch', 'Symlinks and binary patches require human review');
    }
    await emit('patch', 'tool_output', `Verified code diff\n${diff.stdout}`);
    await emit('patch', 'summary', `Verified fix ready\nChanged files:\n${changedFiles.map(path => `- ${path}`).join('\n')}\n\nThe incident reproduction, project tests, and build passed. The controller will publish the pull request.`);
    return {
      ok: true,
      incidentId: request.incidentId,
      baseSha: head,
      patch: diff.stdout,
      changedFiles,
      baseline: redacted(incidentBaseline ? incidentBaseline.stderr || incidentBaseline.stdout : baseline.stderr || baseline.stdout, provider),
      agentSummary: `Supercharge completed ${parser.toolCalls} tool calls. Redacted messages, tool inputs/results, verification, and patch are saved in the activity transcript.`,
      testOutput: redacted(`${repro.stdout}\n${tests.stdout}\n${tests.stderr}`, provider),
      buildOutput: redacted(`${build.stdout}\n${build.stderr}`, provider),
      mcpConfigured: Boolean(provider.githubReadToken),
    };
  } catch (error) {
    // Never surface command arguments or config files in error text.
    await emit('sandbox', 'status', 'Sandbox or verification failed; recording the fix attempt error');
    return failure(request, 'sandbox_error', 'Sandbox setup, execution, or verification failed', redacted(String(error), provider));
  } finally {
    if (sandbox) await sandbox.kill().catch(() => undefined);
  }
}
