'use strict';

/**
 * Authentication + role based access control (mirrors app.py's flask-login
 * usage and the `enforce_role_access` before_request hook).
 */

const { flash } = require('../jinja/context');

function redirectForRole(role) {
  switch (role) {
    case 'admin':
      return '/dashboard';
    case 'employee':
      return '/employee';
    case 'psychologist':
      return '/mental/ppd';
    case 'user':
      return '/home';
    default:
      return '/login';
  }
}

function requireAuth(req, res, next) {
  const user = req.session ? req.session.user : null;
  if (!user) {
    const wantsJson = req.xhr || (req.headers.accept || '').includes('json')
      || req.path.startsWith('/api/');
    if (wantsJson) return res.status(401).json({ error: 'Unauthorized' });
    flash(req, 'لازم تسجّل الدخول الأول', 'warning');
    return res.redirect('/login');
  }
  req.user = user;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    const user = req.session ? req.session.user : null;
    if (!user) {
      flash(req, 'لازم تسجّل الدخول الأول', 'warning');
      return res.redirect('/login');
    }
    req.user = user;
    if (!roles.includes(user.role)) {
      flash(req, 'مش مسموح لك بدخول هذه الصفحة', 'danger');
      return res.redirect(redirectForRole(user.role));
    }
    next();
  };
}

/* ------------------------------------------------
 * Endpoint allow-lists (verbatim from app.py)
 * ------------------------------------------------ */
const EMPLOYEE_ALLOWED_ENDPOINTS = new Set([
  'welcome', 'index', 'families', 'employee_home', 'change_password', 'login', 'logout',
  'static', 'register_birth', 'births_list', 'download_document', 'set_request_status',
  'health_alerts_view', 'health_stats_view', 'health_caravans', 'health_caravans_export',
  'health_referral', 'health_gap', 'health_family_labs', 'download_lab',
  'api_family_lookup', 'api_family_summary', 'api_family_children',
  'api_family_children_add', 'api_family_pregnancy', 'api_family_pregnancy_set',
  'api_family_documents',
  'shop_browse', 'shop_cart', 'shop_add', 'shop_checkout', 'shop_orders', 'shop_rental_update', 'shop_product_image',
  'community_home', 'community_new_post', 'community_thread', 'community_reply', 'community_like',
  'community_post_delete', 'community_reply_delete',
  'pipeline_demo'
]);

const USER_ALLOWED_ENDPOINTS = new Set([
  'welcome', 'public_home', 'account_home', 'my_support', 'register_family',
  'change_password', 'login', 'logout', 'signup', 'static', 'my_labs', 'download_lab',
  'api_family_summary', 'api_family_children', 'api_family_pregnancy',
  'api_family_documents',
  'shop_browse', 'shop_cart', 'shop_add', 'shop_checkout', 'shop_orders', 'shop_product_image',
  'community_home', 'community_new_post', 'community_thread', 'community_reply', 'community_like',
  'community_post_delete', 'community_reply_delete',
  'pipeline_demo'
]);

const PSYCH_ALLOWED_ENDPOINTS = new Set([
  'welcome', 'ppd_list', 'ppd_record', 'change_password', 'login', 'logout', 'static',
  'pipeline_demo'
]);

/**
 * Global guard. Route modules tag each request with its Flask endpoint name so
 * this works exactly like the Python before_request hook.
 */
function enforceRoleAccess(req, res, next) {
  const user = req.session ? req.session.user : null;
  const endpoint = req.endpointName;
  if (!user || !endpoint) return next();

  if (user.role === 'employee' && !EMPLOYEE_ALLOWED_ENDPOINTS.has(endpoint)) {
    flash(req, 'ليس لديك صلاحية للوصول لهذه الصفحة — يمكنك فقط إضافة/تعديل بيانات الأسر', 'warning');
    return res.redirect('/employee');
  }
  if (user.role === 'psychologist' && !PSYCH_ALLOWED_ENDPOINTS.has(endpoint)) {
    flash(req, 'هذه الصفحات خاصة بالأخصائي النفسي: قائمة أمهات ما بعد الولادة فقط', 'warning');
    return res.redirect('/mental/ppd');
  }
  if (user.role === 'user' && !USER_ALLOWED_ENDPOINTS.has(endpoint)) {
    flash(req, 'ليس لديك صلاحية للوصول لهذه الصفحة', 'warning');
    return res.redirect('/home');
  }
  return next();
}

module.exports = {
  requireAuth,
  requireRole,
  redirectForRole,
  enforceRoleAccess,
  EMPLOYEE_ALLOWED_ENDPOINTS,
  USER_ALLOWED_ENDPOINTS,
  PSYCH_ALLOWED_ENDPOINTS
};
