# Continuity Agent Build Roadmap

## Delivery rule

Build one usable, tested layer at a time. The product remains local-first and zero-cost during the foundation phases: no mandatory cloud account, paid model API, hosted database, or external monitoring service.

## 1. System design — now

Define the user journeys, project boundaries, data classification, safety rules, model-routing policy, and success measures. The source of truth is the project problem statement and model classification.

**Exit gate:** documented requirements, threat model, task/checkpoint lifecycle, and acceptance criteria for the first working release.

## 2. System architecture

Define modules and their authority boundaries: UI, local API, policy engine, agent orchestrator, provider adapters, tool sandbox, state store, codebase index, and audit log.

**Exit gate:** an architecture diagram plus contracts for task state, checkpoints, tool calls, and provider adapters.

## 3. Frontend

Develop the command center, local-model onboarding, task timeline, plan view, change review, checkpoint recovery, policy settings, and accessible responsive behavior.

**Exit gate:** a user can understand active model, safety boundary, progress, checkpoint, and recovery state without reading logs.

## 4. APIs and backend logic

Implement local HTTP endpoints, task state machine, server-sent progress events, safe task execution, retry classification, and model handoff orchestration.

**Exit gate:** a local task can run, pause, resume, and switch to an allowed fallback without losing recorded state.

## 5. Database and storage

Migrate durable state from early JSON files to SQLite. Store tasks, steps, checkpoints, policies, model health, tool action ledger, indexed metadata, and audit records with integrity checks.

**Exit gate:** restart recovery is deterministic and actions are never accidentally repeated.

## 6. Authentication and permissions

Start as a secure single-user local application. Add local session protection, scoped project permissions, parameter-bound approvals, secret storage through the operating system, and role boundaries before any shared/team mode.

**Exit gate:** an agent cannot expand its authority, leave the approved project, access a secret, write a file, or make an external request without the applicable policy.

## 7. Hosting and cloud

Keep local desktop/self-hosted deployment as the default. Only add optional cloud hosting after the local app is stable; keep provider integrations opt-in and user-funded.

**Exit gate:** a deployable local package and a documented optional cloud model that does not weaken privacy or budget controls.

## 8. CI/CD and version control

Initialize a Git repository, add automated checks, security scanning, release notes, reproducible builds, and signed/reviewed release artifacts.

**Exit gate:** every change is tested before release and can be traced and rolled back.

## 9. Security

Harden sandbox isolation, trust boundaries, prompt-injection controls, output validation, secret redaction, dependency security, audit logs, and adversarial tests.

**Exit gate:** the security abuse-case suite passes, including path escape, command injection, memory poisoning, approval bypass, and data-exfiltration attempts.

## 10. Rate limiting

Apply local limits to agent steps, tool chains, retries, token budgets, elapsed time, concurrency, and optional provider requests. Respect provider limits rather than working around them.

**Exit gate:** no runaway loop can exhaust local resources or incur unapproved cost.

## 11. Caching and CDN

For the local app, cache code index data, model capability catalogues, and safe context summaries. A CDN is only relevant when a public web deployment is intentionally introduced.

**Exit gate:** repeated local operations are faster without persisting secrets or stale unsafe context.

## 12. Error tracking and logs

Implement structured local logs, safe error messages, model/provider failure classification, tool-action audit records, and user-facing recovery options.

**Exit gate:** every failed task has a readable cause, last known safe checkpoint, and recovery choice.

## 13. Monitoring and alerts

Begin with local health dashboards for runtime status, disk space, model availability, task failures, sandbox failures, and resource use. Add optional external alerts only with explicit user configuration.

**Exit gate:** failures are visible before they silently corrupt or stall a workflow.

## 14. Testing

Add unit, integration, end-to-end, agent-hand-off, security, and failure-injection tests. The test runner, not an AI model, decides whether code is accepted.

**Exit gate:** key flows pass automatically: local setup, tool denial, checkpoint resume, model fallback, task completion, and corrupted-state recovery.

## 15. Scaling

Only after a dependable local release: concurrent task queues, self-hosted multi-user mode, isolated workers, resource scheduling, and optional enterprise controls.

**Exit gate:** increased concurrency does not weaken isolation, reliability, or user control.

## Current position

System design is complete and system architecture is documented. The initial frontend and local backend are prototypes; they will be refined against the architecture contracts rather than expanded randomly.
