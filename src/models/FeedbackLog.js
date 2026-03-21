const mongoose = require('mongoose');

const issueSchema = new mongoose.Schema({
  type:     { type: String, enum: ['error', 'warning', 'suggestion'], default: 'warning' },
  message:  { type: String, required: true },
  severity: { type: Number, min: 1, max: 10, default: 5 },
}, { _id: false });

const feedbackLogSchema = new mongoose.Schema({
  feedbackId:    { type: String, required: true, unique: true, index: true },
  moduleId:      { type: String, required: true, index: true },
  taskId:        { type: String, required: true, index: true },
  iteration:     { type: Number, required: true },
  issues:        [issueSchema],
  refinedPrompt: { type: String, default: '' },
  previousScore: { type: Number, default: 0 },
  newScore:      { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('FeedbackLog', feedbackLogSchema);
