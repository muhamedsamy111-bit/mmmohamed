'use strict';

/**
 * Facade that mirrors the scoring helpers from app.py / health_rules.py so the
 * route handlers read like the original Python.
 */

const { calculatePriority, calculatePrioritySimple } = require('./priorityShim');
const healthRules = require('../config/healthRules');
const { toNum, healthScore, totalScore, healthAlerts, burdenPct, hasHealthData, isPostpartum, ppdRisk, ALERT_TYPES, ALERT_BADGE, PPD_RANK, CONFIG } = healthRules;

// `health_rules._days_since` in Python; the JS module calls it daysSince.
const daysSince = healthRules.daysSince;

/** Python returned (score, level, color, breakdown); keep that shape. */
function priorityTuple(children, income, hasDisabled, hasOrphans) {
  const r = calculatePriority(children, income, hasDisabled, hasOrphans);
  return [r.score, r.level, r.color, r.breakdown];
}

function prioritySimple(children, income, hasDisabled, hasOrphans) {
  return calculatePrioritySimple(children, income, hasDisabled, hasOrphans);
}

/**
 * Alerts for a family, optionally adding the PPD screening alert.
 * Mirrors app.py::_alerts_for.
 */
function alertsFor(row, screened) {
  const alerts = healthAlerts(row).slice();
  if (screened && isPostpartum(row) && !screened.has(row['الرقم القومي'])) {
    alerts.push('ppd');
  }
  return alerts;
}

function pct(a, b) {
  if (!b) return null;
  return Math.round((a / b) * 1000) / 10;
}

function burdenLabel(b) {
  if (b === null || b === undefined) return '—';
  if (b === Infinity) return 'لا يوجد دخل';
  return `${b}%`;
}

module.exports = {
  priorityTuple,
  prioritySimple,
  alertsFor,
  pct,
  burdenLabel,
  ALERT_TYPES,
  ALERT_BADGE,
  PPD_RANK,
  CONFIG,
  toNum,
  healthScore,
  totalScore,
  healthAlerts,
  burdenPct,
  hasHealthData,
  isPostpartum,
  ppdRisk,
  daysSince
};
