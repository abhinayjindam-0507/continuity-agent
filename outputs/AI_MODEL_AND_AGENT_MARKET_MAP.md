# AI Model and Agent Market Map

## Decision

Build integrations around permitted inference APIs and local runtimes. Do **not** attempt to automate consumer subscriptions or scrape/relay consumer products such as ChatGPT, Cursor, Claude Code, or Windsurf as invisible fallback models. Those products are separate applications with their own authentication, quotas, environments, and terms. They are competitors, reference points, or—where an official API/SDK permits it—optional external integrations.

The platform should dynamically discover models from supported provider catalog APIs, record their capabilities and policies, and route only among models that are enabled by the user. A hard-coded catalogue of “all models” will become stale quickly.

## What the platform must support

### 1. Native frontier-provider adapters — first priority

| Provider | Why include it | Integration status for the product |
|---|---|---|
| OpenAI | General reasoning, coding, tool use, multimodal models and a standard production API. | **Phase 1 native adapter** |
| Anthropic | Strong long-context and agentic/coding model family; models API exposes capabilities and token limits. | **Phase 1 native adapter** |
| Google Gemini | Broad text, vision, tool, computer-use, embedding, and agent capabilities. | **Phase 1 native adapter** |
| xAI | Independent frontier provider and useful diversity in fallback supply. | **Phase 2 native adapter** |
| Mistral | Independent proprietary/open model portfolio and European-provider option. | **Phase 2 native adapter** |
| DeepSeek | Important independent reasoning/coding model family; add only after API, privacy, and regional policy review. | **Phase 2 native adapter** |
| Cohere | Enterprise-focused language, retrieval, and embedding options. | **Phase 3 capability adapter** |

