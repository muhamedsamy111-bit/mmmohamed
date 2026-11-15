'use strict';

/**
 * JSON backend for the database layer:
 *   GET  /api/family/lookup?nid=...        nid -> db id (staff)
 *   GET  /api/families/:id/summary         everything about one customer
 *   GET  /api/families/:id/children        list children + twin groups
 *   POST /api/families/:id/children        add a child (twin-aware)
 *   GET  /api/families/:id/pregnancy       current pregnancy record
 *   POST /api/families/:id/pregnancy       set pregnancy (twins_expected, twin_type)
 *   GET  /api/families/:id/documents       documents + insurance readiness
 *
 * Access: admin + employee (governorate-scoped like the health routes).
 * A `user` may only touch families they registered themselves
 * (added_by === username, same rule as my_labs).
 */

const express = require('express');
const { def } = require('./registry');
const models = require('../db/models');

const router = express.Router();

function resolveFamily(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ ok: false, msg: 'رقم الأسرة غير صحيح.' });
    return null;
  }
  const family = models.getFamilyById(id);
  if (!family) {
    res.status(404).json({ ok: false, msg: 'الأسرة غير موجودة.' });
    return null;
  }
  if (req.user.role === 'user' && family.added_by !== req.user.username) {
    res.status(403).json({ ok: false, msg: 'غير مسموح: هذه ليست أسرتك المسجلة.' });
    return null;
  }
  if (req.user.role === 'employee' && req.user.governorate
      && family.governorate && family.governorate !== req.user.governorate) {
    res.status(403).json({ ok: false, msg: 'غير مسموح: الأسرة خارج محافظتك.' });
    return null;
  }
  return family;
}

function guardStaff(req, res) {
  if (req.user.role !== 'admin' && req.user.role !== 'employee') {
    res.status(403).json({ ok: false, msg: 'غير مسموح.' });
    return false;
  }
  return true;
}

def(router, {
  name: 'api_family_lookup',
  method: 'get',
  path: '/api/family/lookup',
  handler: async (req, res) => {
    if (!guardStaff(req, res)) return;
    const nid = String((req.query && req.query.nid) || '').trim();
    const family = nid ? models.getFamilyByNid(nid) : null;
    if (!family) return res.status(404).json({ ok: false, msg: 'لا توجد أسرة بهذا الرقم القومي في قاعدة البيانات.' });
    res.json({ ok: true, id: family.id, name: family.name });
  }
});

def(router, {
  name: 'api_family_summary',
  method: 'get',
  path: '/api/families/:id/summary',
  handler: async (req, res) => {
    const family = resolveFamily(req, res);
    if (!family) return;
    res.json({ ok: true, summary: models.familySummary(family.id) });
  }
});

def(router, {
  name: 'api_family_children',
  method: 'get',
  path: '/api/families/:id/children',
  handler: async (req, res) => {
    const family = resolveFamily(req, res);
    if (!family) return;
    res.json({
      ok: true,
      children: models.getChildren(family.id),
      twin_groups: models.getTwinGroups(family.id),
      twin_types: models.TWIN_LABELS
    });
  }
});

def(router, {
  name: 'api_family_children_add',
  method: 'post',
  path: '/api/families/:id/children',
  handler: async (req, res) => {
    if (!guardStaff(req, res)) return;
    const family = resolveFamily(req, res);
    if (!family) return;
    const body = req.body || {};
    const created = models.addChild(family.id, {
      name: body.name,
      birth_date: body.birth_date,
      gender: body.gender,
      national_id: body.national_id,
      birth_certificate_no: body.birth_certificate_no,
      birth_certificate_file: body.birth_certificate_file,
      relation: body.relation,
      is_twin: body.is_twin,
      twin_group_id: body.twin_group_id,
      twin_type: body.twin_type,
      notes: body.notes
    });
    if (!created.ok) return res.status(400).json(created);
    const linked = models.detectAndLinkTwins(family.id, body.birth_date);
    res.json({ ok: true, id: created.id, twin_group_id: created.twin_group_id, auto_linked_twins: linked });
  }
});

def(router, {
  name: 'api_family_pregnancy',
  method: 'get',
  path: '/api/families/:id/pregnancy',
  handler: async (req, res) => {
    const family = resolveFamily(req, res);
    if (!family) return;
    res.json({
      ok: true,
      current: models.getCurrentPregnancy(family.id),
      history: models.getPregnancies(family.id)
    });
  }
});

def(router, {
  name: 'api_family_pregnancy_set',
  method: 'post',
  path: '/api/families/:id/pregnancy',
  handler: async (req, res) => {
    if (!guardStaff(req, res)) return;
    const family = resolveFamily(req, res);
    if (!family) return;
    const body = req.body || {};
    const saved = models.setPregnancy(family.id, {
      status: body.status,
      expected_delivery: body.expected_delivery,
      last_visit: body.last_visit,
      followup: body.followup,
      twins_expected: body.twins_expected,
      twin_type: body.twin_type,
      notes: body.notes
    });
    if (!saved.ok) return res.status(400).json(saved);
    res.json({ ok: true, id: saved.id, summary: models.familySummary(family.id) });
  }
});

def(router, {
  name: 'api_family_documents',
  method: 'get',
  path: '/api/families/:id/documents',
  handler: async (req, res) => {
    const family = resolveFamily(req, res);
    if (!family) return;
    res.json({
      ok: true,
      documents: models.getDocuments('family', family.id),
      doc_labels: models.DOC_LABELS,
      insurance: models.insuranceStatus(family.id)
    });
  }
});

module.exports = router;
