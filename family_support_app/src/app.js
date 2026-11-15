'use strict';

/**
 * Express application factory.
 *
 * Same request pipeline shape as the Flask app:
 *   session -> body parsing -> static -> view helpers -> role guard -> routes
 */

const express = require('express');
const cookieSession = require('cookie-session');
const path = require('path');

const { engine } = require('./jinja/engine');
const { buildContext, flash } = require('./jinja/context');
const { SESSION_SECRET } = require('./helpers/security');
const { enforceRoleAccess } = require('./middlewares/authMiddleware');
const { STATIC_DIR } = require('./helpers/paths');

const SESSION_MINUTES = 30;

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // Flask: PERMANENT_SESSION_LIFETIME=30min, HTTPONLY, SAMESITE=Lax
  app.use(cookieSession({
    name: 'session',
    keys: [SESSION_SECRET],
    maxAge: SESSION_MINUTES * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE === '1'
  }));

  app.use(express.urlencoded({ extended: true, limit: '20mb' }));
  app.use(express.json({ limit: '20mb' }));

  // The uploaded brand image is kept next to the repository folder, not under /static.
  app.get('/brand-logo.jpeg', (req, res, next) => {
    res.sendFile(path.resolve(__dirname, '../../Gemini_Generated_Image_oc83fvoc83fvoc83.jpeg'), (err) => {
      if (err && !res.headersSent) next(err);
    });
  });

  app.use('/static', express.static(STATIC_DIR, { maxAge: '1h' }));

  // Flask's render_template + flash equivalents
  app.use((req, res, next) => {
    res.view = (name, data, status) => {
      try {
        const html = engine.render(name, buildContext(req, data));
        res.status(status || 200).type('html').send(html);
      } catch (err) {
        next(err);
      }
    };
    res.flashRedirect = (url, message, category) => {
      if (message) flash(req, message, category);
      return res.redirect(url);
    };
    next();
  });

  app.use(enforceRoleAccess);

  app.use('/', require('./routes'));

  app.use((req, res) => {
    res.status(404).type('html').send(
      '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
      '<title>الصفحة غير موجودة</title></head><body style="font-family:sans-serif;text-align:center;padding:60px">' +
      '<h1>404</h1><p>الصفحة غير موجودة</p><a href="/">الرجوع للرئيسية</a></body></html>'
    );
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[error]', err && err.stack ? err.stack : err);
    if (req.path.startsWith('/api/') || (req.headers.accept || '').includes('json')) {
      return res.status(500).json({ error: 'internal_error', message: err.message });
    }
    res.status(500).type('html').send(
      '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
      '<title>خطأ في الخدمة</title></head><body style="font-family:sans-serif;text-align:center;padding:60px">' +
      '<h1>500</h1><p>حصل خطأ غير متوقع.</p><a href="/">الرجوع للرئيسية</a></body></html>'
    );
  });

  return app;
}

module.exports = { createApp };
