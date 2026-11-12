# Shared incident contract — Ronit

`src/index.ts` exports the shared `Incident` and `IncidentEvent` types, state unions, and the controller-to-remediator request/result boundary. Import incident types from `@nexathon/contracts`; the notifier and dashboard use this package as their shared source of truth.

The controller persists incidents with evidence and ordered event history. Remediation requests include an explicit time budget, and results distinguish reproduction, test, build, and draft-PR outcomes. The remediator must not perform Vercel rollback; see the root README for the full safety contract.