Do not choose a specific model name as a permanent default. Models change, are deprecated, and differ by account, region, and capability. Query each provider’s model catalogue at setup and periodically thereafter. For example, Anthropic exposes model capability and token-limit information through its Models API, while Gemini explicitly labels stable and preview models differently. [Anthropic model overview](https://platform.claude.com/docs/en/models/overview), [Gemini models](https://ai.google.dev/gemini-api/docs/models).

### 2. Model aggregators and hosted open-model providers — second priority

| Service class | Examples to evaluate | Product role |
|---|---|---|
| Multi-provider routing | OpenRouter, Hugging Face Inference Providers | Optional extra supply and fast access to permitted models; never replace the platform’s own policy and checkpoint layer. |
| Fast inference for open models | Groq, Cerebras, Together AI, Fireworks AI, DeepInfra, Replicate, Baseten | Latency/cost-oriented alternatives for review, classification, retrieval, and configured coding tasks. |
| Cloud marketplaces | Amazon Bedrock, Google Vertex AI, Azure AI Foundry | Enterprise account, region, governance, and procurement paths. |

OpenRouter documents a catalogue API with model capabilities, pricing, context length, supported parameters, deprecation information, and routing/fallback features. Hugging Face’s provider layer similarly exposes multiple providers behind one client. These are useful adapters, but the platform must still make its own privacy, budget, and safety decision for every request. [OpenRouter models API](https://openrouter.ai/docs/guides/overview/models), [Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers/en/index).

### 3. Local runtimes and open-weight models — mandatory baseline

| Runtime | Best role | Product decision |
|---|---|---|
| Ollama | Easiest local-first setup for individual developers. | **Phase 1 native adapter** |
| llama.cpp | Broad hardware support and efficient local GGUF execution. | **Phase 2 native adapter** |
| vLLM | High-throughput/self-hosted serving and OpenAI-compatible interface. | **Phase 2 native adapter** |
| LM Studio / compatible local servers | User-managed local endpoints. | **Phase 2 OpenAI-compatible adapter** |

Candidate open-weight families must be discovered from the local runtime catalog and user hardware, not treated as a fixed list. Important families include Llama, Qwen/Qwen-Coder, DeepSeek-R1, Gemma, Mistral, Phi, GPT-OSS, GLM, and embedding models. Ollama’s current public library illustrates the range and tags models for capabilities such as tools, thinking, vision, embeddings, and cloud availability. [Ollama library](https://ollama.com/library). llama.cpp’s purpose is local and cloud inference across a wide hardware range, and vLLM provides an OpenAI-compatible serving interface. [llama.cpp](https://github.com/ggml-org/llama.cpp), [vLLM supported models](https://docs.vllm.ai/en/latest/models/supported_models.html).

### 4. AI coding products and agents — not default fallback models

| Product category | Examples | Correct relationship |
|---|---|---|
| AI-native IDE/agent products | Cursor, Windsurf, Claude Code, Codex, Cline, Roo Code, Aider, OpenCode | Competitors/reference implementations; users may use them beside this platform, but do not automate their consumer accounts as hidden backends. |
| Managed engineering agents | Devin, GitHub Copilot coding agent, Google Antigravity agent | Potential optional integrations only through official APIs/SDKs and explicit user authorization. |
| Frameworks/standards | MCP, agent SDKs, OpenAI-compatible APIs | Interoperability layer for tools and adapters, never a replacement for platform security controls. |

Official APIs may make some managed-agent integrations possible. Devin documents an API for creating and managing sessions, and GitHub documents Copilot SDK/CLI capabilities. Treat these as separate managed-worker adapters with their own billing, permissions, sandbox, and lifecycle—not as raw models that can safely inherit an arbitrary task mid-step. [Devin API overview](https://docs.devin.ai/api-reference/overview), [GitHub Copilot agents](https://docs.github.com/en/copilot/responsible-use/agents). Cursor itself describes coding agents as LLM-powered engineering tools; it is not a provider-neutral model API. [Cursor coding agents](https://prod.cursor.com/help/ai-features/coding-agents).

## Capability-based catalogue

The router must store normalized metadata rather than only a provider/model name:

- `provider`, `model_id`, `version`, `region`, `lifecycle`;
- input/output modalities and supported tool/structured-output features;
- maximum context/output limits and observed reliability;
- configured price, estimated token cost, and user-specific quota health;
- privacy classification and data-retention policy allowed by the user;
- model quality tier based on the platform’s own coding, test-fix, review, and handoff evaluations;
- local hardware/runtime availability, latency, and queue state;
- whether it is approved as an automatic fallback for the current project.

The router must query provider catalogues on a schedule, mark removed/deprecated models as unavailable, and keep immutable model-version records in checkpoints. Never route merely because a brand is popular.

## Recommended initial fallback pools

### Private/local pool

1. Preferred local coding/reasoning model appropriate for available hardware.
2. Smaller local tool-capable model for summaries, code search, and inexpensive verification.
3. Pause if the project is local-only and no capable local model remains.

### Cloud-permitted coding pool

1. User-selected preferred frontier coding model.
2. Equivalent approved model from a different provider.
3. Lower-cost approved model for review, summaries, tests, or bounded fixes.
4. Approved hosted open model.
5. Capable local model, if privacy and hardware rules allow.
6. Pause with a recovery explanation if no eligible model remains.

Use a task-specific compatibility filter before ordering the pool. A browser/vision task must not fall back to a text-only model; a long-context handoff must not silently go to a model that cannot receive a sufficient state summary; a security-sensitive repository must not go to a provider excluded by policy.

## Managed-worker adapter policy

Managed agents such as Devin or a cloud coding agent should be optional **delegates**, not the continuity core. When used, the platform creates a bounded job with a repository snapshot, scoped credentials, success criteria, cost cap, and return format. The delegate returns a patch, test evidence, and structured summary; the platform verifies the result in its own sandbox before checkpointing it. A failed managed-worker job never receives unrestricted access to the platform’s other providers or tools.

## Routing rules

1. Use the current model while it remains healthy and within the configured policy.
2. On temporary throttling or overload, respect the provider retry hint and use bounded exponential backoff with jitter.
3. On quota, billing, credential, policy, or terminal validation failure, do not retry blindly; select an eligible fallback or pause.
4. Save a checkpoint before switching.
5. Select only a model matching the required capability, privacy, budget, context, and execution policy.
6. Send the validated handoff packet, check workspace consistency, then continue from the next safe action.
7. Record and display the switch.

Provider error responses must be classified rather than treated identically. OpenAI distinguishes temporary rate-limit/overload cases from quota or billing cases that retries cannot resolve. Anthropic similarly distinguishes temporary `retry-after` rate limits from spend-cap states that keep failing until access returns. [OpenAI rate-limit guidance](https://developers.openai.com/api/docs/guides/rate-limits), [Anthropic rate-limit guidance](https://platform.claude.com/docs/en/api/rate-limits).

## Implementation order

**MVP:** Ollama, OpenAI, Anthropic, Gemini, one OpenAI-compatible endpoint; dynamic catalogue; health checks; capability registry; checkpoints; policy-controlled automatic switching; transparent notifications.

**Release 2:** OpenRouter or Hugging Face aggregation, Mistral, xAI, DeepSeek, llama.cpp, vLLM, local hardware profiling, eval-driven model scoring.

**Release 3:** enterprise marketplaces, managed-worker adapters, browser/vision-specialized pool, multi-agent delegation, organization policy and audit controls.

## Non-negotiable safeguards

- Never bypass rate limits, terms, subscriptions, authentication, or provider billing.
- Never silently use a paid model beyond the configured cap.
- Never transmit project data to an unapproved provider.
- Never treat an external agent’s output as trusted without local verification.
- Never allow a fallback model to gain permissions that the previous model did not have.
- Never promise “all models” or perpetual availability; promise an up-to-date, policy-approved catalogue and resilient continuation.

## Sources

1. OpenAI. [Models](https://developers.openai.com/api/docs/models/all) and [Rate limits](https://developers.openai.com/api/docs/guides/rate-limits).
2. Anthropic. [Models overview](https://platform.claude.com/docs/en/models/overview) and [Rate limits](https://platform.claude.com/docs/en/api/rate-limits).
3. Google. [Gemini API models](https://ai.google.dev/gemini-api/docs/models).
4. OpenRouter. [Models API](https://openrouter.ai/docs/guides/overview/models).
5. Hugging Face. [Inference Providers](https://huggingface.co/docs/inference-providers/en/index).
6. Ollama. [Model library](https://ollama.com/library).
7. llama.cpp. [Project documentation](https://github.com/ggml-org/llama.cpp).
8. vLLM. [Supported models](https://docs.vllm.ai/en/latest/models/supported_models.html).
9. Cursor. [Coding agents](https://prod.cursor.com/help/ai-features/coding-agents).
10. Cognition. [Devin API overview](https://docs.devin.ai/api-reference/overview).
11. GitHub. [Copilot Agents](https://docs.github.com/en/copilot/responsible-use/agents).
