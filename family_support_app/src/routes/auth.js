'use strict';

/**
 * Authentication / public routes (port of the matching app.py endpoints):
 *   welcome, login, signup, logout, public_home, employee_home,
 *   account_home, my_support, security_page, change_password
 *
 * Also exports `fetch_health_news`, the plain (non-route) helper app.py uses.
 */

const fs = require('fs');
const express = require('express');

const { def } = require('./registry');
const { redirectForRole } = require('../middlewares/authMiddleware');
const { f } = require('../helpers/httpx');
const {
  clientIp,
  isBlocked,
  recordFailedAttempt,
  recordSuccess,
  failedAttempts,
  getSecurityLog,
  isStrongPassword
} = require('../helpers/security');
const {
  getAllUsers,
  verifyPassword,
  registerUser,
  changeUserPassword
} = require('../services/authService');
const { audit } = require('../helpers/audit');
const { flash } = require('../jinja/context');
const { fetchHealthNews } = require('../helpers/news');
const { loadJson, getFamilies, LABS_INDEX, CAPMAS_FILE } = require('../helpers/paths');

const router = express.Router();

// app.py: DEFAULT_PASSWORDS = {"admin123", "employee123", "user123"}
const DEFAULT_PASSWORDS = new Set(['admin123', 'employee123', 'user123']);

/** Non-route helper: port of app.py's fetch_health_news(limit=6). */
async function fetch_health_news(limit = 6) {
  return fetchHealthNews(limit);
}

/* ============================================================ *
 * /  welcome
 * ============================================================ */
def(router, {
  name: 'welcome',
  path: '/',
  auth: false,
  handler: async (req, res) => {
    if (req.session && req.session.user) {
      return res.redirect(redirectForRole(req.session.user.role));
    }
    const news = await fetch_health_news(3);
    let stats = { families: 0, governorates: 0, pregnant: 0, twins: 0 };
    try {
      const { getDb } = require('../db/index');
      const db = getDb();
      stats.families = db.prepare('SELECT COUNT(*) n FROM families').get().n;
      stats.governorates = db.prepare('SELECT COUNT(DISTINCT governorate) n FROM families WHERE governorate IS NOT NULL AND governorate != ""').get().n;
      stats.pregnant = db.prepare("SELECT COUNT(*) n FROM families WHERE is_pregnant = 'نعم'").get().n;
      stats.twins = db.prepare('SELECT COUNT(DISTINCT twin_group_id) n FROM children WHERE is_twin = 1 AND twin_group_id IS NOT NULL').get().n;
    } catch { /* stats stay zero, page still renders */ }
    return res.view('welcome.html', { health_news: news, stats });
  }
});

/* ============================================================ *
 * /login
 * ============================================================ */
def(router, {
  name: 'login',
  method: ['get', 'post'],
  path: '/login',
  auth: false,
  handler: async (req, res) => {
    if (req.session && req.session.user) {
      return res.redirect(redirectForRole(req.session.user.role));
    }

    let error = null;

    if (req.method === 'POST') {
      const username = f(req, 'username');
      const password = f(req, 'password');

      const ip = clientIp(req);
      const users = getAllUsers();

      if (isBlocked(ip)) {
        error = 'تم حجب هذا الجهاز مؤقتاً بسبب محاولات دخول متعددة. انتظر 5 دقائق.';
      } else if (username && users[username] && verifyPassword(password, users[username].password)) {
        const info = users[username];
        req.session.user = {
          username,
          role: info.role,
          name: info.name,
          governorate: info.governorate || ''
        };
        recordSuccess(ip, username);
        audit(req, 'login_success', '', username);

        if (DEFAULT_PASSWORDS.has(password)) {
          flash(
            req,
            '⚠️ بتستخدم كلمة مرور افتراضية معروفة للجميع. غيّرها فورًا من "تغيير كلمة المرور".',
            'warning'
          );
        }
        return res.flashRedirect(redirectForRole(info.role), `مرحباً ${info.name}!`, 'success');
      } else {
        const blocked = recordFailedAttempt(ip, username);
        const remaining = Math.max(0, 3 - (failedAttempts.get(ip) || 0));
        if (blocked) {
          error = 'تم حجب هذا الجهاز مؤقتاً. انتظر 5 دقائق.';
        } else {
          error = `اسم المستخدم أو كلمة السر غلط. متبقي ${remaining} محاولة.`;
        }
      }
    }

    return res.view('login.html', { error });
  }
});

/* ============================================================ *
 * /signup
 * ============================================================ */
