import { describe, expect, test } from 'bun:test';
import { addedDependencies, addedImports, checkPatch, defaultPolicy, parsePolicyConfig } from '../src/dependency-policy';
import { assertDependencyPolicy, validatePatch } from '../src/pr-publisher';

const manifestPatch = (added: string[]) => [
  'diff --git a/apps/sample/package.json b/apps/sample/package.json',
  '--- a/apps/sample/package.json',
  '+++ b/apps/sample/package.json',
  '@@ -10,6 +10,8 @@',
  '   "dependencies": {',
  ...added.map(line => `+    ${line}`),
  '   }',
  '',
].join('\n');

const sourcePatch = (imports: string[]) => [
  'diff --git a/apps/sample/src/lib/tasks.ts b/apps/sample/src/lib/tasks.ts',
  '--- a/apps/sample/src/lib/tasks.ts',
  '+++ b/apps/sample/src/lib/tasks.ts',
  '@@ -1,2 +1,8 @@',
  ...imports.map(line => `+${line}`),
  ' export const x = 1;',
  '',
].join('\n');

const allowedPrefix = { env: process.env.REMEDIATOR_ALLOWED_PATH_PREFIX };

describe('dependency policy: manifest changes', () => {
  test('detects added dependencies', () => {
    const patch = manifestPatch(['"left-pad": "^1.0.0"', '"lodash": "^4.17.21"']);
    expect(addedDependencies(patch).sort()).toEqual(['left-pad', 'lodash']);
  });

  test('an empty allowlist does not block ordinary dependencies', () => {
    expect(checkPatch(manifestPatch(['"zod": "^3.0.0"']))).toEqual([]);
  });

  test('a non-empty allowlist rejects unlisted dependencies', () => {
    const policy = { ...defaultPolicy, allowed: ['zod'] };
    const violations = checkPatch(manifestPatch(['"evil-pkg": "^1.0.0"']), policy);
    expect(violations.some(v => v.kind === 'unlisted_dependency')).toBe(true);
    expect(checkPatch(manifestPatch(['"zod": "^3.0.0"']), policy)).toEqual([]);
  });

  test('denylisted dependencies are always rejected', () => {
    const policy = { ...defaultPolicy, denied: ['evil-pkg'] };
    const violations = checkPatch(manifestPatch(['"evil-pkg": "^1.0.0"']), policy);
    expect(violations.some(v => v.kind === 'denied_dependency')).toBe(true);
  });

  test('remote and local dependency references require review', () => {
    expect(checkPatch(manifestPatch(['"thing": "git+https://github.com/x/y.git"'])).some(v => v.kind === 'unlisted_dependency')).toBe(true);
  });

  test('too many added dependencies is rejected', () => {
    const policy = { ...defaultPolicy, maxAddedDependencies: 1 };
    const violations = checkPatch(manifestPatch(['"a": "1"', '"b": "1"']), policy);
    expect(violations.some(v => v.kind === 'too_many_dependencies')).toBe(true);
  });
});

describe('dependency policy: imports', () => {
  test('finds bare package imports and ignores relative and builtin ones', () => {
    const patch = sourcePatch([
      "import { readFile } from 'node:fs/promises';",
      "import { helper } from './helper';",
      "import { z } from 'zod';",
      "const y = require('left-pad');",
    ]);
    const packages = addedImports(patch).map(entry => entry.package);
    expect(packages).toContain('zod');
    expect(packages).toContain('left-pad');
    expect(packages).not.toContain('node:fs/promises');
    expect(packages.some(name => name.startsWith('.'))).toBe(false);
  });

  test('denylisted import is rejected', () => {
    const policy = { ...defaultPolicy, denied: ['left-pad'] };
    const violations = checkPatch(sourcePatch(["const pad = require('left-pad');"]), policy);
    expect(violations.some(v => v.kind === 'denied_dependency')).toBe(true);
  });

  test('allowlist applies to imports as well as manifests', () => {
    const policy = { ...defaultPolicy, allowed: ['zod'] };
    expect(checkPatch(sourcePatch(["import { z } from 'zod';"]), policy)).toEqual([]);
    expect(checkPatch(sourcePatch(["import _ from 'lodash';"]), policy).some(v => v.kind === 'unlisted_dependency')).toBe(true);
  });

  test('dynamic import() is inspected, but aliases and indirect deps are not resolvable', () => {
    expect(checkPatch(sourcePatch(["const mod = await import('left-pad');"]), { ...defaultPolicy, denied: ['left-pad'] }).length).toBeGreaterThan(0);
    // Documented limitation: a path alias is not a package and passes through.
    expect(checkPatch(sourcePatch(["import { x } from '@/lib/x';"]))).toEqual([]);
  });
});

describe('dependency policy: tamper resistance', () => {
  test('a patch touching the policy file is rejected', () => {
    const patch = [
      'diff --git a/packages/remediator/src/dependency-policy.ts b/packages/remediator/src/dependency-policy.ts',
      '--- a/packages/remediator/src/dependency-policy.ts',
      '+++ b/packages/remediator/src/dependency-policy.ts',
      '@@ -1 +1 @@',
      '-const denied = [];',
      '+const denied = []; // now empty',
      '',
    ].join('\n');
    const violations = checkPatch(patch);
    expect(violations.some(v => v.kind === 'protected_path')).toBe(true);
  });
});

describe('dependency policy: config parsing', () => {
  test('parses a valid policy file', () => {
    const policy = parsePolicyConfig(JSON.stringify({ allowed: ['zod'], denied: ['evil'], maxAddedDependencies: 0 }));
    expect(policy.allowed).toEqual(['zod']);
    expect(policy.denied).toEqual(['evil']);
    expect(policy.maxAddedDependencies).toBe(0);
  });

  test('malformed config is fatal rather than silently permissive', () => {
    expect(() => parsePolicyConfig('not json')).toThrow();
    expect(() => parsePolicyConfig(JSON.stringify({ allowed: 'zod' }))).toThrow();
    expect(() => parsePolicyConfig(JSON.stringify({ maxAddedDependencies: -1 }))).toThrow();
  });
});

describe('dependency policy is enforced by the existing patch validation', () => {
  test('validatePatch rejects a policy violation in an otherwise valid patch', () => {
    const original = process.env.REMEDIATOR_ALLOWED_PATH_PREFIX;
    process.env.REMEDIATOR_ALLOWED_PATH_PREFIX = 'apps/sample/';
    try {
      const badPatch = manifestPatch(['"a": "1"', '"b": "1"', '"c": "1"']);
      expect(() => validatePatch(badPatch)).toThrow(/Dependency policy/);
      expect(() => assertDependencyPolicy(manifestPatch(['"zod": "^3"']))).not.toThrow();
    } finally {
      if (original === undefined) delete process.env.REMEDIATOR_ALLOWED_PATH_PREFIX;
      else process.env.REMEDIATOR_ALLOWED_PATH_PREFIX = original;
    }
  });
});