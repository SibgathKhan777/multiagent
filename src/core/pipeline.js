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
  AWAITING_APPROVAL: 'awaiting-approval',
  COMPLETED:     'completed',
  FAILED:        'failed',
  CANCELLED:     'cancelled',
};

// Prompts are generated per module right before it is built (so they can reference
// the real exports of already-built siblings), hence DECOMPOSING → BUILDING.
const TRANSITIONS = {
  [STAGES.CREATED]:       [STAGES.DECOMPOSING, STAGES.FAILED, STAGES.CANCELLED],
  [STAGES.DECOMPOSING]:   [STAGES.PROMPTING, STAGES.BUILDING, STAGES.FAILED, STAGES.CANCELLED],
  [STAGES.PROMPTING]:     [STAGES.BUILDING, STAGES.FAILED, STAGES.CANCELLED],
  [STAGES.BUILDING]:      [STAGES.VALIDATING, STAGES.FAILED, STAGES.CANCELLED],
  [STAGES.VALIDATING]:    [STAGES.FEEDBACK_LOOP, STAGES.INTEGRATING, STAGES.FAILED, STAGES.CANCELLED],
  [STAGES.FEEDBACK_LOOP]: [STAGES.BUILDING, STAGES.INTEGRATING, STAGES.FAILED, STAGES.CANCELLED],
  [STAGES.INTEGRATING]:   [STAGES.AWAITING_APPROVAL, STAGES.COMPLETED, STAGES.FAILED, STAGES.CANCELLED],
  // optional human gate before generated code is executed (REQUIRE_EXECUTION_APPROVAL)
  [STAGES.AWAITING_APPROVAL]: [STAGES.INTEGRATING, STAGES.COMPLETED, STAGES.FAILED, STAGES.CANCELLED],
  [STAGES.COMPLETED]:     [],
  [STAGES.FAILED]:        [],
  [STAGES.CANCELLED]:     [],
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

  /** Re-enter a persisted stage after a restart (no transition validation). */
  restore(stage) {
    if (!Object.values(STAGES).includes(stage)) throw new Error(`Unknown stage: ${stage}`);
    this.currentStage = stage;
    this.history.push({ stage, timestamp: new Date(), restored: true });
    return this;
  }

  get stage() { return this.currentStage; }
  get isTerminal() { return [STAGES.COMPLETED, STAGES.FAILED, STAGES.CANCELLED].includes(this.currentStage); }
}

module.exports = { STAGES, PipelineState };
