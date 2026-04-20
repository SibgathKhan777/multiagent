const Groq = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const modelsConfig = require('../../config/models');
const memory = require('../memory/memory');
const logger = require('../utils/logger').forAgent('Worker');
const aiService = require('../services/aiService');

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

  return response.choices[0]?.message?.content || '';
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

  return result.response.text() || '';
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
  let code = raw.trim();

  // Remove markdown code fences
  code = code.replace(/^```(?:javascript|js|node)?\s*\n?/im, '');
  code = code.replace(/\n?```\s*$/im, '');

  // Remove any leading text before first require/const/'use strict'
  const codeStart = code.search(/^(?:'use strict'|"use strict"|const |let |var |\/\/|\/\*|require\(|module\.)/m);
  if (codeStart > 0) {
    code = code.substring(codeStart);
  }

  return code.trim();
}

// ─── Main Worker Function ───────────────────────────────────────────────────

/**
 * Worker Agent — Calls real LLM APIs or falls back to simulated templates.
 *
 * Input:  { prompt: string, model: string, moduleContext: { name, type, description, dependencies[], iteration } }
 * Output: { code: string, language: string, explanation: string }
 */
async function executeWork({ prompt, model, moduleContext }) {
  const provider = modelsConfig.provider;
  const tier = modelsConfig.assignments[moduleContext.type] || 'fast';

  logger.info(`Worker starting — provider: ${provider}, tier: ${tier}, module: ${moduleContext.name}`, {
    moduleId: moduleContext.moduleId,
    type: moduleContext.type,
    iteration: moduleContext.iteration,
  });

  // Memory cache is disabled for cross-project reuse — each project idea
  // now produces unique descriptions, so we skip cache entirely on first iteration
  // to ensure fresh, idea-specific code generation from the LLM.
  // Cache is only used for re-iterations within the same pipeline run.

  let code = '';
  let explanation = '';

  try {
    if (provider === 'groq') {
      const raw = await callGroq(prompt, tier);
      code = extractCode(raw);
      explanation = `Generated by Groq (${modelsConfig.groq.models[tier]})`;
    } else if (provider === 'gemini') {
      const raw = await callGemini(prompt, tier);
      code = extractCode(raw);
      explanation = `Generated by Gemini (${modelsConfig.gemini.models[tier]})`;
    } else if (provider === 'python-ai') {
      const idea = moduleContext.description || moduleContext.name;
      const result = await aiService.callGraph(idea, moduleContext.taskId || '');
      code = extractCode(result.code || '');
      explanation = `Generated by Python AI service (review_score=${result.review_score ?? 'n/a'})`;
    } else {
      // Simulated fallback
      const templateFn = SIMULATED_TEMPLATES[moduleContext.type] || SIMULATED_TEMPLATES.default;
      code = templateFn(moduleContext);
      explanation = 'Generated by simulated worker (template)';
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 300));
    }
  } catch (err) {
    logger.error(`LLM API call failed: ${err.message}, falling back to simulated`, {
      moduleId: moduleContext.moduleId,
      error: err.message,
    });

    // Fallback to simulated
    const templateFn = SIMULATED_TEMPLATES[moduleContext.type] || SIMULATED_TEMPLATES.default;
    code = templateFn(moduleContext);
    explanation = `Fallback to simulated (API error: ${err.message})`;
  }

  // Ensure code is not empty
  if (!code || code.trim().length < 20) {
    logger.warn('LLM returned empty/short code, using simulated fallback');
    const templateFn = SIMULATED_TEMPLATES[moduleContext.type] || SIMULATED_TEMPLATES.default;
    code = templateFn(moduleContext);
    explanation = 'Fallback to simulated (empty LLM response)';
  }

  // Store in memory for future reuse
  memory.store(moduleContext.description, code);

  logger.info(`Worker completed — module: ${moduleContext.name}, code length: ${code.length} chars, provider: ${provider}`);

  return {
    code,
    language: 'javascript',
    explanation,
  };
}

module.exports = { executeWork };
