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
      fast:    'llama-3.3-70b-versatile',
      quality: 'llama-3.3-70b-versatile',
      light:   'llama-3.1-8b-instant',
    },
  },

  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    models: {
      fast:    'gemini-2.0-flash',
      quality: 'gemini-2.0-flash',
      light:   'gemini-2.0-flash',
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
    groq:      'Groq (Llama 3.3 70B)',
    gemini:    'Google Gemini 2.0 Flash',
    simulated: 'Simulated (Templates)',
  },
};
