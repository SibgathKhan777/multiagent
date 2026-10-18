const mongoose = require('mongoose');

const moduleSchema = new mongoose.Schema({
  moduleId:      { type: String, required: true, unique: true, index: true },
  taskId:        { type: String, required: true, index: true },
  name:          { type: String, required: true },
  description:   { type: String, required: true },
  type:          { type: String, default: 'default' },   // api, database, authentication, etc.
  dependencies:  [{ type: String }],                      // other module names this depends on
  priority:      { type: Number, default: 0 },
  prompt:        { type: String, default: '' },
  output:        { type: String, default: '' },           // generated code
  language:      { type: String, default: 'javascript' },
  status:        {
    type: String,
    enum: ['pending', 'prompting', 'queued', 'building', 'validating', 'feedback', 'completed', 'failed'],
    default: 'pending',
  },
  qualityScore:  { type: Number, default: 0 },
  validationPassed: { type: Boolean, default: false }, // false = accepted after retries without passing
  usedFallback:  { type: Boolean, default: false },     // true = LLM failed, template code substituted
  iteration:     { type: Number, default: 0 },
  assignedModel: { type: String, default: 'gpt-4' },
}, { timestamps: true });

module.exports = mongoose.model('Module', moduleSchema);
