'use strict';

/**
 * Thin wrapper over the audit service so route handlers can call audit(req, ...)
 * before/without the auth middleware having populated req.user.
 */

const { logAudit, AUDIT_LABELS, maskNid, getAuditLogs } = require('../services/auditService');

function audit(req, action, target = '', details = '') {
  if (req && !req.user && req.session && req.session.user) req.user = req.session.user;
  try {
    logAudit(req, action, target, details);
  } catch {
    // Audit logging must never break a request.
  }
}

module.exports = { audit, AUDIT_LABELS, maskNid, getAuditLogs };
