/**
 * AI Model Registry
 *
 * provider (set via AI_PROVIDER env var):
 *   "groq"       = Groq API (free Llama 3 / Mixtral)
 *   "gemini"     = Google Gemini API
 *   "simulated"  = No API needed, template-based generation
 */
module.exports = {
  // Current provider — controlled by env var
  provider: process.env.AI_PROVIDER || 'groq',

  groq: {
    apiKey: process.env.GROQ_API_KEY,
    models: {
      // Verified available on a Groq free account (Llama 3.x ids were retired upstream)
      fast:    process.env.GROQ_MODEL_FAST    || 'openai/gpt-oss-120b',
      quality: process.env.GROQ_MODEL_QUALITY || 'openai/gpt-oss-120b',
      light:   process.env.GROQ_MODEL_LIGHT   || 'openai/gpt-oss-20b',
    },
  },

  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    models: {
      // gemini-2.0-flash was retired; this is the id the API itself recommended (verified)
      fast:    process.env.GEMINI_MODEL_FAST    || 'gemini-3.8-flash',
      quality: process.env.GEMINI_MODEL_QUALITY || 'gemini-3.8-flash',
      light:   process.env.GEMINI_MODEL_LIGHT   || 'gemini-3.8-flash',
    },
  },

  // Model assignments per module type
  assignments: {
    'api':            'quality',
    'database':       'quality',
    'authentication': 'quality',
    'business-logic': 'quality',
    'middleware':     'fast',
    'utilities':     'light',
    'config':        'light',
    'default':       'fast',
  },

  // Display names for logging
  displayNames: {
    groq:      'Groq (gpt-oss)',
    gemini:    'Google Gemini 3.8 Flash',
    simulated: 'Simulated (Templates)',
  },
};
