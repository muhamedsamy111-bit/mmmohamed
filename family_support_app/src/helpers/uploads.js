'use strict';

/**
 * File uploads: family documents (ID card / birth certificate) and lab images.
 *
 * Ports `save_family_document` and `_save_lab_image` from app.py.
 * Lab images get their EXIF metadata stripped and are downscaled to 2200px
 * (Pillow's ImageOps.exif_transpose + thumbnail -> sharp's rotate + resize).
 */

const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const storage = require('../storage');
const { loadJson, saveJson, DOCUMENTS_INDEX_FILE, LABS_INDEX_FILE } = require('./paths');

const DOC_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'pdf']);
const MAX_DOC_SIZE_MB = 5;
const LAB_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);
const LAB_MAX_MB = 8;
const LAB_MAX_PER_FAMILY = 20;
const LAB_CATEGORIES = ['فيتامينات', 'معادن', 'تحاليل أخرى'];
const SHOP_IMAGE_MAX_MB = 8;

function extOf(filename) {
  const name = String(filename || '');
  if (!name.includes('.')) return '';
  return name.split('.').pop().toLowerCase();
}

function safeName(value) {
  // Flask's secure_filename keeps [A-Za-z0-9_.-]; national IDs are digits so
  // this only needs to cover the silly inputs.
  const cleaned = String(value || '').replace(/[^A-Za-z0-9_.-]/g, '');
  return cleaned || 'unknown';
}

function allowedDocFile(filename) {
  return DOC_EXTENSIONS.has(extOf(filename));
}

async function saveShopProductImage(file) {
  if (!file || !Buffer.isBuffer(file.buffer)) return { ok: false, msg: 'اختاري صورة للعبة.' };
  if (!/^image\/(jpeg|png|webp)$/.test(file.mimetype || '')) return { ok: false, msg: 'صورة اللعبة يجب أن تكون JPG أو PNG أو WEBP.' };
  if (file.buffer.length > SHOP_IMAGE_MAX_MB * 1024 * 1024) return { ok: false, msg: `حجم الصورة يجب ألا يتجاوز ${SHOP_IMAGE_MAX_MB} ميجابايت.` };
  try {
    const image = sharp(file.buffer, { failOn: 'none' });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height) return { ok: false, msg: 'الملف المرفوع ليس صورة صالحة.' };
    const storedName = `${crypto.randomBytes(18).toString('hex')}.jpg`;
    const rel = path.posix.join('uploads', 'shop', storedName);
    const processed = await image.rotate().resize(1400, 1400, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 86 }).toBuffer();
    await storage.writeFile(rel, processed);
    return { ok: true, imageUrl: `/shop/images/${storedName}` };
  } catch (err) {
    return { ok: false, msg: `تعذّر معالجة صورة اللعبة: ${err.message}` };
  }
}

function validateFamilyDocument(file) {
  if (!file || !file.originalname) return { ok: false, info: 'المستند مطلوب' };
  if (!allowedDocFile(file.originalname)) {
    return { ok: false, info: 'امتداد الملف غير مسموح (المسموح: jpg, jpeg, png, pdf فقط)' };
  }
  const sizeMb = (file.size || (file.buffer && file.buffer.length) || 0) / (1024 * 1024);
  if (sizeMb > MAX_DOC_SIZE_MB) {
    return { ok: false, info: `حجم الملف أكبر من ${MAX_DOC_SIZE_MB} ميجا` };
  }
  return { ok: true, info: '' };
}

/** Returns { ok, info } exactly like the Python helper. */
function saveFamilyDocument(nationalId, file, docTypeLabel) {
  if (!file || !file.originalname) return { ok: true, info: '' };
  const validation = validateFamilyDocument(file);
  if (!validation.ok) return validation;

  const safeNid = safeName(nationalId);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const storedName = `${safeName(docTypeLabel)}_${stamp}.${extOf(file.originalname)}`;
  const rel = path.posix.join('uploads', 'documents', safeNid, storedName);

  try {
    storage.writeFile(rel, file.buffer);
  } catch (err) {
    return { ok: false, info: `تعذّر حفظ الملف: ${err.message}` };
  }

  const index = loadJson(DOCUMENTS_INDEX_FILE, {});
  if (!Array.isArray(index[safeNid])) index[safeNid] = [];
  index[safeNid].push({
    type: docTypeLabel,
    filename: storedName,
    uploaded_at: new Date().toISOString().slice(0, 16).replace('T', ' ')
  });
  saveJson(DOCUMENTS_INDEX_FILE, index);
  return { ok: true, info: 'تم رفع الملف بنجاح', rel, storedName };
}

/** Port of `_save_lab_image`. Returns { ok, msg }. */
async function saveLabImage(nid, file, category, note, username) {
  const fname = (file && file.originalname) || '';
  if (!LAB_EXTENSIONS.has(extOf(fname))) {
    return { ok: false, msg: `${fname}: امتداد غير مسموح (المسموح: jpg, png, webp)` };
  }
  const sizeMb = (file.size || file.buffer.length) / (1024 * 1024);
  if (sizeMb > LAB_MAX_MB) {
    return { ok: false, msg: `${fname}: الحجم أكبر من ${LAB_MAX_MB} ميجا` };
  }

  let processed;
  try {
    const image = sharp(file.buffer, { failOn: 'none' });
    await image.metadata(); // throws for non-images
    processed = await image
      .rotate() // honours EXIF orientation, then drops metadata
      .resize(2200, 2200, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch {
    return { ok: false, msg: `${fname}: مش صورة صالحة` };
  }

  const safeNid = safeName(nid);
  const stored = `${crypto.randomBytes(16).toString('hex')}.jpg`;
  const rel = path.posix.join('uploads', 'labs', safeNid, stored);
  try {
    storage.writeFile(rel, processed);
  } catch (err) {
    return { ok: false, msg: `${fname}: تعذّر الحفظ (${err.message})` };
  }

  const idx = loadJson(LABS_INDEX_FILE, {});
  if (!Array.isArray(idx[nid])) idx[nid] = [];
  idx[nid].push({
    id: crypto.randomBytes(6).toString('hex'),
    filename: stored,
    category,
    note: String(note || '').slice(0, 200),
    uploaded_at: new Date().toISOString().slice(0, 16).replace('T', ' '),
    uploaded_by: username
  });
  saveJson(LABS_INDEX_FILE, idx);
  return { ok: true, msg: '' };
}

module.exports = {
  DOC_EXTENSIONS,
  MAX_DOC_SIZE_MB,
  LAB_EXTENSIONS,
  LAB_MAX_MB,
  LAB_MAX_PER_FAMILY,
  LAB_CATEGORIES,
  SHOP_IMAGE_MAX_MB,
  extOf,
  safeName,
  allowedDocFile,
  saveShopProductImage,
  validateFamilyDocument,
  saveFamilyDocument,
  saveLabImage
};
