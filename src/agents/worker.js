const Groq = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const modelsConfig = require('../../config/models');
const memory = require('../memory/memory');
const logger = require('../utils/logger').forAgent('Worker');
const aiService = require('../services/aiService');
const tracer = require('../observability/tracer');
const { callWithRetry, classifyError, EmptyResponseError } = require('../services/llmErrors');
const { redact } = require('../utils/redact');

// ─── LLM Client Initialization ─────────────────────────────────────────────

let groqClient = null;
let geminiClient = null;

function getGroqClient() {
  if (!groqClient && modelsConfig.groq.apiKey) {
    groqClient = new Groq({ apiKey: modelsConfig.groq.apiKey });
  }
  return groqClient;
}

function getGeminiClient() {
  if (!geminiClient && modelsConfig.gemini.apiKey) {
    geminiClient = new GoogleGenerativeAI(modelsConfig.gemini.apiKey);
  }
  return geminiClient;
}

// ─── LLM API Callers ───────────────────────────────────────────────────────

/**
 * Call Groq API (Llama 3.3 70B / Llama 3.1 8B).
 */
async function callGroq(prompt, tier = 'fast') {
  const client = getGroqClient();
  if (!client) throw new Error('Groq API key not configured');

  const modelName = modelsConfig.groq.models[tier] || modelsConfig.groq.models.fast;
  logger.info(`Calling Groq API — model: ${modelName}`);

  const response = await client.chat.completions.create({
    model: modelName,
    messages: [
      {
        role: 'system',
        content: 'You are an expert Node.js backend engineer. Return ONLY valid JavaScript code. No markdown fences, no explanations outside code. Include module.exports at the end.',
      },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3,
    max_tokens: 4096,
  });

  return {
    text: response.choices[0]?.message?.content || '',
    usage: response.usage
      ? { input: response.usage.prompt_tokens || 0, output: response.usage.completion_tokens || 0 }
      : null,
  };
}

/**
 * Call Google Gemini API.
 */
async function callGemini(prompt, tier = 'fast') {
  const client = getGeminiClient();
  if (!client) throw new Error('Gemini API key not configured');

  const modelName = modelsConfig.gemini.models[tier] || modelsConfig.gemini.models.fast;
  logger.info(`Calling Gemini API — model: ${modelName}`);

  const model = client.getGenerativeModel({ model: modelName });
  const result = await model.generateContent({
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `You are an expert Node.js backend engineer. Return ONLY valid JavaScript code. No markdown fences (\`\`\`), no explanations outside code, no comments saying "here is the code". Just the raw JavaScript. Include module.exports at the end.\n\n${prompt}`,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 4096,
    },
  });

  const meta = result.response.usageMetadata;
  return {
    text: result.response.text() || '',
    usage: meta ? { input: meta.promptTokenCount || 0, output: meta.candidatesTokenCount || 0 } : null,
  };
}

// ─── Simulated Templates (Fallback) ────────────────────────────────────────

const SIMULATED_TEMPLATES = {
  config: () => `'use strict';
const path = require('path');
const requiredVars = ['PORT', 'MONGODB_URI'];
for (const v of requiredVars) { if (!process.env[v]) console.warn(\`Warning: \${v} not set\`); }
const config = Object.freeze({
  port: parseInt(process.env.PORT, 10) || 3000,
  db: { uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/app' },
  jwt: { secret: process.env.JWT_SECRET || 'dev-secret-change-in-production', expiresIn: '24h' },
  cors: { origin: process.env.CORS_ORIGIN || '*' },
  env: process.env.NODE_ENV || 'development',
});
module.exports = config;`,

  database: () => `'use strict';
const mongoose = require('mongoose');
const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, index: true },
  password: { type: String, required: true, minlength: 6 },
  role: { type: String, enum: ['user', 'admin', 'driver'], default: 'user' },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });
const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  items: [{ name: String, quantity: { type: Number, min: 1 }, price: { type: Number, min: 0 } }],
  totalAmount: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ['pending','confirmed','preparing','out-for-delivery','delivered','cancelled'], default: 'pending' },
  deliveryAddress: { street: String, city: String, zipCode: String },
  paymentStatus: { type: String, enum: ['pending','paid','refunded'], default: 'pending' },
}, { timestamps: true });
async function connectDB(uri) { try { await mongoose.connect(uri); console.log('MongoDB connected'); } catch(e) { console.error(e.message); process.exit(1); } }
function createCRUD(Model) { return { async create(d) { return Model.create(d); }, async findById(id) { return Model.findById(id).lean(); }, async findAll(f={}) { return Model.find(f).lean(); }, async update(id,d) { return Model.findByIdAndUpdate(id,d,{new:true}); }, async remove(id) { return Model.findByIdAndDelete(id); } }; }
const User = mongoose.model('User', userSchema);
const Order = mongoose.model('Order', orderSchema);
module.exports = { connectDB, User, Order, userCRUD: createCRUD(User), orderCRUD: createCRUD(Order) };`,

  default: (ctx) => `'use strict';
// ${ctx.name} — Generated by simulated worker
// Description: ${ctx.description || 'Module implementation'}
function init() { console.log('${ctx.name} initialized'); return true; }
function process(input) { if (!input) throw new Error('Input required'); return { success: true, data: input, module: '${ctx.name}' }; }
module.exports = { init, process };`,
};

