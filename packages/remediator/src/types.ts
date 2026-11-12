/** Controller-owned input. Commands are trusted project configuration, never raw alert text. */
export interface RemediationRequest {
  incidentId: string;
  repository: string; // owner/repo, allowlisted by REMEDIATOR_REPOSITORY
  commitSha: string; // full 40-character production/build SHA
  evidence: string[]; // redacted before calling this package
  runtimeLogs?: string[]; // complete redacted batch, including stack traces
  setupCommand: string;
  reproduceCommand: string;
  testCommand: string;
  buildCommand: string;
  /** Trusted regression test uploaded into E2B before baseline, included unchanged in the draft PR. */
  reproductionFixture?: { path: string; content: string };
}

export interface ProviderConfig {
  modelName: string;
  modelId: string;
  baseUrl: string;
  apiBackend: 'chat_completions' | 'messages' | 'responses';
  apiKey: string;
  githubReadToken: string;
}

export type RemediationFailure =
  | 'setup_failed'
  | 'not_reproducible'
  | 'agent_failed'
  | 'test_failed'
  | 'build_failed'
  | 'no_patch'
  | 'unsafe_patch'
  | 'sandbox_error';

export type RemediationResult =
  | {
      ok: true;
      incidentId: string;
      baseSha: string;
      patch: string;
      changedFiles: string[];
      baseline: string;
      agentSummary: string;
      testOutput: string;
      buildOutput: string;
      mcpConfigured: boolean;
    }
  | {
      ok: false;
      incidentId: string;
      reason: RemediationFailure;
      message: string;
      evidence?: string;
    };

export interface DraftPrResult {
  branch: string;
  url: string;
}
