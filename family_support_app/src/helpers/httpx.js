'use strict';

/** Small request-parsing helpers (Flask's request.args.get / request.form.get). */

function q(req, key, def = '') {
  const v = req.query ? req.query[key] : undefined;
  return v === undefined || v === null ? def : v;
}

function qint(req, key, def = 0) {
  const v = parseInt(q(req, key, ''), 10);
  return Number.isNaN(v) ? def : v;
}

function f(req, key, def = '') {
  const v = req.body ? req.body[key] : undefined;
  if (Array.isArray(v)) return v.length ? v[0] : def;
  return v === undefined || v === null ? def : v;
}

function fall(req, key, def = []) {
  const v = req.body ? req.body[key] : undefined;
  if (v === undefined || v === null) return def;
  return Array.isArray(v) ? v : [v];
}

/** Multer's file payloads keyed the way the Python code used request.files. */
function files(req, field) {
  if (req.file && (!field || req.file.fieldname === field)) return [req.file];
  if (!req.files) return [];
  if (Array.isArray(req.files)) return req.files.filter(x => x.fieldname === field);
  return req.files[field] || [];
}

function file(req, field) {
  return files(req, field)[0] || null;
}

module.exports = { q, qint, f, fall, files, file };
