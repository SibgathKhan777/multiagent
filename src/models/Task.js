const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema({
  taskId:      { type: String, required: true, unique: true, index: true },
  idea:        { type: String, required: true },
  status:      {
    type: String,
    enum: ['pending', 'decomposing', 'prompting', 'building', 'validating', 'feedback-loop', 'integrating', 'completed', 'failed'],
    default: 'pending',
  },
  modules:     [{ type: String, ref: 'Module' }],  // moduleId references
  finalOutput: { type: mongoose.Schema.Types.Mixed, default: null },
  error:       { type: String, default: null },
  metadata:    {
    totalModules:    { type: Number, default: 0 },
    completedModules:{ type: Number, default: 0 },
    totalIterations: { type: Number, default: 0 },
  },
}, { timestamps: true });

module.exports = mongoose.model('Task', taskSchema);
