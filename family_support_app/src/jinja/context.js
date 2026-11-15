'use strict';

/**
 * Builds the context object handed to EJS for each page render, emulating the
 * parts of Flask's Jinja environment that this project's templates rely on:
 * url_for(), request, current_user, get_flashed_messages().
 */

const helpers = require('./runtime');

/** endpoint name -> URL pattern */
const routeTable = new Map();

function registerRoute(name, pattern) {
  routeTable.set(name, pattern);
}

function urlFor(name, params) {
  let pattern = routeTable.get(name);
  if (pattern === undefined) {
    // Fall back to the literal path so a missing registration is visible but harmless.
    return '/' + String(name).replace(/_/g, '-');
  }
  const used = new Set();
  pattern = pattern.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (m, key) => {
    const value = params ? params[key] : undefined;
    if (value === undefined || value === null) return m;
    used.add(key);
    return encodeURIComponent(String(value));
  });
  if (params) {
    const extra = Object.keys(params)
      .filter(k => !used.has(k) && params[k] !== undefined && params[k] !== null)
      .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`);
    if (extra.length) pattern += (pattern.includes('?') ? '&' : '?') + extra.join('&');
  }
  return pattern;
}

function flash(req, message, category) {
  if (!req.session) return;
  if (!Array.isArray(req.session.flash)) req.session.flash = [];
  req.session.flash.push([category || 'info', message]);
}

/** Jinja's get_flashed_messages(with_categories=true) -> [[category, message], ...] */
function getFlashedMessages(req) {
  const list = (req.session && Array.isArray(req.session.flash)) ? req.session.flash : [];
  if (req.session) req.session.flash = [];
  return list;
}

function currentUserFor(req) {
  const u = req.session ? req.session.user : null;
  return {
    is_authenticated: Boolean(u),
    username: u ? u.username : '',
    role: u ? u.role : '',
    name: u ? u.name : '',
    governorate: u ? (u.governorate || '') : ''
  };
}

function requestFor(req) {
  const query = {};
  Object.keys(req.query || {}).forEach(k => { query[k] = req.query[k]; });
  const form = {};
  Object.keys(req.body || {}).forEach(k => { form[k] = req.body[k]; });
  return {
    path: req.path,
    method: req.method,
    url: req.originalUrl,
    args: query,
    query,
    form,
    endpoint: req.route ? (req.route.name || '') : ''
  };
}

/** app.py's inject_layout context processor. */
function layoutFor(req) {
  const role = req.session && req.session.user ? req.session.user.role : null;
  if (role === 'employee' || role === 'psychologist') return 'base_employee.html';
  if (role === 'user') return 'base_public.html';
  return 'base.html';
}

/** Assemble the full render context for a request. */
function buildContext(req, data) {
  return Object.assign(
    {},
    helpers,
    {
      url_for: urlFor,
      get_flashed_messages: () => getFlashedMessages(req),
      request: requestFor(req),
      current_user: currentUserFor(req),
      layout: layoutFor(req),
      session: req.session || {}
    },
    data || {}
  );
}

module.exports = {
  registerRoute,
  urlFor,
  flash,
  getFlashedMessages,
  buildContext,
  routeTable
};
