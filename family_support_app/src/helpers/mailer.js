'use strict';

/**
 * Email + SMS notification helpers (port of app.py lines ~702-836:
 * send_support_email / _send_via_sms_misr / _send_via_twilio / send_support_sms).
 *
 * No nodemailer/twilio dependency is used: email is sent through a minimal
 * SMTP client built on node:net / node:tls (STARTTLS on 587, implicit TLS on
 * 465) and the Twilio path calls the REST API with global fetch, matching what
 * the Python twilio client did. Both helpers resolve to {ok, msg}, like
 * Python's (success: bool, info: str).
 */

const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');

const SMS_PROVIDER = process.env.SMS_PROVIDER || 'sms_misr';
const SITE_BASE_URL = process.env.SITE_BASE_URL || 'http://127.0.0.1:5000';

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '';

const SMS_MISR_USERNAME = process.env.SMS_MISR_USERNAME || '';
const SMS_MISR_PASSWORD = process.env.SMS_MISR_PASSWORD || '';
const SMS_MISR_SENDER = process.env.SMS_MISR_SENDER || '';
const SMS_MISR_ENVIRONMENT = process.env.SMS_MISR_ENVIRONMENT || '2';

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USERNAME = process.env.SMTP_USERNAME || '';
const SMTP_PASSWORD = process.env.SMTP_PASSWORD || '';
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || 'بوابة دعم الأسر';

function errText(err) {
  return err && err.message ? err.message : String(err);
}

/* ------------------------------------------------------------------ *
 * Minimal SMTP client
 * ------------------------------------------------------------------ */