def(router, {
  name: 'signup',
  method: ['get', 'post'],
  path: '/signup',
  auth: false,
  handler: async (req, res) => {
    if (req.session && req.session.user) {
      return res.redirect(redirectForRole(req.session.user.role));
    }

    let error = null;

    if (req.method === 'POST') {
      const username = String(f(req, 'username')).trim();
      const password = f(req, 'password');
      const name = String(f(req, 'name')).trim();

      const users = getAllUsers();

      if (!username || !password || !name) {
        error = 'من فضلك املأ كل الحقول';
      } else if (users[username]) {
        error = 'اسم المستخدم ده موجود بالفعل، اختار اسم تاني';
      } else if (String(password).length < 6) {
        error = 'كلمة المرور لازم تكون 6 حروف/أرقام على الأقل';
      } else {
        const result = registerUser(username, password, name);
        if (!result.ok) {
          error = 'اسم المستخدم ده موجود بالفعل، اختار اسم تاني';
        } else {
          req.session.user = {
            username,
            role: 'user',
            name,
            governorate: ''
          };
          return res.flashRedirect('/account', `تم إنشاء حسابك بنجاح، أهلاً ${name}!`, 'success');
        }
      }
    }

    return res.view('signup.html', { error });
  }
});

/* ============================================================ *
 * /logout
 * ============================================================ */
def(router, {
  name: 'logout',
  path: '/logout',
  auth: true,
  handler: async (req, res) => {
    req.session = null;
    return res.redirect('/');
  }
});

/* ============================================================ *
 * /home  (public / citizen landing after login)
 * ============================================================ */
def(router, {
  name: 'public_home',
  path: '/home',
  auth: true,
  handler: async (req, res) => {
    let nationalIndicators = {};
    try {
      const capmas = JSON.parse(fs.readFileSync(CAPMAS_FILE, 'utf8'));
      nationalIndicators = capmas.national_indicators || {};
    } catch {
      nationalIndicators = {};
    }

    const totalFamilies = getFamilies().length;
    const healthNews = await fetch_health_news();

    return res.view('public_home.html', {
      ni: nationalIndicators,
      total_families: totalFamilies,
      health_news: healthNews
    });
  }
});

/* ============================================================ *
 * /employee
 * ============================================================ */
def(router, {
  name: 'employee_home',
  path: '/employee',
  auth: true,
  handler: async (req, res) => res.view('employee_home.html', {})
});

/* ============================================================ *
 * /account
 * ============================================================ */
def(router, {
  name: 'account_home',
  path: '/account',
  auth: true,
  handler: async (req, res) => {
    const username = req.user.username;
    const myRequests = getFamilies().filter(row => row['أضيف بواسطة'] === username);

    const labsIndex = loadJson(LABS_INDEX, {});
    const labsMissing = myRequests.some(row => !labsIndex[row['الرقم القومي'] || '']);

    return res.view('account_home.html', {
      requests_count: myRequests.length,
      labs_missing: labsMissing,
      has_requests: myRequests.length > 0
    });
  }
});

/* ============================================================ *
 * /my-support
 * ============================================================ */
def(router, {
  name: 'my_support',
  path: '/my-support',
  auth: true,
  handler: async (req, res) => {
    const username = req.user.username;
    const myRequests = getFamilies().filter(row => row['أضيف بواسطة'] === username);
    return res.view('my_support.html', { requests: myRequests });
  }
});

/* ============================================================ *
 * /security  (admin only)
 * ============================================================ */
def(router, {
  name: 'security_page',
  path: '/security',
  auth: true,
  handler: async (req, res) => {
    if (req.user.role !== 'admin') {
      return res.flashRedirect('/dashboard', 'مش مسموح لك', 'danger');
    }
    return res.view('security.html', {
      security_log: getSecurityLog(),
      blocked_ips: {},
      failed_attempts: {}
    });
  }
});

/* ============================================================ *
 * /change-password
 * ============================================================ */
def(router, {
  name: 'change_password',
  method: ['get', 'post'],
  path: '/change-password',
  auth: true,
  handler: async (req, res) => {
    let error = null;
    let success = null;

    if (req.method === 'POST') {
      const oldPass = f(req, 'old_password');
      const newPass = f(req, 'new_password');
      const confirm = f(req, 'confirm_password');

      const users = getAllUsers();
      const stored = users[req.user.username] ? users[req.user.username].password : '';

      if (!verifyPassword(oldPass, stored)) {
        error = 'كلمة السر القديمة غلط';
      } else if (newPass !== confirm) {
        error = 'كلمة السر الجديدة مش متطابقة';
      } else {
        const strong = isStrongPassword(newPass);
        if (!strong.ok) {
          error = strong.msg;
        } else {
          changeUserPassword(req.user.username, newPass);
          success = 'تم تغيير كلمة السر بنجاح!';
        }
      }
    }

    return res.view('change_password.html', { error, success });
  }
});

module.exports = router;
module.exports.fetch_health_news = fetch_health_news;
