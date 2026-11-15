'use strict';

/**
 * Multer configuration. Files are kept in memory so the storage driver decides
 * where the bytes end up (local disk by default, Vercel Blob when configured).
 */

const multer = require('multer');

const memory = multer.memoryStorage();

const docUpload = multer({
  storage: memory,
  limits: { fileSize: 6 * 1024 * 1024, files: 22 }
});

const labUpload = multer({
  storage: memory,
  limits: { fileSize: 9 * 1024 * 1024, files: 5 }
});

const importUpload = multer({
  storage: memory,
  limits: { fileSize: 20 * 1024 * 1024, files: 1 }
});

const shopImageUpload = multer({
  storage: memory,
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) return callback(null, true);
    return callback(new Error('صورة اللعبة يجب أن تكون JPG أو PNG أو WEBP.'));
  }
});

module.exports = { docUpload, labUpload, importUpload, shopImageUpload };
