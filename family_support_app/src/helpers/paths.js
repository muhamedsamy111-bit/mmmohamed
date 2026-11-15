'use strict';

/**
 * Central path/constant table. Re-exports the data layer so route modules have
 * a single place to import from (mirrors the module level constants in app.py).
 */

const path = require('path');
const data = require('../services/dataService');

const DOCUMENTS_INDEX_FILE = path.join(data.BASE_DIR, 'family_documents.json');
const CHILDREN_FILE = data.CHILDREN_FILE;
const BACKUPS_DIR = path.join(data.BASE_DIR, 'backups');
const CAPMAS_FILE = path.join(data.DATA_DIR, 'capmas_governorates.json');
const TEMPLATES_DIR = path.join(data.BASE_DIR, 'templates');
const STATIC_DIR = path.join(data.BASE_DIR, 'static');
const SECRET_KEY_FILE = path.join(data.DATA_DIR, 'secret.key');
const COMMUNITY_ASSESSORS_FILE = path.join(data.BASE_DIR, 'community_assessors.json');
const LABS_DIR = path.join(data.BASE_DIR, 'uploads', 'labs');
const DOCUMENTS_DIR = path.join(data.BASE_DIR, 'uploads', 'documents');

const GENERATED_BY = 'مولّد بيانات تجريبية';
const DATASET_IMPORTED_BY = 'استيراد Dataset';
const STATUSES = ['قيد المراجعة', 'مقبول', 'مرفوض'];

module.exports = {
  ...data,
  DOCUMENTS_INDEX_FILE,
  CHILDREN_FILE,
  BACKUPS_DIR,
  CAPMAS_FILE,
  TEMPLATES_DIR,
  STATIC_DIR,
  SECRET_KEY_FILE,
  COMMUNITY_ASSESSORS_FILE,
  LABS_DIR,
  DOCUMENTS_DIR,
  GENERATED_BY,
  DATASET_IMPORTED_BY,
  STATUSES
};
