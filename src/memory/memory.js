const logger = require('../utils/logger').forAgent('Memory');

/**
 * Memory System
 * - In-memory LRU-style cache for fast lookups
 * - MongoDB persistence via Output model for durability
 * - Used by Worker Agent to reuse past outputs for similar modules
 */
class MemorySystem {
  constructor(maxSize = 100) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  /**
   * Store a key-value pair (description → output).
   */
  store(key, value) {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    this.cache.set(key.toLowerCase().trim(), value);
    logger.info(`Stored in memory: "${key.substring(0, 60)}..."`, { cacheSize: this.cache.size });
  }

  /**
   * Retrieve an exact match from cache.
   */
  retrieve(key) {
    const val = this.cache.get(key.toLowerCase().trim());
    if (val) {
      logger.info(`Cache HIT: "${key.substring(0, 60)}..."`);
    }
    return val || null;
  }

  /**
   * Find the best matching cached output using keyword overlap scoring.
   * Returns { key, value, score } if score >= threshold, else null.
   */
  findSimilar(description, threshold = 0.5) {
    const descWords = new Set(this._tokenize(description));
    let bestMatch = null;
    let bestScore = 0;

    for (const [key, value] of this.cache) {
      const keyWords = new Set(this._tokenize(key));
      const intersection = [...descWords].filter((w) => keyWords.has(w));
      const union = new Set([...descWords, ...keyWords]);
      const score = intersection.length / union.size; // Jaccard similarity

      if (score > bestScore) {
        bestScore = score;
        bestMatch = { key, value, score };
      }
    }

    if (bestMatch && bestMatch.score >= threshold) {
      logger.info(`Similar match found (score: ${bestMatch.score.toFixed(2)}): "${bestMatch.key.substring(0, 60)}..."`);
      return bestMatch;
    }

    return null;
  }

  /**
   * Load past outputs from MongoDB into cache.
   */
  async loadFromDB() {
    try {
      const Output = require('../models/Output');
      const outputs = await Output.find().sort({ createdAt: -1 }).limit(this.maxSize).lean();
      for (const out of outputs) {
        const key = `${out.moduleId}:${out.iteration}`;
        this.cache.set(key, { code: out.code, score: out.score });
      }
      logger.info(`Loaded ${outputs.length} outputs from DB into memory`);
    } catch (err) {
      logger.warn('Could not load memory from DB', { error: err.message });
    }
  }

  /**
   * Tokenize a string into lowercase words, filtering noise.
   */
  _tokenize(str) {
    return str
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2);
  }

  /**
   * Clear the cache.
   */
  clear() {
    this.cache.clear();
    logger.info('Memory cache cleared');
  }

  get size() {
    return this.cache.size;
  }
}

// Singleton
module.exports = new MemorySystem();
