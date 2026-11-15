'use strict';

/**
 * Security helpers ported from app.py: stable session key, per-IP failed login
 * tracking with temporary blocking, in-memory security log, reversible
 * "encryption" of sensitive fields and password strength rules.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SECRET_KEY_FILE } = require('./paths');

/** Stable session key: SECRET_KEY env var, else a key file created once. */
function loadSecretKey() {
  if (process.env.SECRET_KEY) return process.env.SECRET_KEY;
  try {
    fs.mkdirSync(path.dirname(SECRET_KEY_FILE), { recursive: true });
    if (fs.existsSync(SECRET_KEY_FILE)) {
      const existing = fs.readFileSync(SECRET_KEY_FILE, 'utf8').trim();
      if (existing) return existing;
    }
    const fresh = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_KEY_FILE, fresh, 'utf8');
    return fresh;
  } catch {
    return crypto.randomBytes(32).toString('hex');
  }
}

const SESSION_SECRET = loadSecretKey();

const failedAttempts = new Map(); // ip -> count
const blockedIps = new Map();     // ip -> epoch ms
const securityLog = [];
const BLOCK_SECONDS = 300;
const MAX_ATTEMPTS = 3;

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

function isBlocked(ip) {
  if (blockedIps.has(ip)) {
    if ((Date.now() - blockedIps.get(ip)) / 1000 < BLOCK_SECONDS) return true;
    blockedIps.delete(ip);
    failedAttempts.delete(ip);
  }
  return false;
}

function logSecurityEvent(event, username, ip) {
  securityLog.push({
    time: new Date().toISOString().slice(0, 19).replace('T', ' '),
    event,
    username,
    ip
  });
  if (securityLog.length > 500) securityLog.shift();
}

function recordFailedAttempt(ip, username) {
  failedAttempts.set(ip, (failedAttempts.get(ip) || 0) + 1);
  logSecurityEvent('محاولة دخول فاشلة', username, ip);
  if (failedAttempts.get(ip) >= MAX_ATTEMPTS) {
    blockedIps.set(ip, Date.now());
    logSecurityEvent('حجب IP بعد 3 محاولات فاشلة', username, ip);
    return true;
  }
  return false;
}

function recordSuccess(ip, username) {
  failedAttempts.delete(ip);
  logSecurityEvent('دخول ناجح', username, ip);
}

function getSecurityLog() {
  return securityLog.slice().reverse();
}

/** Reversible obfuscation (same scheme as the Python app). */
function encryptSensitive(text) {
  if (!text) return text;
  return 'ENC:' + Buffer.from(String(text), 'utf8').toString('base64');
}

function decryptSensitive(text) {
  if (!text || !String(text).startsWith('ENC:')) return text;
  try {
    return Buffer.from(String(text).slice(4), 'base64').toString('utf8');
  } catch {
    return text;
  }
}

function isStrongPassword(password) {
  const value = String(password || '');
  if (value.length < 8) return { ok: false, msg: 'كلمة السر لازم تكون 8 أحرف على الأقل' };
  if (!/[A-Z]/.test(value)) return { ok: false, msg: 'لازم تحتوي على حرف كبير' };
  if (!/[0-9]/.test(value)) return { ok: false, msg: 'لازم تحتوي على رقم' };
  return { ok: true, msg: 'قوية' };
}

module.exports = {
  SESSION_SECRET,
  clientIp,
  isBlocked,
  recordFailedAttempt,
  recordSuccess,
  logSecurityEvent,
  getSecurityLog,
  encryptSensitive,
  decryptSensitive,
  isStrongPassword,
  failedAttempts,
  blockedIps
};
