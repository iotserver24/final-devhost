# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are local demo operators and developers investigating a broken deployment. They need to confirm what failed, understand the evidence, and see whether Sentinel rolled back safely or opened a draft pull request.

## Product Purpose

Sentinel puts deployment probes, deployment revisions, incident decisions, recovery status, and safe agent activity in one local control room. Success means an operator can orient within seconds and configure the monitored Vercel project without editing source files.

## Positioning

The dashboard is evidence-first: it shows the controller's bounded evidence and safety decision rather than pretending to be a general observability platform.

## Operating Context

The controller runs locally, the dashboard is authenticated, and one explicitly configured Vercel project is monitored. The operator may connect Vercel with OAuth or enter a project-scoped access token in the dashboard.

## Capabilities and Constraints

- Incidents, evidence, timeline, rollback/PR action, live agent activity, and watch health remain the core workflows.
- Integration settings are stored by the controller and monitoring changes require a controller restart.
- Secret values are write-only from the dashboard: they may be entered, but are never returned as cleartext.
- The dashboard is dark-mode only for this redesign.

## Product Principles

- Evidence before explanation.
- Safe actions are visible and bounded.
- Configuration should be possible without editing `.env` files.
- A local tool should feel calm, precise, and honest about its state.
