# Multiagent AI Factory

A multi-agent pipeline that turns a one-line software idea into a generated Node.js/Express project, then **executes the generated tests in a Docker sandbox and feeds real failures back to the coder**. A run only counts as `verified` if the generated code passes validation *and* its tests pass.

```
idea ──▶ Decomposer ──▶ Prompt Generator ──▶ Worker (LLM) ──▶ Validator ──┐
                                                   ▲                      │ fail
                                                   └──── Feedback ◀───────┘
                                                                          │ pass
        Integration ──▶ Docker sandbox: npm install + jest ──▶ Outcome verdict
              ▲                         │ failing tests
              └──── execution feedback ─┘ (blamed modules are rebuilt, up to 2 rounds)
```

## Status

| Area | State |
|---|---|
| Multi-agent pipeline (decompose → build → validate → feedback → integrate) | Working, BullMQ + MongoDB |
| Sandboxed execution (Docker, no network for tests, read-only, non-root) | Working; unit-tested, exercised against real Docker |
| Execution → coder repair loop | Working (`EXEC_MAX_REPAIR_ROUNDS`, default 2) |
| Honest outcome (`verified` / `unverified` / `failed`) | Working |
| Tracing (JSONL always, Langfuse optional) | Working; Langfuse export tested with a stub client only |
| MCP server + client (`MCP_ENABLED=true`) | Working; tested over real stdio |
| Eval suite (30 tasks, regression gate) | Working; **no real-LLM baseline published yet** |
| Durable recovery after a process restart | **Not done** — in-flight pipeline state lives in memory |
| Validator runs generated code in Node `vm` on the host | **Known weakness** — not a security boundary |

## Quick start

Requirements: Node 18+, Docker (for MongoDB/Redis and the sandbox), a Groq or Gemini API key (or `AI_PROVIDER=simulated` for an offline demo).

```bash
cp .env.example .env            # add GROQ_API_KEY or GEMINI_API_KEY
docker compose up -d mongodb redis
npm install
npm start                       # http://localhost:3000
```

Create a run:

```bash
curl -X POST localhost:3000/api/pipeline -H 'content-type: application/json' \
  -d '{"idea":"food delivery app with live order tracking and online payment"}'
curl localhost:3000/api/pipeline/<taskId>          # status + per-module scores
curl localhost:3000/api/pipeline/<taskId>/output   # files, execution result, outcome
```

> The default Groq/Gemini model ids in `config/models.js` have been retired upstream. Set `GROQ_MODEL_FAST` / `GROQ_MODEL_QUALITY` / `GROQ_MODEL_LIGHT` to models your account can use (list them with the Groq models API).

## What "completed" means

A pipeline can *finish* while its generated app is broken, so the result carries an explicit verdict (`finalOutput.outcome`):

- **verified** — every module passed validation, output came from the real LLM, and the generated tests passed in the sandbox.
- **unverified** — nothing failed, but it couldn't be confirmed (Docker unavailable, or the `simulated` template provider).
- **failed** — a module never passed validation, an LLM failure was masked by a template fallback, or the generated tests failed. The task status is `failed` and `error` lists the reasons; the files are still saved for inspection.

## Safety model for generated code

Generated code is untrusted. `src/agents/executor.js` never runs it on the host:

- paths are validated before anything is written (no `..`, absolute paths, `node_modules/`, `.git/`; file count and size capped)
- `npm install --ignore-scripts` in one container (network on), tests in another with `--network none` and a read-only project mount
- non-root user, `--cap-drop ALL`, `no-new-privileges`, read-only root fs, memory/CPU/pids limits, hard timeouts, container force-removed on timeout
- if Docker is unavailable the result is `skipped`, never "success"

## Observability

`src/observability/tracer.js` records a trace per pipeline run with nested spans (decompose, per-module attempts, LLM generation with model + token usage, validate, feedback, integrate, sandbox install/test). Spans go to `logs/traces.jsonl`; set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` to export to Langfuse. Trace context is passed through BullMQ job data so queue-worker spans attach to the right trace.

## MCP

`src/mcp/server.js` is a stdio MCP server exposing `validate_code`, `run_unit_tests`, `list_project_files` and `read_project_file` with schema-validated inputs. Only tools in `MCP_ALLOWED_TOOLS` are registered (default excludes `run_unit_tests`); file tools are confined to `MCP_WORKSPACE`. With `MCP_ENABLED=true` the pipeline calls validation and sandboxed tests through the MCP client, which only calls tools it discovered.

## Evals

```bash
npm run eval -- --label baseline --limit 3
npm run eval:compare -- evals/results/baseline.json evals/results/candidate.json
```

30 hand-labelled tasks; metrics include decomposition recall, first-pass/final validator rate, requirement coverage, sandbox task-completion and test-pass rate, fallback rate, latency and tokens. `compare` exits non-zero on regressions. The eval aborts if a real provider silently falls back to templates (e.g. a rate limit). See [evals/README.md](evals/README.md) for caveats. No LLM baseline has been published yet; Groq's free tier (200k tokens/day) fits only a few tasks per day.

## Tests

```bash
npm test        # 111 unit/integration tests; none need Docker, MongoDB or an API key
```

## Layout

```
src/agents/         decomposer, promptGenerator, worker, validator, feedback, integration, executor
src/core/           controller (orchestration), pipeline (state machine), outcome (verdict)
src/mcp/            MCP server, client, toolbox
src/observability/  tracer
src/queue/          BullMQ queue/worker
evals/              dataset, harness, metrics, compare
DOCS.md             long-form design notes (describes a LangGraph/CrewAI Python service
                    that lives outside this repo; the Node pipeline above is self-contained)
```
