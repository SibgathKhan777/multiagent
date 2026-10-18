const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema({
  taskId:      { type: String, required: true, unique: true, index: true },
  idea:        { type: String, required: true },
  status:      {
    type: String,
    enum: ['pending', 'decomposing', 'prompting', 'building', 'validating', 'feedback-loop', 'integrating', 'awaiting-approval', 'completed', 'failed', 'cancelled'],
    default: 'pending',
  },
  modules:     [{ type: String, ref: 'Module' }],  // moduleId references
  finalOutput: { type: mongoose.Schema.Types.Mixed, default: null },
  error:       { type: String, default: null },
  runId:       { type: String, default: null },   // id of the current execution attempt (changes on resume)
  repairRound: { type: Number, default: 0 },       // sandbox repair rounds already spent (survives restarts)
  resumeCount: { type: Number, default: 0 },       // how many times startup recovery re-launched this task
  metadata:    {
    totalModules:    { type: Number, default: 0 },
    completedModules:{ type: Number, default: 0 },
    totalIterations: { type: Number, default: 0 },
  },
}, { timestamps: true });

module.exports = mongoose.model('Task', taskSchema);
