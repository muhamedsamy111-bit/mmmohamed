'use strict';

/**
 * Public pipeline demo: shows the sign-in -> registration -> OCR verify flow
 * end to end, with a live box that runs the real birth-certificate OCR check.
 *
 *   GET/POST /pipeline  ->  pipeline_demo (no login required)
 */

const express = require('express');
const { def } = require('./registry');
const { f, file } = require('../helpers/httpx');
const { importUpload } = require('../middlewares/upload');

const router = express.Router();

def(router, {
  name: 'pipeline_demo',
  method: ['get', 'post'],
  path: '/pipeline',
  auth: false,
  middleware: [importUpload.single('certificate')],
  handler: async (req, res) => {
    let demo = null;

    if (req.method === 'POST') {
      const childName = String(f(req, 'child_name')).trim();
      const headName = String(f(req, 'head_name')).trim();
      const cert = file(req, 'certificate');

      if (!childName || !headName) {
        demo = { error: 'اكتب اسم الطفل واسم رب الأسرة أولًا.' };
      } else if (!cert || !cert.buffer || !cert.buffer.length) {
        demo = { error: 'اختار صورة شهادة الميلاد (jpg/png/webp).' };
      } else {
        try {
          const { verifyBirthCertificate } = require('../helpers/ocr');
          const check = await verifyBirthCertificate(cert, { childName, headName });
          demo = { childName, headName, filename: cert.originalname, ...check };
        } catch (err) {
          demo = { error: `تعذّر الفحص: ${err.message}` };
        }
      }
    }

    return res.view('pipeline.html', { demo });
  }
});

module.exports = router;
