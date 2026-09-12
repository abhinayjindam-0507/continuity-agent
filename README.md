# Continuity Agent MVP

A zero-cost local-first proof of concept for resilient software-engineering tasks.

## Run

```sh
npm start
```

Open `http://127.0.0.1:4317`.

The app has no cloud credentials and makes no paid API calls. It stores task state in `.continuity-agent/continuity-agent.sqlite` and uses a locally running Ollama-compatible endpoint only after the user configures an installed model. Existing early JSON task/config data is migrated automatically on first launch.

## Current safety limits

- Tools are restricted to the current project folder.
- Network tools are absent.
- Terminal calls use a small command allowlist and never invoke a shell.
- Every tool result creates a local checkpoint.
- Only the user-configured local fallback list can be selected automatically.

This is the first vertical slice, not yet the final sandbox or full multi-provider implementation.
