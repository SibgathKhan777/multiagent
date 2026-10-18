# Evals

Measures the factory on a fixed dataset so prompt/model/agent changes can be compared with numbers.

```bash
npm run eval -- --label baseline            # all 30 tasks, needs Docker + a real AI_PROVIDER
npm run eval -- --label cand --limit 5      # quick subset
npm run eval -- --label dev --no-sandbox    # skip Docker execution
npm run eval:compare -- evals/results/baseline.json evals/results/cand.json
```

No MongoDB/Redis needed — agents run in-process. `compare` exits 1 on a regression (CI-friendly) and
refuses to compare runs with a different dataset or provider.

## Metrics
| Metric | Meaning |
|---|---|
| `decompositionRecall` / `decompositionCleanRate` | Did the decomposer pick the expected modules, without forbidden ones? |
| `firstPassValidatorRate` / `finalValidatorRate` | Modules passing the validator on attempt 1 / after feedback retries |
| `invalidOutputRate` | Modules with syntax errors or empty output |
| `fallbackRate` | Modules where the LLM call failed and a template was silently substituted — **must be ~0 for LLM results to mean anything** |
| `requirementCoverage` | Share of the task's `mustMention` keywords present in generated code (cheap proxy, not semantic) |
| `taskCompletionRate` / `testPassRate` | Generated project installs and its generated tests pass in the Docker sandbox |
| `avgLatencyMs`, `avg{Input,Output}Tokens` | Cost (tokens are `null` if the provider doesn't report usage) |

## Caveats
- Labels in `dataset.json` are hand-written; review them before trusting the numbers.
- Generated tests are structural (module loads, exports exist), so `taskCompletionRate` does not prove behavioural correctness.
- Results in `results/local-*` are git-ignored; commit named baselines you want to cite.
- `provider=simulated` measures the template generator, not an LLM.
