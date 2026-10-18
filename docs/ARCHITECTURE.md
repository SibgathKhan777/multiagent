# Architecture notes

## Why the controller + state machine, not LangGraph or DeepAgents

The role this project targets lists LangGraph, DeepAgents and harness engineering. This repository implements the *same capabilities* directly and deliberately does **not** adopt either framework. Decision record:

**Context.** The workflow is a fixed sequence — decompose → (prompt → generate → validate → feedback)ⁿ per module → integrate → sandbox → repair — with small bounded loops. It runs in Node.js with MongoDB persistence and a BullMQ queue.

**What a graph framework would give us, and what we already have**

| Capability | Where it already lives |
|---|---|
| Explicit states and transitions | `src/core/pipeline.js` (validated transition table, `restore()`) |
| Checkpointing / persistence | Modules, prompts, outputs, scores and task status are written to MongoDB as work completes |
| Resume after interruption | `recoverInterruptedPipelines()` rebuilds `completedOutputs` from persisted modules; bounded by a resume counter |
| Human-in-the-loop interrupt | Execution-approval gate (`awaiting-approval` stage, `POST /api/pipeline/:id/approve`) |
| Bounded retries / loops | `MAX_ITERATIONS`, `EXEC_MAX_REPAIR_ROUNDS`, LLM attempt limits |
| Tool use through a protocol | MCP client/server with discovery, schemas, allow-list and approval tokens |
| Tracing per node | Tracer spans per stage, per attempt, per LLM call, per tool call |

**Why not adopt LangGraph here.** It is a Python/JS graph runtime; the idiomatic way to use it is to *own* the control flow. Doing so would mean rewriting the controller and its recovery logic to obtain primitives that already exist and are tested, with no new capability. It would also move orchestration out of the language the rest of the system (queue, models, API, sandbox) is written in.

**Why not DeepAgents.** DeepAgents targets open-ended, long-horizon agents that plan, keep a scratch filesystem and delegate to sub-agents. This pipeline is the opposite: its structure is known in advance and *should* be deterministic and auditable. Letting a planner choose the steps would make runs harder to bound, evaluate and reproduce.

**Where they would add value (not done).** (1) Reimplementing the repair loop — generate, run tests, read failures, patch — as a LangGraph graph in the Python AI service, where `interrupt()` and a checkpointer could replace the hand-written gate; (2) an open-ended "reviewer" sub-agent that explores a failing project with the MCP file tools. Both are reasonable follow-ups; neither exists in this repository, and the README says so.

**Trade-off accepted.** Less framework familiarity on paper, in exchange for a system whose state machine, recovery and failure modes are all explicit, unit-tested (`tests/controller.test.js`) and small enough to explain end to end.

## Failure semantics

| Event | Result |
|---|---|
| Module never passes validation (retries exhausted) | module kept with `validationPassed=false`; task verdict `failed` |
| Real provider fails, template substituted | module `usedFallback=true`; task verdict `failed` (or the worker throws if `LLM_FALLBACK=off`) |
| Worker error / job never completes | task `failed`, in-flight modules `failed`, callback discarded |
| Generated tests fail after repair budget | task `failed` with `n/m tests passed` in `error` |
| `npm install` fails | task `failed` (no repair possible) |
| Docker unavailable | execution `skipped`; verdict `unverified` — never `verified` |
| Cancellation | task `cancelled`, modules `failed` |
| Process dies mid-run | next start resumes (≤ 2×) or marks `failed` with the reason |
| MongoDB down while recording a failure | logged; task stays non-terminal until startup recovery settles it |

## Data flow & trust boundaries

Everything an LLM produces crosses one boundary: the Docker sandbox. Host-side code only ever *reads* results (JSON markers on stdout), never evaluates generated code. The MCP approval secret lives in the trusted client process and the server's environment; models see tool schemas, not secrets.
