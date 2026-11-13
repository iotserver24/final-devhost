/**
 * Dependency and import policy for AI-generated patches.
 *
 * This is a guardrail, not a supply-chain security boundary. Static matching
 * cannot see dynamic imports, path aliases, transitive dependencies, or code in
 * another language. Anything it cannot prove is rejected for human review.
 */

export interface DependencyPolicy {
  /** If non-empty, only these package names may be added. */
  allowed: string[];
  /** Always rejected, even if also present in `allowed`. */
  denied: string[];
  /** Files that define the policy; a patch must never modify them. */
  protectedPaths: string[];
  /** Upper bound on dependencies added by one patch. */
  maxAddedDependencies: number;
  /** Package-name patterns always treated as suspicious. */
  suspiciousPatterns: RegExp[];
}

export interface Violation {
  kind: 'denied_dependency' | 'unlisted_dependency' | 'too_many_dependencies' | 'protected_path' | 'unresolvable_import';
  detail: string;
}

export const defaultPolicy: DependencyPolicy = {
  allowed: [],
  denied: [],
  protectedPaths: [
    'packages/remediator/src/dependency-policy.ts',
    'packages/remediator/src/validation.ts',
    'packages/remediator/src/pr-publisher.ts',
    '.dependency-policy.json',
    'config/dependency-policy.json',
  ],
  maxAddedDependencies: 2,
  suspiciousPatterns: [
    /^@?[a-z0-9-]*crypto-?min/i,
    /^(?:node-)?gyp$/i,
    /^preinstall-hook$/i,
    /^postinstall-/i,
  ],
};

const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'crypto', 'dns', 'events', 'fs', 'http', 'http2', 'https',
  'net', 'os', 'path', 'perf_hooks', 'process', 'querystring', 'readline', 'stream', 'string_decoder',
  'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
]);

function packageName(specifier: string): string | undefined {
  const trimmed = specifier.trim();
  if (!trimmed || trimmed.startsWith('.') || trimmed.startsWith('/')) return undefined;
  if (trimmed.startsWith('node:')) return undefined;
  const parts = trimmed.split('/');
  const name = trimmed.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (NODE_BUILTINS.has(name)) return undefined;
  return name || undefined;
}

/**
 * Read JSON config from a file path. Malformed config is an error, because
 * silently widening the allowlist would be worse than refusing to run.
 */
export function parsePolicyConfig(raw: string): DependencyPolicy {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('Dependency policy file is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Dependency policy must be a JSON object');
  const value = parsed as Record<string, unknown>;
  const names = (input: unknown, field: string): string[] => {
    if (input === undefined) return [];
    if (!Array.isArray(input) || input.some(item => typeof item !== 'string')) throw new Error(`Dependency policy field "${field}" must be an array of strings`);
    return input as string[];
  };
  const added = value.maxAddedDependencies;
  if (added !== undefined && (typeof added !== 'number' || !Number.isInteger(added) || added < 0 || added > 50)) {
    throw new Error('Dependency policy field "maxAddedDependencies" must be an integer between 0 and 50');
  }
  return {
    allowed: names(value.allowed, 'allowed'),
    denied: names(value.denied, 'denied'),
    protectedPaths: value.protectedPaths === undefined ? defaultPolicy.protectedPaths : names(value.protectedPaths, 'protectedPaths'),
    maxAddedDependencies: typeof added === 'number' ? added : defaultPolicy.maxAddedDependencies,
    suspiciousPatterns: defaultPolicy.suspiciousPatterns,
  };
}

/** Names of dependencies added by a package manifest hunk. */
export function addedDependencies(patch: string, manifestPaths: string[] = ['package.json']): string[] {
  const added = new Set<string>();
  let inManifest = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = / b\/(.+)$/.exec(line);
      const target = match?.[1] ?? '';
      inManifest = manifestPaths.some(path => target === path || target.endsWith(`/${path}`));
      continue;
    }
    if (!inManifest || !line.startsWith('+') || line.startsWith('+++')) continue;
    // Match `"name": "range"` entries in dependencies/devDependencies blocks.
    const match = /^\+\s*"(@?[^"/\s]+(?:\/[^"/\s]+)?)"\s*:\s*"([^"]*)"/.exec(line);
    if (!match) continue;
    const [, name, version] = match;
    if (name === 'name' || name === 'version' || name === 'main' || name === 'types') continue;
    if (/^(?:file:|git\+|https?:\/\/|link:)/i.test(version)) {
      added.add(`${name} (${version})`);
      continue;
    }
    added.add(name);
  }
  return [...added];
}

