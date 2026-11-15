'use strict';

/**
 * Wrapper around the existing priorityCalculator service so this module can
 * expose the triple-return signature used throughout app.py.
 */

const calc = require('../services/priorityCalculator');

function calculatePriority(children, income, hasDisabled, hasOrphans) {
  return calc.calculatePriority(children, income, hasDisabled, hasOrphans);
}

function calculatePrioritySimple(children, income, hasDisabled, hasOrphans) {
  const r = calc.calculatePriority(children, income, hasDisabled, hasOrphans);
  return [r.score, r.level, r.color];
}

module.exports = {
  calculatePriority,
  calculatePrioritySimple,
  normalizeNid: calc.normalizeNid,
  validateNationalIdFormat: calc.validateNationalIdFormat,
  STRICT_NID_VALIDATION: calc.STRICT_NID_VALIDATION
};
