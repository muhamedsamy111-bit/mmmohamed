'use strict';

/**
 * Birth-certificate OCR check (workflow version).
 *
 * For every uploaded birth certificate the backend tries to read the printed
 * names (child / father / mother) and compare them with the form inputs:
 *   - child name  <-> `child_names[i]` from the form
 *   - head name   <-> father OR mother on the certificate
 *
 * Matching is Arabic-aware: tashkeel-insensitive, alef/hamza unified,
 * and token-based (input "كريم" matches certificate "كريم محمد أحمد").
 *
 * OCR itself is optional: if `tesseract.js` is not installed (or the image
 * cannot be read) the check reports `checked: false` and registration
 * continues with a "manual review" note instead of blocking.
 */

let Tesseract = null;
function loadEngine() {
  if (Tesseract !== undefined && Tesseract !== null) return Tesseract;
  try {
    Tesseract = require('tesseract.js');
  } catch {
    Tesseract = false; // not installed -> manual-review path
  }
  return Tesseract;
}

/** Strip tashkeel + unify Arabic letter variants for comparison. */
function normalizeArabicName(value) {
  let s = String(value || '');
  // remove tashkeel / diacritics / tatweel / punctuation
  s = s.replace(/[ً-ٰٟـ]/g, '');
  s = s.replace(/[أإآٱ]/g, 'ا');
  s = s.replace(/ى/g, 'ي');
  s = s.replace(/ؤ/g, 'و');
  s = s.replace(/ئ/g, 'ي');
  // keep letters + spaces only
  s = s.replace(/[^ء-غف-يa-zA-Z ]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function tokens(s) {
  return normalizeArabicName(s).split(' ').filter(Boolean);
}

/**
 * True when every token of `input` appears in `printed`
 * (input may be shorter than the printed full name).
 */
function namesMatch(input, printed) {
  const a = tokens(input);
  const b = new Set(tokens(printed));
  if (!a.length || !b.size) return false;
  return a.every(t => b.has(t));
}

/** Pull child/father/mother names out of raw OCR text. */
function extractBirthNames(ocrText) {
  const text = String(ocrText || '');
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const out = { child: '', father: '', mother: '' };

  const grab = (line) => {
    const m = line.match(/[:：\-–—]\s*(.+)$/);
    return m ? m[1].trim() : '';
  };

  for (const line of lines) {
    if (!out.child && /(اسم المولود|اسم الطفل|اسم المواليد|المواليد|اسم الطفلة|الاسم الكامل)/.test(line)) {
      out.child = grab(line) || out.child;
    } else if (!out.father && /(اسم الأب|الأب|والد الطفل|اسم الوالد)/.test(line) && !/الأم/.test(line)) {
      out.father = grab(line) || out.father;
    } else if (!out.mother && /(اسم الأم|الأم|والدة الطفل|اسم الوالدة)/.test(line)) {
      out.mother = grab(line) || out.mother;
    }
  }
  return out;
}

async function runOcr(buffer, timeoutMs = 45000) {
  const engine = loadEngine();
  if (!engine) return { available: false, text: '' };
  try {
    const job = engine.recognize(buffer, 'ara+eng');
    const result = await Promise.race([
      job,
      new Promise((_, reject) => setTimeout(() => reject(new Error('ocr_timeout')), timeoutMs))
    ]);
    const text = (result && result.data && result.data.text) || '';
    return { available: true, text };
  } catch (err) {
    return { available: false, text: '', error: err.message };
  }
}

/**
 * Full check for one certificate file (multer object).
 * Returns { checked, childMatch, parentMatch, printed, detail }.
 */
async function verifyBirthCertificate(file, { childName, headName }) {
  if (!file || !file.buffer || !file.buffer.length) {
    return { checked: false, childMatch: false, parentMatch: false, printed: null, detail: 'لا يوجد ملف للفحص.' };
  }
  const ocr = await runOcr(file.buffer);
  if (!ocr.available || !ocr.text.trim()) {
    return {
      checked: false, childMatch: false, parentMatch: false, printed: null,
      detail: 'تعذّر القراءة الآلية (OCR غير متاح أو الصورة غير واضحة) — المراجعة يدويًا.'
    };
  }
  const printed = extractBirthNames(ocr.text);
  const childMatch = printed.child ? namesMatch(childName, printed.child) : false;
  const parentMatch = (printed.father && namesMatch(headName, printed.father))
    || (printed.mother && namesMatch(headName, printed.mother));
  return {
    checked: true,
    childMatch: Boolean(childMatch),
    parentMatch: Boolean(parentMatch),
    printed,
    text: ocr.text,
    detail: !printed.child && !printed.father && !printed.mother
      ? 'لم يتم العثور على أسماء واضحة في الشهادة — المراجعة يدويًا.'
      : ''
  };
}

module.exports = {
  normalizeArabicName,
  namesMatch,
  extractBirthNames,
  runOcr,
  verifyBirthCertificate,
  ocrAvailable: () => Boolean(loadEngine())
};
