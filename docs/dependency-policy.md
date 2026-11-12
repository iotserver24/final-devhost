# Dependency and import policy for AI patches

`packages/remediator/src/dependency-policy.ts` enforces a policy on patches the
agent produces. It runs inside `validatePatch`, which the trusted controller
calls before publishing a pull request, so a violating patch never reaches
GitHub.

## Checks

1. **Policy tampering.** Any patch touching a protected file
   (`dependency-policy.ts`, `validation.ts`, `pr-publisher.ts`,
   `.dependency-policy.json`) is rejected.
2. **Manifest additions.** Added entries in any `package.json` hunk are
   extracted. Denylisted names always fail. When an allowlist is configured,
   unlisted names fail. Remote or local references
   (`git+`, `file:`, `link:`, `https://`) always require review.
3. **New imports.** Added `import … from 'pkg'`, `require('pkg')`, dynamic
   `import('pkg')`, and `export … from 'pkg'` lines are checked against the same
   lists. Relative paths and Node builtins are ignored.
4. **Volume.** More than `maxAddedDependencies` (default 2) new dependencies in
   one patch is rejected.

The existing repository and subtree boundary, binary/symlink rejection, rename
rejection, 40-file cap, and 256 KiB patch cap all still apply first.

## Configuration

Default policy: no allowlist (existing imports are permitted), no denylist, two
added dependencies maximum, suspicious install-hook patterns always rejected.

To tighten it, write a JSON file and point the controller at it:

```json
{
  "allowed": ["zod", "nanoid"],
  "denied": ["event-stream", "left-pad"],
  "maxAddedDependencies": 1
}
```

```sh
REMEDIATOR_DEPENDENCY_POLICY_FILE=/etc/sentinel/dependency-policy.json
```

A malformed policy file is fatal for patch validation: silently widening the
allowlist would be worse than refusing to publish. The file must be readable by
the controller process and must not be writable by the agent (it is outside the
agent's patch subtree by design).

## Limitations (do not overstate)

- **Dynamic and computed imports** are matched only when the specifier is a
  literal string. `import(someVariable)` or a specifier assembled at runtime is
  invisible.
- **Path aliases** (`@/lib/x`) look like packages but are not; they pass through.
  Configure the alias roots as relative paths if you need them checked.
- **Transitive dependencies** are not inspected. Allowing package A does not
  inspect A's own dependencies.
- **Other languages and ecosystems** (`Cargo.toml`, `go.mod`, `requirements.txt`)
  are not parsed. This policy understands JavaScript/TypeScript `package.json`
  and import syntax only.
- **JSON parsing is heuristic.** The manifest check reads added diff lines with
  a regular expression rather than parsing JSON; unusual formatting can produce
  a false positive (extra review) but was not observed to produce a false
  negative for standard `"name": "range"` entries.
- This is a guardrail against careless or manipulated patches, **not** a
  supply-chain security boundary. It does not verify package provenance,
  integrity, or publisher identity.

## Tests

`packages/remediator/test/dependency-policy.test.ts` covers allowed, denied, and
unlisted imports; manifest additions; remote references; the volume cap; policy
tampering; malformed configuration; and enforcement through `validatePatch`.

```sh
bun test packages/remediator/test/dependency-policy.test.ts
```