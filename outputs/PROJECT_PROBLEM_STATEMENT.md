# Continuity-First Multi-Model Software Engineering Agent

## Problem statement

AI software-engineering tools can stop mid-task because a model reaches a usage limit, is overloaded, becomes unavailable, lacks a required capability, loses context, or fails during tool execution. Users then have to choose another model manually, repeat context, recover unfinished edits, and decide whether the previous work is safe to continue.

This project will build a secure, model-agnostic software-engineering workspace that preserves task progress and automatically resumes work with another **user-approved** AI model whenever the current one cannot continue. The platform will work with local models, permitted cloud providers, and future provider adapters. It will not bypass provider terms, quotas, billing controls, or privacy rules.

The product promise is:

> The platform automatically preserves, verifies, and resumes work across approved AI models whenever possible—without losing control of cost, privacy, or security.

It must not promise that every task will always finish. All approved models may be unavailable, budgets may be exhausted, or a task may require human judgment.

## Product outcomes

- A user can open a project, describe a goal, and watch the agent plan and execute small, inspectable steps.
- A temporary model failure, rate limit, timeout, or availability problem does not discard progress.
- The platform checkpoints project state before meaningful mutations and resumes from the next safe step.
- Model changes happen automatically within preconfigured cost, privacy, and provider rules.
- The user sees a clear notification, for example: `Now working with Claude Sonnet. GPT-5 reached its configured usage limit. Progress was saved at checkpoint 14 and verified before resuming.`
- High-impact actions remain governed by user approval even when model switching is automatic.

## Core architecture

1. **Workspace** — project files, task chat, user preferences, policy controls, and a task timeline.
2. **Orchestrator** — plans one small step at a time; observes tool results; verifies progress; saves checkpoints; retries, falls back, pauses, or asks the user when appropriate.
3. **Model router** — selects a model according to capabilities, health, context requirements, provider privacy permissions, user preference, budget, and fallback order.
4. **Provider adapters** — local runtimes, permitted cloud APIs, and OpenAI-compatible endpoints behind one stable internal interface.
5. **Sandboxed tools** — limited filesystem, terminal, test, git, and browser capabilities controlled by a policy engine independent of the AI model.
6. **Persistent state** — durable task graph, checkpoint records, decisions, tool-action ledger, test results, diffs, artifacts, and audit events.
7. **Codebase context service** — fast text/file search first; optional embeddings later; sends only relevant, policy-approved context to a model.
8. **User interface** — task map, active model, switch reason, checkpoint timeline, cost/privacy status, proposed changes, tool output, and recovery controls.

## Model continuity requirements

### Checkpoint before handoff

Every meaningful step must create a model-independent checkpoint containing:

- original goal, constraints, and user decisions;
- current plan, completed work, and exact proposed next action;
- changed-file hashes, git diff, and artifact references;
- executed commands, tool results, test results, errors, and unresolved issues;
- allowed permissions, provider rules, remaining time, token, and cost budgets.

### Handoff packet and validation

A fallback model receives a compact structured handoff packet, relevant code context, and a summary generated from verified project state. Before continuing, it must validate workspace state and confirm the next safe action. The platform, not the model, decides whether the checkpoint and permissions are valid.

### Fallback algorithm

1. Detect and classify the failure: transient throttling, overload, timeout, quota/spend cap, unavailable model, capability mismatch, or invalid request.
2. For transient errors, use provider guidance with bounded backoff, jitter, total-time limits, and circuit breakers.
3. Never retry hard quota, billing, credential, privacy-policy, or invalid-request failures as though they were temporary.
4. Select the best compatible model in the user-approved fallback order.
5. Reserve the expected cost and verify data-sharing and capability rules.
6. Validate the handoff state; resume from the next safe action.
7. Show the model-switch notice and record the event in the task timeline.
8. Pause with a plain-language recovery action if no permitted fallback can safely continue.

### Automatic-switch policy

Automatic switching is allowed for ordinary failures when the next model is already approved by policy. The user configures once:

- allowed providers and models;
- preferred model and fallback order;
- local-only or cloud-permitted project mode;
- allowed data classifications per provider;
- maximum spend per task, day, and month;
- whether a more expensive model may be selected automatically;
- capability requirements such as coding, vision, browser use, long context, or fast review.

The platform must pause rather than silently switch when the fallback would exceed budget, use an unapproved provider, transmit restricted code/data, or require a new high-impact permission.

## Security requirements

### Authority separation

The AI model proposes actions. A separate, non-AI policy engine authorizes and executes them. The model must never receive unrestricted host shell access, unrestricted filesystem access, credentials, or the ability to change its own security policy.

