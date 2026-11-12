import type { ProviderConfig, RemediationRequest } from './types.js';

const DEFAULT_REPOSITORY = 'iotserver24/nexathon';
const DEFAULT_PATH_PREFIX = 'apps/sample/';
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const PREFIX_PATTERN = /^(?:[A-Za-z0-9._-]+\/)+$/;
const FORBIDDEN_SEGMENTS = /(^|\/)(?:node_modules|\.git|\.supercharge|dist|build|coverage|\.next)(\/|$)|(^|\/)(?:\.env(?:\.|$)|.*\.(?:pem|key)$)/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function envValue(name: string, fallback: string, pattern: RegExp, label: string): string {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  if (!pattern.test(value)) throw new Error(`${name} is not a valid ${label}`);
  return value;
}

/**
 * The one repository remediation may touch. Overriding it still names a single
 * exact repository; there is no wildcard form.
 */
export function allowedRepository(): string {
  return envValue('REMEDIATOR_ALLOWED_REPOSITORY', DEFAULT_REPOSITORY, REPOSITORY_PATTERN, 'owner/name repository');
}

/** The one subtree patches may touch, relative to the repository root. */
export function allowedPathPrefix(): string {
  return envValue('REMEDIATOR_ALLOWED_PATH_PREFIX', DEFAULT_PATH_PREFIX, PREFIX_PATTERN, 'subdirectory prefix');
}

export function validateRequest(request: RemediationRequest, repository = allowedRepository()): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(request.incidentId)) throw new Error('Invalid incident ID');
  if (request.repository !== repository) throw new Error('Repository is not allowlisted');
  if (!/^[0-9a-f]{40}$/i.test(request.commitSha)) throw new Error('A full 40-character commit SHA is required');
  for (const command of [request.setupCommand, request.reproduceCommand, request.testCommand, request.buildCommand]) {
    if (!command || command.length > 500 || /[\0\r\n]/.test(command)) throw new Error('Invalid project command');
  }
  if (!Array.isArray(request.evidence) || request.evidence.length > 20 || request.evidence.some((line) => typeof line !== 'string' || line.length > 1000)) {
    throw new Error('Evidence must be redacted and bounded');
  }
  if (request.runtimeLogs !== undefined && (!Array.isArray(request.runtimeLogs)
    || request.runtimeLogs.some(line => typeof line !== 'string')
    || Buffer.byteLength(JSON.stringify(request.runtimeLogs)) > 5_000_000)) {
    throw new Error('Runtime logs must be redacted strings totaling at most 5 MB; logs were not silently truncated');
  }
  if (request.reproductionFixture) {
    const { path, content } = request.reproductionFixture;
    const fixturePattern = new RegExp(`^${escapeRegExp(allowedPathPrefix())}tests/[A-Za-z0-9._/-]+\\.test\\.ts$`);
    if (typeof path !== 'string' || !fixturePattern.test(path) || path.includes('..') || FORBIDDEN_SEGMENTS.test(path)) {
      throw new Error(`Reproduction fixture must be a safe ${allowedPathPrefix()}tests/*.test.ts path`);
    }
    if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > 12_000) {
      throw new Error('Reproduction fixture must be nonempty and at most 12 KiB');
    }
  }
}

export function validateProvider(config: ProviderConfig): void {
  if (!config.modelId || !config.modelName || !config.apiKey) throw new Error('Dedicated Supercharge model credentials are required');
  if (!config.githubReadToken) throw new Error('Read-only GitHub MCP token is required');
  const url = new URL(config.baseUrl);
  if (url.protocol !== 'https:') throw new Error('Model provider base URL must use HTTPS');
  if (!['chat_completions', 'messages', 'responses'].includes(config.apiBackend)) throw new Error('Unsupported model API backend');
}

export function validateChangedFiles(paths: string[], prefix = allowedPathPrefix()): void {
  if (paths.length === 0) throw new Error('The agent produced no changed files');
  if (paths.length > 40) throw new Error('Too many changed files');
  for (const path of paths) {
    if (!path.startsWith(prefix) || path.includes('..') || FORBIDDEN_SEGMENTS.test(path)) {
      throw new Error(`Patch contains a disallowed path: ${path}`);
    }
  }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function truncate(value: string, max = 6000): string {
  return value.length > max ? `${value.slice(0, max)}\n[truncated]` : value;
}
