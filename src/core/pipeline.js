const logger = require('../utils/logger').forAgent('Pipeline');

/**
 * Pipeline State Machine
 *
 * Manages valid stage transitions for the factory pipeline.
 *
 * Stages:
 *   CREATED → DECOMPOSING → PROMPTING → BUILDING → VALIDATING
 *   → FEEDBACK_LOOP → BUILDING (loop) → INTEGRATING → COMPLETED
 *   Any stage → FAILED
 */

const STAGES = {
  CREATED:       'created',
  DECOMPOSING:   'decomposing',
  PROMPTING:     'prompting',
  BUILDING:      'building',
  VALIDATING:    'validating',
  FEEDBACK_LOOP: 'feedback-loop',
  INTEGRATING:   'integrating',
  COMPLETED:     'completed',
  FAILED:        'failed',
};

const TRANSITIONS = {
  [STAGES.CREATED]:       [STAGES.DECOMPOSING, STAGES.FAILED],
  [STAGES.DECOMPOSING]:   [STAGES.PROMPTING, STAGES.FAILED],
  [STAGES.PROMPTING]:     [STAGES.BUILDING, STAGES.FAILED],
  [STAGES.BUILDING]:      [STAGES.VALIDATING, STAGES.FAILED],
  [STAGES.VALIDATING]:    [STAGES.FEEDBACK_LOOP, STAGES.INTEGRATING, STAGES.FAILED],
  [STAGES.FEEDBACK_LOOP]: [STAGES.BUILDING, STAGES.INTEGRATING, STAGES.FAILED],
  [STAGES.INTEGRATING]:   [STAGES.COMPLETED, STAGES.FAILED],
  [STAGES.COMPLETED]:     [],
  [STAGES.FAILED]:        [],
};

class PipelineState {
  constructor(taskId) {
    this.taskId = taskId;
    this.currentStage = STAGES.CREATED;
    this.history = [{ stage: STAGES.CREATED, timestamp: new Date() }];
  }

  /**
   * Transition to a new stage. Throws if transition is invalid.
   */
  transition(newStage) {
    const allowed = TRANSITIONS[this.currentStage] || [];
    if (!allowed.includes(newStage)) {
      const msg = `Invalid transition: ${this.currentStage} → ${newStage}`;
      logger.error(msg, { taskId: this.taskId });
      throw new Error(msg);
    }

    logger.info(`Pipeline transition: ${this.currentStage} → ${newStage}`, { taskId: this.taskId });
    this.currentStage = newStage;
    this.history.push({ stage: newStage, timestamp: new Date() });
    return this;
  }

  get stage() { return this.currentStage; }
  get isTerminal() { return [STAGES.COMPLETED, STAGES.FAILED].includes(this.currentStage); }
}

module.exports = { STAGES, PipelineState };