function createSmtpSession({ host, port, timeoutMs = 10000 }) {
  const isImplicitTls = port === 465;
  let socket = null;
  let buffer = '';
  let waiters = [];
  let finished = false;
  let timer = null;

  function destroySocket() {
    try {
      if (socket) socket.destroy();
    } catch {
      /* ignore */
    }
  }

  function fail(err) {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    const pending = waiters;
    waiters = [];
    pending.forEach(w => w.reject(err));
    destroySocket();
  }

  function onData(chunk) {
    buffer += chunk;
    pump();
  }

  function onError(err) {
    fail(err);
  }

  function onClose() {
    fail(new Error('SMTP connection closed'));
  }

  function pump() {
    while (waiters.length) {
      const idx = buffer.indexOf('\r\n');
      if (idx === -1) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      waiters.shift().resolve(line);
    }
  }

  function readLine() {
    return new Promise((resolve, reject) => {
      if (finished) return reject(new Error('SMTP connection closed'));
      waiters.push({ resolve, reject });
      pump();
    });
  }

  async function readReply() {
    const lines = [];
    for (;;) {
      const line = await readLine();
      if (!/^\d{3}/.test(line)) throw new Error(`bad SMTP response: ${line}`);
      lines.push(line);
      if (line[3] === ' ') break;
    }
    const code = parseInt(lines[lines.length - 1].slice(0, 3), 10);
    return { code, lines };
  }

  function write(line) {
    socket.write(line + '\r\n');
  }

  async function command(line) {
    write(line);
    return readReply();
  }

  function attach(sock) {
    socket = sock;
    sock.setEncoding('utf8');
    sock.on('data', onData);
    sock.on('error', onError);
    sock.on('close', onClose);
  }

  async function connect() {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => fail(new Error('SMTP timeout')), timeoutMs);

      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const bail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      let sock;
      if (isImplicitTls) {
        sock = tls.connect({ host, port, servername: host });
        sock.once('secureConnect', done);
      } else {
        sock = net.connect({ host, port });
        sock.once('connect', done);
      }
      sock.once('error', bail);
      attach(sock);
    });

    const greeting = await readReply();
    if (greeting.code !== 220) {
      throw new Error(`SMTP greeting refused: ${greeting.lines.join(' ')}`);
    }
    return greeting;
  }

  async function ehlo() {
    const reply = await command(`EHLO ${os.hostname() || 'localhost'}`);
    if (reply.code !== 250) {
      throw new Error(`EHLO failed: ${reply.lines.join(' ')}`);
    }
    return reply;
  }

  function startTls() {
    return new Promise((resolve, reject) => {
      const raw = socket;
      raw.removeListener('data', onData);
      // keep the error handler attached so raw-level failures still surface
      buffer = '';

      let secured;
      try {
        secured = tls.connect({ socket: raw, servername: host });
      } catch (err) {
        reject(err);
        return;
      }

      buffer = '';
      socket = secured;
      secured.setEncoding('utf8');
      secured.on('data', onData);
      secured.on('error', onError);
      secured.on('close', onClose);

      let settled = false;
      secured.once('secureConnect', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      secured.once('error', (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
    });
  }

  async function auth() {
    const start = await command('AUTH LOGIN');
    if (start.code !== 334) {
      throw new Error(`AUTH LOGIN rejected: ${start.lines.join(' ')}`);
    }
    const user = await command(Buffer.from(SMTP_USERNAME, 'utf8').toString('base64'));
    if (user.code !== 334) {
      throw new Error(`AUTH username rejected: ${user.lines.join(' ')}`);
    }
    const pass = await command(Buffer.from(SMTP_PASSWORD, 'utf8').toString('base64'));
    if (pass.code !== 235) {
      throw new Error(`AUTH failed: ${pass.lines.join(' ')}`);
    }
    return pass;
  }

  async function sendEnvelope(fromAddr, toAddr, message) {
    const from = await command(`MAIL FROM:<${fromAddr}>`);
    if (from.code !== 250) {
      throw new Error(`MAIL FROM failed: ${from.lines.join(' ')}`);
    }
    const rcpt = await command(`RCPT TO:<${toAddr}>`);
    if (rcpt.code !== 250 && rcpt.code !== 251) {
      throw new Error(`RCPT TO failed: ${rcpt.lines.join(' ')}`);
    }
    const data = await command('DATA');
    if (data.code !== 354) {
      throw new Error(`DATA rejected: ${data.lines.join(' ')}`);
    }
    const stuffed = message.replace(/(^|\r\n)\./g, '$1..');
    write(`${stuffed}\r\n.`);
    const accepted = await readReply();
    if (accepted.code !== 250) {
      throw new Error(`message rejected: ${accepted.lines.join(' ')}`);
    }
    return accepted;
  }

  function quit() {
    try {
      write('QUIT');
    } catch {
      /* ignore */
    }
  }

  function finish() {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    try {
      if (socket) socket.end();
    } catch {
      /* ignore */
    }
  }

  return {
    isImplicitTls,
    command,
    connect,
    ehlo,
    startTls,
    auth,
    sendEnvelope,
    quit,
    finish
  };
}

function encodeHeaderWord(value) {
  const str = value === undefined || value === null ? '' : String(value);
  // ASCII-only headers are sent as-is (RFC 2047 only needed otherwise).
  if (/^[\x20-\x7E]*$/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

function wrapBase64(encoded) {
  const lines = [];
  for (let i = 0; i < encoded.length; i += 76) {
    lines.push(encoded.slice(i, i + 76));
  }
  return lines.join('\r\n');
}

/** Same MIME shape as Python's MIMEText(body, "plain", "utf-8"). */
function buildMessage(to, subject, body) {
  const fromHeader = `${encodeHeaderWord(SMTP_FROM_NAME)} <${SMTP_USERNAME}>`;
  const headers = [
    `Subject: ${encodeHeaderWord(subject)}`,
    `From: ${fromHeader}`,
    `To: ${to}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    ''
  ];
  const encodedBody = wrapBase64(Buffer.from(body, 'utf8').toString('base64'));
  return headers.join('\r\n') + encodedBody;
}

async function smtpSendMail(to, subject, body) {
  const session = createSmtpSession({ host: SMTP_HOST, port: SMTP_PORT, timeoutMs: 10000 });
  try {
    await session.connect();
    await session.ehlo();
    if (!session.isImplicitTls) {
      const starttls = await session.command('STARTTLS');
      if (starttls.code !== 220) {
        throw new Error(`STARTTLS refused: ${starttls.lines.join(' ')}`);
      }
      await session.startTls();
      await session.ehlo();
    }
    await session.auth();
    await session.sendEnvelope(SMTP_USERNAME, to, buildMessage(to, subject, body));
    session.quit();
  } finally {
    session.finish();
  }
}

/* ------------------------------------------------------------------ *
 * Email
 * ------------------------------------------------------------------ */

async function sendSupportEmail(toEmail, familyName) {
  if (!(SMTP_USERNAME && SMTP_PASSWORD)) {
    return {
      ok: false,
      msg: 'إرسال الإيميل غير مُفعّل (محتاج SMTP_USERNAME و SMTP_PASSWORD في متغيرات البيئة). الرسالة اتجهزت ومتبعتتش.'
    };
  }

  if (!toEmail) {
    return { ok: false, msg: 'لا يوجد بريد إلكتروني مسجّل لهذه الأسرة.' };
  }

  const loginLink = `${SITE_BASE_URL}/login`;
  const subject = 'تهانينا! أسرتكم مؤهلة للحصول على الدعم';
  const body =
    `السلام عليكم أسرة ${familyName}،\n\n` +
    'يسعدنا إبلاغكم بأن بيانات أسرتكم تمت مراجعتها وثبتت أهليتكم للحصول على الدعم ' +
    'من وزارة الصحة والسكان.\n\n' +
    'لتقديم طلبكم ومتابعة استلام الدعم، سجّلوا الدخول لحسابكم من الرابط التالي:\n' +
    `${loginLink}\n\n` +
    'مع تحيات وزارة الصحة والسكان\nبوابة دعم الأسر المجتمعية';

  try {
    await smtpSendMail(toEmail, subject, body);
    return { ok: true, msg: 'تم إرسال الإيميل بنجاح' };
  } catch (err) {
    return { ok: false, msg: `فشل إرسال الإيميل: ${errText(err)}` };
  }
}

/* ------------------------------------------------------------------ *
 * SMS
 * ------------------------------------------------------------------ */

async function sendViaSmsMisr(phone, messageBody) {
  if (!(SMS_MISR_USERNAME && SMS_MISR_PASSWORD && SMS_MISR_SENDER)) {
    return {
      ok: false,
      msg: 'بوابة SMS Misr غير مُفعّلة (محتاج SMS_MISR_USERNAME / PASSWORD / SENDER في متغيرات البيئة). الرسالة اتجهزت ومتبعتتش.'
    };
  }

  try {
    let mobile = String(phone).trim().replace(/\+/g, '').replace(/ /g, '').replace(/-/g, '');
    if (mobile.startsWith('0')) mobile = `2${mobile}`; // 010xxxxxxxx -> 2010xxxxxxxx

    const data = new URLSearchParams();
    data.set('environment', SMS_MISR_ENVIRONMENT);
    data.set('username', SMS_MISR_USERNAME);
    data.set('password', SMS_MISR_PASSWORD);
    data.set('sender', SMS_MISR_SENDER);
    data.set('mobile', mobile);
    data.set('language', '1');
    data.set('message', messageBody);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let result;
    try {
      const response = await fetch('https://smsmisr.com/api/SMS/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: data.toString(),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      result = await response.text();
    } finally {
      clearTimeout(timer);
    }

    return { ok: true, msg: `تم الإرسال عبر SMS Misr (رد البوابة: ${result.slice(0, 200)})` };
  } catch (err) {
    return { ok: false, msg: `فشل الإرسال عبر SMS Misr: ${errText(err)}` };
  }
}

async function sendViaTwilio(phone, messageBody) {
  if (!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER)) {
    return {
      ok: false,
      msg: 'بوابة Twilio غير مُفعّلة (محتاج بيانات Twilio في متغيرات البيئة). الرسالة اتجهزت ومتبعتتش.'
    };
  }

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Messages.json`;
    const params = new URLSearchParams();
    params.set('Body', messageBody);
    params.set('From', TWILIO_FROM_NUMBER);
    params.set('To', phone);
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString(),
        signal: controller.signal
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
      }
    } finally {
      clearTimeout(timer);
    }

    return { ok: true, msg: 'تم إرسال الرسالة بنجاح عبر Twilio' };
  } catch (err) {
    return { ok: false, msg: `فشل الإرسال عبر Twilio: ${errText(err)}` };
  }
}

async function sendSupportSms(phone, familyName) {
  const signupLink = `${SITE_BASE_URL}/signup`;
  const messageBody =
    `تهانينا لأسرة ${familyName} بالمولودين الجدد 🎉\n` +
    'نفيدكم بأن أسرتكم مؤهلة للحصول على دعم خاص بالتوائم من وزارة الصحة والسكان.\n' +
    `لتسجيل بيانات أسرتكم ومتابعة الطلب من هنا:\n${signupLink}\n` +
    'وزارة الصحة والسكان';

  if (SMS_PROVIDER === 'sms_misr') return sendViaSmsMisr(phone, messageBody);
  if (SMS_PROVIDER === 'twilio') return sendViaTwilio(phone, messageBody);
  return { ok: false, msg: `بوابة SMS غير معروفة: ${SMS_PROVIDER}` };
}

module.exports = {
  sendSupportEmail,
  sendSupportSms,
  // exported for testing / reuse
  SITE_BASE_URL,
  SMS_PROVIDER
};
