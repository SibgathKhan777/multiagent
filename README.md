# AI Software Factory

> Distributed Multi-Agent AI System for autonomous software generation.

Takes a single **high-level idea** as input and autonomously decomposes it into modules, generates code using simulated AI workers, validates quality, runs iterative feedback loops, and integrates everything into a final project.

## Architecture

```
IDEA → Decomposer → Prompt Generator → Worker Queue → Validator
                                                        ↓
                                              Feedback Loop (if issues)
                                                        ↓
                                              Integration Agent → Final Output
```

### Agents

| Agent | Role |
|-------|------|
| **Task Decomposer** | Breaks idea into 4-8 structured modules |
| **Prompt Generator** | Creates optimized prompts per module |
| **Worker (Simulated)** | Generates realistic Node.js code |
| **Validator** | Scores code 0-100 on quality/security |
| **Feedback** | Converts issues into prompt improvements |
| **Integration** | Merges all modules into final project |

## Prerequisites

- **Node.js** 18+
- **MongoDB** running locally (`mongod`)
- **Redis** running locally (`redis-server`)

Install via Homebrew (macOS):
```bash
brew install mongodb-community redis
brew services start mongodb-community
brew services start redis
```

## Setup & Run

```bash
cd multiagent
npm install
node src/index.js
```

Server starts at `http://localhost:3000`

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/pipeline` | Start pipeline with `{ "idea": "..." }` |
| `GET` | `/api/pipeline/:taskId` | Get pipeline status |
| `GET` | `/api/pipeline/:taskId/output` | Get final output |
| `GET` | `/api/pipelines` | List all pipelines |
| `GET` | `/api/health` | Health check |

## Example Run

```bash
# Start a pipeline
curl -X POST http://localhost:3000/api/pipeline \
  -H "Content-Type: application/json" \
  -d '{"idea": "Build a scalable food delivery backend system"}'

# Response:
# { "success": true, "data": { "taskId": "abc-123", "status": "started" } }

# Check progress
curl http://localhost:3000/api/pipeline/abc-123

# Get final output (after completion)
curl http://localhost:3000/api/pipeline/abc-123/output
```

## Project Structure

```
multiagent/
├── config/
│   ├── default.js          # App config
│   └── models.js           # AI model registry
├── src/
│   ├── index.js            # Express entry point
│   ├── api/routes.js       # REST endpoints
│   ├── agents/
│   │   ├── decomposer.js   # Idea → modules
│   │   ├── promptGenerator.js
│   │   ├── worker.js       # Simulated AI code gen
│   │   ├── validator.js    # Quality scoring
│   │   ├── feedback.js     # Issue → prompt fix
│   │   └── integration.js  # Merge → final project
│   ├── core/
│   │   ├── controller.js   # Orchestrator
│   │   └── pipeline.js     # State machine
│   ├── queue/queue.js      # BullMQ setup
│   ├── models/             # MongoDB schemas
│   ├── memory/memory.js    # Output reuse cache
│   └── utils/
│       ├── logger.js       # Winston logging
│       └── retry.js        # Exponential backoff
└── README.md
```

## Switching to Real AI APIs

Edit `config/models.js`:
1. Change `provider` from `"simulated"` to `"openai"` or `"anthropic"`
2. Add API key to `.env`: `OPENAI_API_KEY=sk-...` or `ANTHROPIC_API_KEY=sk-ant-...`
3. Update `worker.js` to call real APIs instead of templates
