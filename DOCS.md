# AI Software Factory — Complete System Documentation

---

## Table of Contents

1. [What Is This Project?](#1-what-is-this-project)
2. [The Problem It Solves](#2-the-problem-it-solves)
3. [How the Full System Works](#3-how-the-full-system-works)
4. [Technology Deep Dives](#4-technology-deep-dives)
   - [LangChain](#41-langchain)
   - [LangGraph](#42-langgraph)
   - [CrewAI](#43-crewai)
   - [MCP — Model Context Protocol](#44-mcp--model-context-protocol)
   - [Neuro-Symbolic AI](#45-neuro-symbolic-ai)
5. [System Architecture Diagram](#5-system-architecture-diagram)
6. [What Each Agent Does](#6-what-each-agent-does)
7. [RAG Memory — How the System Learns](#7-rag-memory--how-the-system-learns)
8. [What Can Be Added Next](#8-what-can-be-added-next)

---

## 1. What Is This Project?

**AI Software Factory** is a fully autonomous, multi-agent software development system. You give it a plain-English idea — *"Build a food delivery backend"* — and it designs, writes, reviews, validates, tests, and packages production-ready Node.js code, completely on its own.

It is built across two services that work together:

| Service | Stack | Role |
|---|---|---|
| `multiagent` | Node.js, BullMQ, MongoDB, Redis, Socket.IO | Job orchestration, dashboard, real-time UI |
| `multiagent-ai-service` | Python, FastAPI, LangGraph, CrewAI, Groq | AI pipeline — the "brain" |

Think of it like a software development team where every team member is an AI agent with a specific role, and the whole team collaborates to ship working code.

---

## 2. The Problem It Solves

### The Traditional Problem

Software development is slow, expensive, and requires deep expertise. A junior developer needs months to learn a codebase. Senior engineers spend hours on boilerplate. Code reviews are bottlenecked. Testing is often skipped. Deployment is manual.

### What This System Does Instead

| Traditional Process | This System |
|---|---|
| Junior dev writes boilerplate (days) | Coder agent writes it in seconds |
| Senior reviews code manually | Reviewer agent scores 0–100, loops until 70+ |
| Security audit happens at the end | Symbolic rules check every generation in real-time |
| Tests written separately, often skipped | Tester agent always writes Jest + Supertest suites |
| Deployment is manual | Integrator agent produces Dockerfile, package.json, README |
| Every project starts from zero | RAG memory recalls past successful projects |

### Real-World Use Cases

- **Startup MVP generation** — describe your idea, get a working backend in minutes
- **Boilerplate elimination** — never write CRUD routes, middleware, or config by hand again
- **Learning tool** — see how a professional architecture is designed for any idea
- **Code auditing** — run any code through `/validate/code` for instant security analysis
- **Rapid prototyping** — iterate on ideas without writing a single line of code

---

## 3. How the Full System Works

### Step-by-Step Flow

```
You type: "Build a URL shortener with analytics"
          │
          ▼
┌─────────────────────────────────────────────────┐
│  Node.js Orchestrator  (port 3000)              │
│                                                 │
│  1. Receives idea via POST /api/pipeline        │
│  2. Decomposes it into 6 modules:               │
│     - Configuration, Database, Middleware,      │
│       Auth, API Routes, Core Business Logic     │
│  3. Queues each module as a BullMQ job          │
│     (concurrency = 1 to respect rate limits)    │
│  4. Dashboard shows live progress via Socket.IO │
└─────────────────┬───────────────────────────────┘
                  │  HTTP POST per module
                  ▼
┌─────────────────────────────────────────────────┐
│  Python AI Service  (port 8000)                 │
│                                                 │
│  LangGraph Pipeline (7 nodes in sequence):      │
│                                                 │
│  [1] memory_search                              │
│       └─ Searches Qdrant Cloud for similar      │
│          past projects (RAG)                    │
│                                                 │
│  [2] architect                                  │
│       └─ Designs tech stack, data flow,         │
│          API contracts using past context       │
│                                                 │
│  [3] coder                                      │
│       └─ Writes production Node.js/Express code │
│          Can use filesystem & shell tools       │
│                                                 │
│  [4] reviewer                                   │
│       └─ Scores code 0-100                      │
│          Score < 70? → loops back to coder      │
│                                                 │
│  [5] symbolic_validator                         │
│       └─ 6 deterministic rule checks:           │
│          secrets, eval, SQL injection...        │
│          ERROR found? → loops back to coder     │
│                                                 │
│  [6] tester                                     │
│       └─ Writes Jest + Supertest test suite     │
│                                                 │
│  [7] integrator                                 │
│       └─ Assembles Dockerfile, package.json,    │
│          README + stores result in Qdrant       │
└─────────────────┬───────────────────────────────┘
                  │  notify_progress() POSTs back
                  ▼
┌─────────────────────────────────────────────────┐
│  Real-Time Dashboard                            │
│  - Socket.IO room per taskId                    │
│  - Python AI Agents panel updates live          │
│  - Each agent lights up as it runs              │
│  - Final: 19 files downloadable as ZIP          │
└─────────────────────────────────────────────────┘
```

### The Retry Loop

The system doesn't just generate code once and hope for the best. It has two feedback loops:

```
            ┌──────────────────────────────────────┐
            │                                      │
            ▼                                      │
         coder ──► reviewer ──► score < 70? ───► RETRY
                       │
                       ▼ score ≥ 70
               symbolic_validator
                       │
                       ▼ ERROR rules? ──────────── RETRY
                       │                           │
                       ▼ clean                     │
                    tester                         │
                       │              ─────────────┘
                       ▼
                  integrator
```

This means the system self-corrects — if the code is bad, it tries again with the feedback from the previous attempt. Max 3 retries per module.

---

## 4. Technology Deep Dives

### 4.1 LangChain

**What it is:** The foundational framework for building LLM-powered applications in Python. It was the first major library to standardise how you connect language models to external tools, memory, and data.

**What it provides:**
- A common interface to call any LLM (GPT-4, Groq, Gemini, Claude) with the same code
- Prompt templates with variables
- Chains — connecting LLM calls in sequence
- Document loaders, text splitters, vector store connectors
- Output parsers — turning LLM text into structured data

**How it's used in this project:**
LangChain sits underneath everything as the LLM communication layer. When our agents call Groq's Llama 3 model, they're using LangChain's `ChatGroq` client under the hood (via LiteLLM). LangChain handles retries, token counting, and the chat message format.

**Analogy:** LangChain is like the USB standard — it lets any device (LLM) plug into any application using the same connector.

---

### 4.2 LangGraph

**What it is:** A library built on top of LangChain that lets you build **stateful, cyclic workflows** for AI agents. Where LangChain handles individual LLM calls, LangGraph handles the flow *between* them.

**The key insight:** Most real AI tasks aren't linear. You need:
- Loops (retry bad output)
- Branches (different paths based on output quality)
- Shared state (passing data between steps)
- Human-in-the-loop checkpoints

LangGraph models this as a **directed graph** where nodes are functions and edges are the routes between them.

**How it works in this project:**

```python
graph = StateGraph(PipelineState)

graph.add_node("memory_search",      memory_search_node)
graph.add_node("architect",          architect_node)
graph.add_node("coder",              coder_node)
graph.add_node("reviewer",           reviewer_node)
graph.add_node("symbolic_validator", symbolic_validator_node)
graph.add_node("tester",             tester_node)
graph.add_node("integrator",         integrator_node)

# Conditional edge: reviewer can loop back to coder
graph.add_conditional_edges(
    "reviewer",
    should_retry_after_review,        # function that reads state
    {"coder": "coder", "symbolic_validator": "symbolic_validator"}
)
```

**PipelineState** is a typed dictionary shared across all nodes:
```python
class PipelineState(TypedDict):
    idea: str
    architecture: str
    code: str
    review_score: int
    review_feedback: str
    symbolic_report: dict
    similar_past_projects: list
    retry_count: int
    ...
```

Every node reads from this state, does its job, and returns an updated version. LangGraph handles the routing automatically.

**Analogy:** LangGraph is like a flowchart come to life — it's the "if this, then that" logic that coordinates your AI agents.

---

### 4.3 CrewAI

**What it is:** A framework for creating teams of AI agents that collaborate to complete complex tasks. Each agent has a role, a goal, and a backstory — and can be given tools to interact with the real world.

**The philosophy:** A single LLM call is like asking one person to do everything. CrewAI lets you split work across specialists — an architect thinks differently from a coder, who thinks differently from a reviewer.

**How an agent is defined:**

```python
Agent(
    role="Senior Developer",
    goal="Write production-quality Node.js code",
    backstory="You are a full-stack engineer with 10 years of Express experience...",
    llm=CREWAI_LLM,          # the Groq LLM
    tools=[write_file_tool, run_command_tool],  # MCP tools
    allow_delegation=False,
    verbose=True,
)
```

**Our 5 agents and their personalities:**

| Agent | Role | Thinks Like |
|---|---|---|
| Architect | System Architect | "How do these services connect?" |
| Coder | Senior Developer | "What's the cleanest implementation?" |
| Reviewer | Code Reviewer | "What could break in production?" |
| Tester | QA Engineer | "How do I break this code?" |
| Integrator | DevOps Engineer | "How does this ship to production?" |

**Each agent runs as a single-agent CrewAI Crew** in this system — one agent, one task, one output. This gives fine-grained control over timing and rate limiting, and allows LangGraph to route between them dynamically.

**Analogy:** CrewAI is like a staffing agency — it gives each agent a job title, a specialisation, and the tools they need to do their job.

---

### 4.4 MCP — Model Context Protocol

**What it is:** A standard protocol (proposed by Anthropic) that defines how AI agents connect to external tools and data sources. Think of it as USB-C for AI — a universal connector between models and the real world.

**The problem it solves:** Without MCP, every tool integration is custom-built. You write specific code for "call this API", "read this file", "run this command". MCP standardises the interface so any agent can use any tool without custom glue code.

**MCP tool anatomy:**
```python
class WriteFileTool(BaseTool):
    name: str = "Write File"
    description: str = "Write content to a file in the sandbox"
    args_schema: type[BaseModel] = WriteFileInput   # typed JSON schema

    def _run(self, path: str, content: str) -> str:
        return filesystem.write_file(path, content)
```

The agent receives the tool's name, description, and schema. It decides *when* to use the tool and *what arguments to pass* — autonomously, during its reasoning process.

**Our MCP tools:**

```
filesystem tools          shell tools           github tools
─────────────────         ───────────           ────────────────
write_file()              run_command()         create_repo()
read_file()               (whitelist:           push_code()
list_directory()          npm, node, git,
(sandboxed to             ls, cat)
generated_projects/)      (30s timeout,
                          Docker if available)
```

**Coder agent gets:** filesystem + shell (writes code, runs npm)  
**Integrator agent gets:** filesystem + shell + GitHub (writes code, pushes to GitHub)

**Analogy:** MCP is like a power strip — instead of one hardwired connection, you give agents a strip of standard plugs and let them grab what they need.

---

### 4.5 Neuro-Symbolic AI

**What it is:** A hybrid approach that combines the power of neural networks (LLMs — flexible, probabilistic, language-understanding) with symbolic AI (rules, logic, deterministic reasoning). Neither alone is sufficient; together they cover each other's weaknesses.

**The fundamental tension:**

| Neural AI (LLMs) | Symbolic AI (Rules) |
|---|---|
| Flexible, understands context | Rigid, precise |
| Can hallucinate | Always correct for its rules |
| Great at generation | Great at verification |
| Probabilistic | Deterministic |
| Hard to audit | Fully explainable |

**How it's implemented in this project:**

The `symbolic_validator_node` is pure symbolic AI sitting *inside* a neural pipeline:

```python
# Neural: LLM generates code (probabilistic, creative)
code = coder_agent.run(architecture)

# Symbolic: Rules verify it (deterministic, auditable)
report = rule_engine.run(code)

# Routing: Symbolic result controls neural retry
if report.has_errors:
    → loop back to coder with specific error messages
```

**The 6 symbolic rules:**

```
Rule                    Severity   What it checks
──────────────────────  ─────────  ──────────────────────────────────────
no_hardcoded_secrets    ERROR      Regex: api_key = "sk-...", passwords
no_eval_usage           ERROR      Detects eval(), exec() calls
no_sql_injection        ERROR      String concat in SQL queries
has_error_handling      WARNING    try/catch, .catch(), next(err) present
rest_conventions        WARNING    HTTP status codes, REST route patterns
eslint_check            INFO       ESLint static analysis
```

**Why this matters:** An LLM can write `eval(userInput)` confidently and a reviewer agent might miss it. The symbolic rule catches it 100% of the time, deterministically, with zero tokens spent.

**The neuro-symbolic feedback loop:**

```
LLM generates code
       │
       ▼
Symbolic rules scan it
       │
       ├── PASS → proceed to tests
       │
       └── FAIL → error message fed back to LLM
                  "Symbolic validation errors (must fix):
                   - [ERROR] no_eval_usage: eval() detected"
                       │
                       ▼
                  LLM regenerates with that specific feedback
```

This is the core of neuro-symbolic AI: **neural systems generate, symbolic systems verify, and the verification results guide the next generation.**

**Analogy:** Think of a human writer (neural) and a spell-checker + grammar tool (symbolic). The writer is creative but makes mistakes. The tool is not creative but catches errors precisely. Together, the output is better than either alone.

---

## 5. System Architecture Diagram

```
                        USER / BROWSER
                             │
                    POST /api/pipeline
                             │
                             ▼
              ┌──────────────────────────────┐
              │    Node.js Orchestrator      │
              │    Express + Socket.IO       │
              │         :3000                │
              │                              │
              │  ┌────────────────────────┐  │
              │  │  BullMQ Queue          │  │
              │  │  concurrency = 1       │  │
              │  │  6 jobs per pipeline   │  │
              │  └────────┬───────────────┘  │
              │           │                  │
              │  ┌────────▼───────────────┐  │
              │  │  MongoDB               │  │
              │  │  Pipeline + Module     │  │
              │  │  state storage         │  │
              │  └────────────────────────┘  │
              │                              │
              │  ┌────────────────────────┐  │
              │  │  Redis                 │  │
              │  │  BullMQ job store      │  │
              │  └────────────────────────┘  │
              └──────────────┬───────────────┘
                             │ HTTP POST /graph/run
                             │ (per module)
                             ▼
              ┌──────────────────────────────┐
              │  Python AI Service           │
              │  FastAPI + LangGraph         │
              │       :8000                  │
              │                              │
              │  LangGraph StateGraph:       │
              │                              │
              │  memory_search               │
              │     │  (Qdrant Cloud RAG)    │
              │  architect ◄──────────────┐  │
              │     │  (CrewAI Agent)      │  │
              │  coder ◄──────────────┐   │  │
              │     │  (CrewAI Agent)  │   │  │
              │  reviewer             │   │  │
              │     │  score < 70 ────┘   │  │
              │  symbolic_validator        │  │
              │     │  ERROR rules ───────┘  │
              │  tester                      │
              │     │  (CrewAI Agent)        │
              │  integrator                  │
              │     │  → store to Qdrant     │
              │     │  → push to GitHub      │
              └──────────────┬───────────────┘
                             │ notify_progress()
                             │ POST /api/progress
                             ▼
              ┌──────────────────────────────┐
              │  Socket.IO Rooms             │
              │  (keyed by taskId)           │
              │  → browser live updates      │
              └──────────────────────────────┘
                             │
                             ▼
              ┌──────────────────────────────┐
              │  External Services           │
              │  - Groq Cloud (LLM)          │
              │  - Qdrant Cloud (vectors)    │
              │  - GitHub API (push code)    │
              └──────────────────────────────┘
```

---

## 6. What Each Agent Does

### Memory Search (not a CrewAI agent — LangGraph node)
Runs before any agent. Searches Qdrant Cloud for the 3 most similar past projects using cosine similarity on the idea embedding. Results are injected into the architect and coder prompts as examples.

### Architect Agent
- **Input:** User idea + similar past projects from memory
- **Output:** Architecture document: tech stack, module breakdown, data flow, API contracts
- **Thinks like:** A senior architect who has seen 1000 similar systems before
- **Word limit:** 800 words (enforced to save tokens)

### Coder Agent
- **Input:** Architecture + past project context + reviewer/symbolic feedback (on retry)
- **Output:** Production Node.js/Express code
- **Tools:** `write_file`, `read_file`, `list_directory`, `run_command`
- **Word limit:** 800 words

### Reviewer Agent
- **Input:** Generated code
- **Output:** Issues by severity (critical/major/minor) + `SCORE: 0-100`
- **Decision:** Score < 70 → coder retries; Score ≥ 70 → move to symbolic validator

### Symbolic Validator (not a CrewAI agent — deterministic rules)
- **Input:** Generated code
- **Output:** RuleReport: {passed, failed rules, severity, messages}
- **Rules:** 6 deterministic checks (see section 4.5)
- **Decision:** ERROR severity → coder retries with specific error details

### Tester Agent
- **Input:** Final validated code
- **Output:** Jest + Supertest test file covering happy path + 2 edge cases per endpoint
- **Word limit:** 600 words

### Integrator Agent
- **Input:** Architecture + Code + Review feedback + Tests
- **Output:** Deployment checklist — Dockerfile, package.json, .env.example, README contents
- **Tools:** All filesystem + shell + GitHub tools (can push directly to a repo)
- **Side effect:** Stores the generation in Qdrant for future memory recall

---

## 7. RAG Memory — How the System Learns

RAG stands for **Retrieval-Augmented Generation**. It means the system retrieves relevant past information before generating new content — like a developer who reviews similar past projects before starting a new one.

### How It Works

**On every successful generation (integrator_node):**
```
idea text ──► all-MiniLM-L6-v2 ──► 384-dimensional vector ──► Qdrant Cloud
              (sentence-transformers)                          (stored with code + metadata)
```

**On every new pipeline (memory_search_node):**
```
new idea ──► embed ──► Qdrant cosine search ──► top-3 similar past projects
                       (threshold: 0.5)          ──► injected into architect + coder prompts
```

### Why This Makes the System Better Over Time

First pipeline: no memory, starts from scratch.  
After 10 pipelines: the system has seen REST APIs, auth systems, database layers.  
After 100 pipelines: it pattern-matches to the right architecture instantly, avoids known mistakes, reuses successful patterns.

The system genuinely improves with use — like a developer who gets better with experience.

### The Embedding Model

`all-MiniLM-L6-v2` is a lightweight sentence-transformer model (80MB) that converts any text into a 384-number vector. Ideas that mean similar things end up with vectors close together in this 384-dimensional space. Qdrant finds the closest ones using cosine similarity.

---

## 8. What Can Be Added Next

### Near-Term (Weeks)

| Feature | What it adds |
|---|---|
| **Multi-language support** | Generate Python/FastAPI, Go/Gin, Java/Spring alongside Node.js |
| **GPT-4o / Claude 3.5 Sonnet routing** | Use faster/cheaper models for simple agents, powerful ones for hard reasoning |
| **Human-in-the-loop checkpoints** | LangGraph supports pausing for human review before coder retries |
| **GitHub PR creation** | Integrator agent creates a pull request instead of pushing directly to main |
| **ESLint config generation** | Generate `.eslintrc` per project so the eslint rule actually runs |

### Medium-Term (Months)

| Feature | What it adds |
|---|---|
| **Self-improving rules** | Symbolic rules that learn new patterns from failures (neuro-symbolic training loop) |
| **Multi-agent debate** | Two coder agents independently write the same module; a judge picks the better one |
| **Automated testing execution** | Run the Jest tests in a Docker container and feed results back into the pipeline |
| **OpenTelemetry tracing** | Full distributed trace across Node.js + Python with Grafana dashboard |
| **Fine-tuned reviewer** | Fine-tune a small model (Mistral 7B) on the review scores this system has generated |

### Cutting-Edge (Research Level)

| Technology | What it enables |
|---|---|
| **LangGraph Persistence** | Resume any pipeline from any checkpoint — survives server restarts |
| **Agent self-reflection** | Agents critique their own output before passing it forward (CoT + self-consistency) |
| **Tool use learning** | Track which MCP tools produce better code; bias agent tool selection accordingly |
| **Program synthesis** | Combine LLM generation with formal verification (Z3 solver) for provably correct code |
| **Mixture of Experts routing** | Route each module to the specialist model (coding LLM for code, reasoning LLM for architecture) |

### The Biggest Opportunity: Closing the Loop

Right now the system generates code but doesn't *run* it. The next major milestone is:

```
generate code
     │
     ▼
run tests in Docker sandbox   ◄── this is the gap
     │
     ├── tests pass → ship
     │
     └── tests fail → feed stack trace back to coder → retry
```

This closes the loop completely: the system doesn't just generate code that *looks* correct — it generates code that *is* correct, verified by actual execution. This is the frontier of autonomous software development.

---

*Built by SibgathKhan777 — a hybrid AI system combining LangGraph orchestration, CrewAI agent teams, neuro-symbolic validation, and Qdrant RAG memory to autonomously generate production software.*