### Least privilege and isolation

- Run tools in a disposable non-root sandbox or micro-VM.
- Mount only the approved project directory; deny host filesystem access.
- Deny network access by default; allow approved destinations only when needed.
- Use small capability-based tools instead of a universal unrestricted command tool.
- Allowlist paths, operations, commands, domains, and destinations.
- Treat deletion, package installation, deployment, publishing, secret access, database writes, and external communication as high-impact actions requiring parameter-bound, expiring approval.

### Prompt-injection, memory, and output protections

- Treat websites, repositories, documents, tool output, API responses, and user-provided artifacts as untrusted data—not policy or executable authority.
- Delimit and sanitize untrusted content before model context construction.
- Validate, isolate, expire, and integrity-protect persistent memory.
- Validate structured model outputs before tools receive them.
- Never let model output decide authorization.
- Limit tool-chain depth, retries, tokens, runtime, and spending to prevent runaway loops and denial-of-wallet attacks.

### Privacy and secrets

- Keep provider credentials in the operating-system keychain or a secrets manager, never in prompts, logs, or project files.
- Classify data before each model request; redact or withhold secrets and restricted information.
- Encrypt sensitive persisted state, minimize retention, and offer clear deletion controls.
- Provide a genuine local-only/offline mode with no silent cloud fallback.
- Keep per-provider data-sharing permissions visible and enforce them at request construction time.

### Auditability and secure delivery

- Record structured audit events for policy decisions, model changes, tool calls, diffs, approvals, denials, checkpoints, and errors.
- Provide a human-readable task timeline and recoverable checkpoints.
- Use signed updates, dependency scanning, software-bill-of-materials generation, vulnerability monitoring, and regular security reviews.
- Maintain adversarial tests for prompt injection, tool abuse, approval bypass, memory poisoning, data exfiltration, privilege escalation, cascading agent failures, and runaway execution.

## Reliability and quality requirements

- Use idempotency keys and a tool-action ledger so retries or handoffs do not repeat completed work.
- Verify state using file hashes, diffs, tests, linting, type checks, and task-specific acceptance checks.
- Classify models by tested capabilities rather than assuming they are interchangeable.
- Use small changes and frequent checkpoints rather than long unverified autonomous runs.
- Preserve complete authoritative state locally; generate targeted context summaries for models with smaller context windows.
- Expose model health, context limits, active budget, reason for routing, and recovery options in the UI.
- Use separate model roles only after the single-agent core is reliable; enforce trust boundaries and circuit breakers between agents.

## Drawbacks that remain

- No system can ensure that an appropriate approved model is always available or affordable.
- Fallback models can be weaker, slower, or less context-capable than the original model.
- Cloud use involves provider availability, pricing, policy changes, and approved data transfer.
- Local performance depends on the user's hardware.
- Strong terminal, browser, and deployment capabilities retain residual risk even with sandboxing and approvals.
- Provider adapters, security controls, evaluation suites, and operating-system support require continuous maintenance.

These are accepted residual risks. The platform must make them visible, controlled, and recoverable rather than hiding them.

## MVP boundaries

The first release will include a TypeScript backend, React interface, SQLite persistent state, a local model runtime adapter, an OpenAI-compatible provider adapter, a secure project-scoped file/terminal/test tool set, checkpointing, retry/fallback routing, cost/privacy policy controls, and a model-switch/recovery timeline.

Browser automation, advanced embeddings, parallel specialist agents, deployment automation, and broad provider coverage are later phases, added only after the core agent loop and security controls are dependable.

## Provider and market integration policy

The platform will use permitted model APIs, self-hosted/local runtimes, and official managed-worker APIs. It will dynamically discover available models and their capabilities rather than claiming a static list of every model in the market. Consumer AI coding products are competitors or optional explicit integrations; their consumer subscriptions must not be automated, scraped, or used as hidden fallback engines. The detailed provider catalogue, phased integration plan, and non-negotiable routing safeguards are maintained in [AI Model and Agent Market Map](AI_MODEL_AND_AGENT_MARKET_MAP.md). The task-by-task accuracy/efficiency classes, construction-phase fallback pools, and live evaluation method are maintained in [Model and Agent Classification for Building the Platform](BUILD_MODEL_CLASSIFICATION.md).

## Ordered delivery plan

The project is built in the documented sequence of system design, system architecture, frontend, backend APIs, durable storage, permissions, deployment, delivery automation, security, rate limits, caching, logs, monitoring, testing, and scaling. Each phase has a concrete exit gate and preserves the zero-cost, local-first foundation until optional cloud features are intentionally introduced. See [Build Roadmap](BUILD_ROADMAP.md).