// ─── Code Extraction ────────────────────────────────────────────────────────

/**
 * Clean LLM response — strip markdown fences and extract code.
 */
function extractCode(raw) {
  if (!raw) return '';
  let text = String(raw).trim();

  // Prefer the contents of the first fenced block (handles prose before/after the fence)
  const fenced = text.match(/```(?:javascript|js|node|typescript|ts)?[ \t]*\n([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();

  // Unterminated fence (truncated output): drop just the fence markers
  text = text.replace(/^```(?:javascript|js|node)?[ \t]*\n?/i, '').replace(/\n?```\s*$/, '');

  // Strip leading prose up to the first line that looks like code. This list must include
  // every way a JS file can START (function/class/import/...), otherwise real code that
  // begins with e.g. `function foo() {}` is cut off at a later `module.exports` line.
  const start = text.search(/^(?:'use strict'|"use strict"|const |let |var |function[\s*(]|async\s+function|class |\(function|\(async|import |export |require\(|module\.|exports\.|\/\/|\/\*|#!)/m);
  return (start > 0 ? text.slice(start) : text).trim();
}

// ─── Main Worker Function ───────────────────────────────────────────────────

const envInt = (name, fallback) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
};

function estimateCostUsd(usage) {
  const pin = parseFloat(process.env.LLM_PRICE_IN_PER_MTOK);
  const pout = parseFloat(process.env.LLM_PRICE_OUT_PER_MTOK);
  if (!usage || !Number.isFinite(pin) || !Number.isFinite(pout)) return null; // only when the operator supplies real prices
  return (usage.input * pin + usage.output * pout) / 1e6;
}

const DEFAULT_PROVIDERS = {
  groq: async (prompt, tier) => {
    const { text, usage } = await callGroq(prompt, tier);
    return { code: extractCode(text), usage, model: modelsConfig.groq.models[tier] };
  },
  gemini: async (prompt, tier) => {
    const { text, usage } = await callGemini(prompt, tier);
    return { code: extractCode(text), usage, model: modelsConfig.gemini.models[tier] };
  },
  'python-ai': async (_prompt, _tier, ctx) => {
    const result = await aiService.callGraph(ctx.description || ctx.name, ctx.taskId || '');
    return { code: extractCode(result.code || ''), usage: null, model: `python-ai (review_score=${result.review_score ?? 'n/a'})` };
  },
};

function templateFor(moduleContext) {
  const fn = SIMULATED_TEMPLATES[moduleContext.type] || SIMULATED_TEMPLATES.default;
  return fn(moduleContext);
}

/**
 * Worker Agent — calls the configured LLM provider with a timeout and bounded,
 * classified retries; records HOW the code was produced.
 *
 * Input:  { prompt, model, moduleContext: { name, type, description, dependencies[], iteration } }
 * Output: { code, language, explanation, usage, fallback, simulated, generation }
 *   generation.mode: 'llm' | 'simulated' (provider=simulated, by choice)
 *                    | 'fallback-template' (a real provider FAILED and a template was substituted)
 *
 * LLM_FALLBACK=off makes provider failure throw instead of substituting templates.
 *
 * @param {Object} [deps]  injectable for tests: { providers, sleep }
 */
async function executeWork({ prompt, model, moduleContext }, deps = {}) {
  const providers = deps.providers || DEFAULT_PROVIDERS;
  const provider = modelsConfig.provider;
  const tier = modelsConfig.assignments[moduleContext.type] || 'fast';
  const started = Date.now();

  logger.info(`Worker starting — provider: ${provider}, tier: ${tier}, module: ${moduleContext.name}`, {
    moduleId: moduleContext.moduleId,
    type: moduleContext.type,
    iteration: moduleContext.iteration,
  });

  const generation = { mode: 'llm', provider, model: null, attempts: 0, latencyMs: 0 };
  let code = '';
  let explanation = '';
  let usage = null;

  const retryOpts = {
    maxAttempts: envInt('LLM_MAX_ATTEMPTS', 3),
    baseDelayMs: envInt('LLM_BASE_DELAY_MS', 1000),
    maxRetryWaitMs: envInt('LLM_MAX_RETRY_WAIT_MS', 15000),
    timeoutMs: envInt('LLM_TIMEOUT_MS', 60000),
    sleep: deps.sleep,
    onRetry: ({ attempt, kind, waitMs }) =>
      logger.warn(`LLM call failed (${kind}), retry ${attempt} in ${Math.round(waitMs)}ms`, { moduleId: moduleContext.moduleId }),
  };
  if (!retryOpts.sleep) delete retryOpts.sleep;

  if (provider === 'simulated') {
    code = templateFor(moduleContext);
    generation.mode = 'simulated';
    explanation = 'Generated by simulated worker (template, no LLM)';
    await new Promise((r) => setTimeout(r, 100 + Math.random() * 300));
  } else {
    const providerFn = providers[provider];
    try {
      if (!providerFn) {
        const e = new Error(`Unknown AI provider "${provider}"`);
        e.status = 404; // permanent configuration error: never retried
        throw e;
      }
      const modelName = modelsConfig[provider]?.models?.[tier] || provider;
      const { value, attempts } = await tracer.span('llm.generate', {
        type: 'generation',
        model: modelName,
        input: prompt,
        metadata: { provider, tier, module: moduleContext.name, iteration: moduleContext.iteration },
      }, async (h) => {
        const res = await callWithRetry(async () => {
          const out = await providerFn(prompt, tier, moduleContext);
          if (!out.code || out.code.trim().length < 20) throw new EmptyResponseError();
          return out;
        }, retryOpts);
        h.setOutput(res.value.code);
        h.setUsage(res.value.usage);
        h.setMetadata({ attempts: res.attempts });
        return res;
      });
      code = value.code;
      usage = value.usage;
      generation.model = value.model || modelName;
      generation.attempts = attempts;
      explanation = `Generated by ${provider} (${generation.model})`;
    } catch (err) {
      const info = err.llm || { ...classifyError(err), attempts: 1 };
      generation.attempts = info.attempts;
      generation.fallbackReason = { kind: info.kind, status: info.status ?? null, message: info.message };
      logger.error(`LLM call failed permanently (${info.kind}) after ${info.attempts} attempt(s): ${info.message}`, { moduleId: moduleContext.moduleId });

      if (process.env.LLM_FALLBACK === 'off') {
        const failure = new Error(`LLM provider ${provider} failed (${info.kind}): ${info.message}`);
        failure.llm = info;
        throw failure;
      }
      code = templateFor(moduleContext);
      generation.mode = 'fallback-template';
      explanation = `Fallback to simulated template (${info.kind}: ${info.message})`;
      usage = null;
      tracer.span('llm.fallback', { metadata: { reason: info.kind, module: moduleContext.name } }, async () => {}).catch(() => {});
    }
  }

  generation.latencyMs = Date.now() - started;
  generation.estimatedCostUsd = estimateCostUsd(usage);

  // Store in memory for future reuse
  memory.store(moduleContext.description, code);

  logger.info(`Worker completed — module: ${moduleContext.name}, code length: ${code.length} chars, mode: ${generation.mode}`);

  return {
    code,
    language: 'javascript',
    explanation,
    usage,
    fallback: generation.mode === 'fallback-template',
    simulated: generation.mode === 'simulated',
    generation,
  };
}

module.exports = { executeWork, extractCode, estimateCostUsd };