/** Bare package specifiers imported by added lines in changed files. */
export function addedImports(patch: string): { path: string; specifier: string; package: string }[] {
  const results: { path: string; specifier: string; package: string }[] = [];
  let currentPath = '';
  const importPatterns = [
    /^\+\s*import\s[^\n]*?from\s+['"]([^'"]+)['"]/,
    /^\+\s*import\s+['"]([^'"]+)['"]/,
    /^\+\s*(?:const|let|var)\s[^\n]*?require\(\s*['"]([^'"]+)['"]\s*\)/,
    /^\+\s*export\s[^\n]*?from\s+['"]([^'"]+)['"]/,
    // Dynamic import can appear anywhere in an added line.
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/,
  ];
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = / b\/(.+)$/.exec(line);
      currentPath = match?.[1] ?? '';
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    for (const pattern of importPatterns) {
      const match = pattern.exec(line);
      if (!match?.[1]) continue;
      const name = packageName(match[1]);
      if (name) results.push({ path: currentPath, specifier: match[1], package: name });
      break;
    }
  }
  return results;
}

/**
 * Evaluate a patch against the policy. Returns every violation; an empty list
 * means the patch may proceed to the existing validation steps.
 */
export function checkPatch(patch: string, policy: DependencyPolicy = defaultPolicy): Violation[] {
  const violations: Violation[] = [];

  // 1. The patch must not modify the policy itself.
  for (const line of patch.split('\n')) {
    const match = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
    if (!match) continue;
    for (const path of [match[1], match[2]]) {
      if (policy.protectedPaths.some(protectedPath => path === protectedPath || path.endsWith(`/${protectedPath}`))) {
        violations.push({ kind: 'protected_path', detail: `Patch modifies policy-protected file ${path}` });
      }
    }
  }

  // 2. New dependencies.
  const dependencies = addedDependencies(patch);
  if (dependencies.length > policy.maxAddedDependencies) {
    violations.push({
      kind: 'too_many_dependencies',
      detail: `Patch adds ${dependencies.length} dependencies; the limit is ${policy.maxAddedDependencies}`,
    });
  }
  for (const dependency of dependencies) {
    const bare = dependency.replace(/\s*\(.*\)$/, '');
    if (policy.denied.some(name => name === bare)) {
      violations.push({ kind: 'denied_dependency', detail: `Dependency "${bare}" is on the denylist` });
      continue;
    }
    if (policy.suspiciousPatterns.some(pattern => pattern.test(bare))) {
      violations.push({ kind: 'denied_dependency', detail: `Dependency "${bare}" matches a suspicious install-hook pattern` });
      continue;
    }
    if (policy.allowed.length > 0 && !policy.allowed.includes(bare)) {
      violations.push({ kind: 'unlisted_dependency', detail: `Dependency "${bare}" is not on the allowlist` });
    }
    if (/\s*\((?:file:|git\+|https?:\/\/|link:)/i.test(dependency)) {
      violations.push({ kind: 'unlisted_dependency', detail: `Dependency "${dependency}" uses a remote or local reference` });
    }
  }

  // 3. New imports from packages that are not already declared.
  for (const entry of addedImports(patch)) {
    if (policy.denied.some(name => name === entry.package)) {
      violations.push({ kind: 'denied_dependency', detail: `Import of "${entry.package}" in ${entry.path} is on the denylist` });
      continue;
    }
    if (policy.suspiciousPatterns.some(pattern => pattern.test(entry.package))) {
      violations.push({ kind: 'denied_dependency', detail: `Import of "${entry.package}" in ${entry.path} matches a suspicious pattern` });
      continue;
    }
    if (policy.allowed.length > 0 && !policy.allowed.includes(entry.package)) {
      violations.push({ kind: 'unlisted_dependency', detail: `Import of "${entry.package}" in ${entry.path} is not on the allowlist` });
    }
  }

  return violations;
}

export function describeViolations(violations: Violation[]): string {
  return violations.map(violation => `- ${violation.kind}: ${violation.detail}`).join('\n');
}