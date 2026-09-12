# Model and Agent Classification for Building the Platform

## Purpose

This is a task-based operating plan for building the continuity-first multi-model engineering platform. It classifies major available model families and AI engineering tools by two factors:

- **Accuracy** — likelihood of producing a correct, verifiable result on a difficult task when given adequate context and tools.
- **Efficiency** — expected speed and cost efficiency for routine work; it is not merely token speed.

These are deployment recommendations, not a universal leaderboard. A model can be excellent at code repair but poor for a privacy-restricted project, a model may be fast only through a particular host, and benchmark results change with agent scaffolding. SWE-bench results must be compared only when agent environment, tool budget, and task set are comparable. The official SWE-bench site explicitly separates results by environment/agent; its Verified set is a human-filtered 500-instance subset. [SWE-bench leaderboards](https://www.swebench.com/).

The platform must run its own acceptance tests before promoting or demoting a model in this classification.

## Rating system

| Band | Accuracy meaning | Efficiency meaning |
|---|---|---|
| A | Preferred for difficult or security-sensitive work; verify results anyway. | Fast or economical enough for frequent use at the intended capability level. |
| B | Strong alternate; suitable after verification. | Good value for regular implementation and review. |
| C | Suitable for bounded, well-tested, or supporting work. | Useful where low cost/latency matters more than maximum reasoning quality. |
| D | Use only for narrow support tasks or experiments. | May be cheap/fast but not reliable enough for autonomous changes. |

## Model-family classification

“Current flagship” means the highest-current generally available coding/reasoning model in a provider family at the time the project checks the provider catalogue. Exact model IDs must be discovered dynamically; model lifecycles change. Gemini, Anthropic, OpenAI, OpenRouter, and other providers expose model lists/capability data that make this possible. [Gemini models](https://ai.google.dev/gemini-api/docs/models), [Anthropic models API](https://platform.claude.com/docs/en/models/overview), [OpenRouter models API](https://openrouter.ai/docs/guides/overview/models).

| Model family / access path | Accuracy | Efficiency | Best construction work | Use as automatic fallback? | Notes |
|---|---:|---:|---|---|---|
| OpenAI current flagship reasoning/coding family | A | B | System design, difficult implementation, debugging, code review, tool orchestration | Yes, if user enables provider/cost | Use exact stable model version, not a vague alias, for checkpoint reproducibility. |
| Anthropic Claude flagship / Sonnet-class family | A | B | Long-context implementation, refactors, requirements reasoning, UI/code review | Yes | Strong independent second opinion; select capability and context-compatible versions. |
| Google Gemini Pro-class family | A | B | Multimodal/UI analysis, architecture, repository understanding, coding | Yes | Prefer stable models in production; keep preview models opt-in only. |
| Google Gemini Flash-class family | B | A | Fast planning, code search summaries, routine edits, test interpretation, UI iteration | Yes, for compatible bounded work | Excellent speed/value tier; do not silently substitute for a difficult security decision. |
| OpenAI smaller/mini coding-reasoning family | B | A | Fast review, structured extraction, unit-test drafting, issue triage | Yes | Require test verification before accepting code changes. |
| Anthropic Haiku-class family | B | A | Classification, summarization, focused review, documentation, routine tool planning | Yes | Efficient support model; avoid using as sole authority for complex architecture. |
| xAI Grok frontier family | B | B | Independent reasoning/coding fallback and research-oriented tasks | Yes, after provider/privacy validation | Adds supply diversity; capability test before enabling. |
| Mistral Large / Codestral-class family | B | B | Code generation, multilingual work, European-provider option | Yes, after evaluation | Use direct or approved hosted access; score against internal TypeScript/security tasks. |
| DeepSeek reasoning/coding family | B | A | Cost-efficient reasoning and coding, optional local/hosted diversity | Yes, only under explicit data policy | Do not assume a hosted endpoint has the same privacy or latency as a local model. |
| Qwen Coder / Qwen reasoning family | B | A | Local or hosted coding, repository navigation, test generation | Yes, particularly local/private pool | One of the key open-weight families to benchmark on the target hardware. |
| GLM coding/reasoning family | B | A | Independent open/hosted coding fallback | Yes, after evaluation | Include in the dynamic catalogue; regional/data policy applies. |
| Kimi / Moonshot coding-reasoning family | B | B | Long-context and independent fallback evaluation | Pilot only | Promote only after internal handoff and tool-use testing. |
| MiniMax coding/reasoning family | B | A | Cost-sensitive code repair and agent experiments | Pilot only | Candidate efficient fallback; validate quality and terms before default routing. |
| GPT-OSS / other capable open-weight reasoning models | B | B-C | Self-hosted private work, planning, review | Yes, local pool | Hardware and quantization materially affect quality and speed. |
| Llama high-parameter instruction/coding family | B-C | B-C | General private/local fallback, RAG context work, review | Yes, local pool | Select a tool-capable instruct variant, not a base model. |
| Gemma current open family | B-C | A-B | Efficient local multimodal/support work | Yes, for bounded work | Good candidate for hardware-constrained workflows; verify tool-call reliability. |
| Phi small-model family | C | A | Classification, local summaries, lightweight code explanation | Yes, support-only | Not a primary autonomous implementation model. |
| Cohere Command/Rerank/embed family | B for retrieval | A | Codebase retrieval, reranking, enterprise search | Not for core coding handoff | Use to improve context quality rather than replace the coding agent. |
| Embedding/reranking models: Gemini Embedding, Nomic, BGE, mixedbread, Cohere Rerank | N/A | A | Indexing, relevant-file retrieval, deduplication | N/A | They do not write code; they reduce context loss for every handoff. |

Local availability varies by runtime. Ollama’s library currently lists tool/thinking/vision tags across families including Llama, Qwen, DeepSeek, Gemma, GPT-OSS, and Qwen Coder; this makes it useful for local discovery, but the project must test every installed version. [Ollama library](https://ollama.com/library).

## Engineering-agent tool classification

These are development environments or managed workers, not automatically interchangeable LLMs. Use official APIs/SDKs only, and pass patches/test evidence back through the platform’s own verification layer.

| Tool / agent family | Accuracy | Efficiency | Best role while building this project | Integration decision |
|---|---:|---:|---|---|
| Codex / OpenAI coding agent | A | B | Complex implementation, repository work, test/fix loops, design review | Primary human-supervised construction worker where authorized. |
| Claude Code | A | B | Long-horizon code changes, terminal-based implementation, independent review | Strong alternate worker; use its official CLI/SDK boundaries. |
| Cursor agent | A-B | A | Fast IDE-centered implementation and UI iteration | Use interactively as a developer tool; do not treat a consumer plan as a backend API. |
| Windsurf Cascade | A-B | A | Fast codebase iteration and IDE workflow | Use interactively or only through permitted official interfaces. |
| Devin | A-B | B | Managed, bounded feature tasks, migrations, PR-oriented work | Optional managed-worker adapter through its official API; verify all output locally. |
| GitHub Copilot coding agent / CLI / SDK | A-B | B | GitHub-centered tasks, PR workflows, test fixes | Optional official integration, especially for GitHub users. |
| Cline, Roo Code, Aider, OpenCode | B | A | Bring-your-own-model experimentation, local/open-model workflows | Valuable interoperability test targets and user-side clients, not mandatory backend dependencies. |
| Continue / VS Code extensions | B | A | IDE integrations and local-model access | Optional interface integration after the core desktop/web workspace works. |
| OpenHands / open-source agent frameworks | B-C | B | Research and controlled experiments | Treat as reference implementations; do not import their authority model without security review. |

Devin documents a managed-agent API, while GitHub documents a Copilot SDK/CLI that can use a user/organization’s permitted models. Both should be isolated as external workers rather than granted control of the platform. [Devin API](https://docs.devin.ai/api-reference/overview), [GitHub Copilot agents](https://docs.github.com/en/copilot/responsible-use/agents).

## Best model pools by construction phase

| Construction phase | Primary accuracy pool | Efficiency pool | Independent verifier | Required evidence |
|---|---|---|---|---|
| Product architecture and data model | A-tier flagship from provider 1 | Flash/mini for alternatives and documentation | A-tier model from a different provider | Architecture decision record and threat model. |
| Security and sandbox design | Two independent A-tier frontier models | None; accuracy is more important | Static analysis plus human review | Threat model, abuse-case tests, policy tests. |
| Backend/orchestrator implementation | A-tier flagship coding model | B/A-efficient coding model for small modules | Different provider A/B model | Type check, unit/integration tests, diff review. |
| Provider adapters and routing | A-tier primary | Flash/mini for schemas and test cases | Model from a different provider | Contract tests with mocked failures and quotas. |
| React/UI implementation | A-tier multimodal/coding model | Flash/mini for routine components | Screenshot/UX review by a different vision-capable model | Build, accessibility checks, screenshots, interaction tests. |
| Codebase indexing and retrieval | A-tier architect for design | Embedding/rerank models for execution | Retrieval quality test set | Recall/precision tests against known relevant files. |
| Unit, integration, and end-to-end tests | A/B coding model | Fast model for test-case expansion | Test runner—not an LLM—is final authority | Passing tests and mutation/negative tests where feasible. |
| Debugging a failing build | A-tier debugger | B-tier triage/summarizer | Different-provider reviewer for risky patch | Reproduction, failing-before/passing-after evidence. |
| Documentation and onboarding | B-tier long-context model | Fast local/cloud model | Human/editorial spot check | Links, examples, and install path verified. |
| Privacy-restricted/offline work | Best evaluated local A/B model | Smaller local model and embeddings | Static tools + human review | Reproducible local tests; no network logs. |

## Automatic fallback order for *building this project*

For each task, choose a primary and two alternates from different providers before work starts.

1. **Complex implementation:** preferred A-tier flagship → independent A-tier flagship → B-tier coding model → capable local open-weight model.
2. **Routine implementation:** efficient B/A model → different-provider efficient model → local coding model.
3. **Security-critical work:** A-tier model → independent A-tier model → pause for human review. Do not downgrade automatically to an untested low-cost model.
4. **Private/offline work:** best local coding model → second local coding model → pause; never silently use cloud.
5. **Research/context work:** long-context A/B model → fast model → human-reviewed summary.
6. **Verification:** do not fall back from tests to model opinion. If a test fails, return to diagnosis; if no model remains, checkpoint and pause.

Every fallback must inherit the exact project policy, checkpoint, tool permissions, budget ceiling, and success criteria. It may not gain more authority because the primary model ran out of quota.

## How to calculate the live ranking

The initial A/B/C labels are only a bootstrap. The product team must maintain a weekly evaluation suite with the project’s real work:

- TypeScript/React feature tasks;
- SQLite migration and recovery tasks;
- provider-adapter error/rate-limit cases;
- sandbox escape and prompt-injection denial cases;
- cross-model checkpoint/handoff continuation tasks;
- UI screenshot/accessibility fixes;
- test generation and regression repair;
- cost, latency, context, and malformed-tool-call measurements.

For every model-host combination, record:

`verified task pass rate`, `handoff continuation pass rate`, `tool-call validity`, `security-policy denial rate`, `median latency`, `cost per verified task`, `context fit`, and `failure rate`.

Rank with a policy-weighted score, not a general benchmark alone:

`routing score = accuracy × task weight + handoff reliability × task weight + policy fit − cost penalty − latency penalty − failure penalty`

Only promote a model to automatic fallback after it passes the relevant internal test threshold. Demote it automatically when its rolling quality, availability, or security-policy results degrade.

## Benchmark evidence and limits

SWE-bench is useful for repository issue resolution, but it is not a complete measure of this project’s needs. Its official leaderboard makes clear that models are compared under particular agents/environments. Aider Polyglot measures multi-language code-editing behavior, and LiveCodeBench targets fresh coding problems. Use all three as signals, then run the project-specific suite above. [SWE-bench](https://www.swebench.com/), [Aider Polyglot data](https://github.com/Aider-AI/aider/blob/main/aider/website/_data/polyglot_leaderboard.yml), [LiveCodeBench](https://livecodebench.github.io/leaderboard_v5.html).

Independent cross-model benchmarks also mix quality and speed differently. Artificial Analysis, for example, reports weighted task time based on generated output and output speed; this can inform efficiency but cannot replace end-to-end agent evaluation. [Artificial Analysis methodology](https://artificialanalysis.ai/evaluations/artificial-analysis-intelligence-index).

## Rule for this project

Use **the right available model for each bounded task**, then independently verify its work. Do not use every model one after another merely because it exists. Sequential unverified handoffs accumulate mistakes; checkpointed, policy-compliant, evidence-based handoffs create continuity without sacrificing correctness.

## Sources

1. [SWE-bench official leaderboards](https://www.swebench.com/).
2. [Aider Polyglot benchmark data](https://github.com/Aider-AI/aider/blob/main/aider/website/_data/polyglot_leaderboard.yml).
3. [LiveCodeBench leaderboard](https://livecodebench.github.io/leaderboard_v5.html).
4. [Artificial Analysis Intelligence Index](https://artificialanalysis.ai/evaluations/artificial-analysis-intelligence-index).
5. [OpenAI model catalogue](https://developers.openai.com/api/docs/models/all).
6. [Anthropic models overview](https://platform.claude.com/docs/en/models/overview).
7. [Gemini model catalogue](https://ai.google.dev/gemini-api/docs/models).
8. [OpenRouter models API](https://openrouter.ai/docs/guides/overview/models).
9. [Ollama model library](https://ollama.com/library).
10. [Devin API overview](https://docs.devin.ai/api-reference/overview).
11. [GitHub Copilot agents](https://docs.github.com/en/copilot/responsible-use/agents).
