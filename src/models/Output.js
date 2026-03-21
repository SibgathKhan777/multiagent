const mongoose = require('mongoose');

const outputSchema = new mongoose.Schema({
  outputId:   { type: String, required: true, unique: true, index: true },
  moduleId:   { type: String, required: true, index: true },
  taskId:     { type: String, required: true, index: true },
  code:       { type: String, required: true },
  language:   { type: String, default: 'javascript' },
  iteration:  { type: Number, default: 1 },
  score:      { type: Number, default: 0 },
  model:      { type: String, default: '' },
  explanation:{ type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('Output', outputSchema);
