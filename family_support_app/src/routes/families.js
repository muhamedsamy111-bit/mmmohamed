'use strict';

/**
 * Family + document routes (port of the matching app.py endpoints):
 *   index, families, delete, set_request_status, register_family,
 *   register_birth, births_list, download_document, document_recognition,
 *   certificate, api_analyze_document.
 *
 * NOTE: app.py has TWO functions mapped to "/dashboard":
 *   - `index`     (line ~1165, GET+POST, renders index.html)
 *   - `dashboard` (line ~2756, GET, renders dashboard.html)
 * Express can only bind one handler to a path, so this module keeps `index`
 * (the add/edit-family form) as required; `dashboard.html` is not reachable at
 * "/dashboard" in the port.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const { def } = require('./registry');
const { q, f, file, files, fall } = require('../helpers/httpx');
const {
  loadJson,
  saveJson,
  getFamilies,
  saveFamilies,
  BIRTHS_FILE,
  CHILDREN_FILE,
  DOCUMENTS_INDEX_FILE,
  DOCUMENTS_DIR,
  STATUSES
} = require('../helpers/paths');
const { priorityTuple, healthAlerts, ALERT_TYPES } = require('../helpers/scoring');
const {
  normalizeNid,
  validateNationalIdFormat,
  STRICT_NID_VALIDATION
} = require('../helpers/priorityShim');
const healthRules = require('../config/healthRules');
const { audit } = require('../helpers/audit');
const { saveFamilyDocument, validateFamilyDocument, safeName } = require('../helpers/uploads');
const { sendSupportEmail, sendSupportSms } = require('../helpers/mailer');
const { docUpload } = require('../middlewares/upload');
const { analyzeDocumentText } = require('../helpers/documents');

const router = express.Router();

/* ------------------------------------------------------------------ *
 * Local helpers (mirror the module-level helpers in app.py)
 * ------------------------------------------------------------------ */

/** datetime.now().strftime("%Y-%m-%d %H:%M") */
function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** app.py::_clean_date — strict "%Y-%m-%d", returns "" on failure. */
function cleanDate(value) {
  const s = String(value === null || value === undefined ? '' : value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return '';
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return '';
  }
  return s;
}

function ageFromNationalId(nid) {
  if (!/^\d{14}$/.test(nid) || (nid[0] !== '2' && nid[0] !== '3')) return null;
  const birthYear = (nid[0] === '2' ? 1900 : 2000) + Number(nid.slice(1, 3));
  const birthMonth = Number(nid.slice(3, 5));
  const birthDay = Number(nid.slice(5, 7));
  const birth = new Date(birthYear, birthMonth - 1, birthDay);
  if (birth.getFullYear() !== birthYear || birth.getMonth() !== birthMonth - 1 || birth.getDate() !== birthDay) return null;
  const today = new Date();
  return today.getFullYear() - birthYear - ((today.getMonth() < birthMonth - 1 || (today.getMonth() === birthMonth - 1 && today.getDate() < birthDay)) ? 1 : 0);
}

/** Port of app.py::check_national_id (returns null on success, else Arabic msg). */
function checkNationalId(nationalId, editingIndex = null) {
  const rows = getFamilies();

  if (
    editingIndex !== null && editingIndex !== undefined &&
    editingIndex >= 0 && editingIndex < rows.length
  ) {
    if (normalizeNid(rows[editingIndex]["الرقم القومي"]) === nationalId) {
      return null;
    }
  }

  if (STRICT_NID_VALIDATION) {
    const { ok, msg } = validateNationalIdFormat(nationalId);
    if (!ok) return msg;
  }

  for (let i = 0; i < rows.length; i++) {
    if (i !== editingIndex && normalizeNid(rows[i]["الرقم القومي"]) === nationalId) {
      return 'الرقم القومي ده مسجّل بالفعل في النظام. لو محتاج تعدّل بياناتك كلّم فريق الدعم.';
    }
  }
  return null;
}

/** app.py::read_births / write_births (births.json). */
function readBirths() {
  return loadJson(BIRTHS_FILE, []);
}

function writeBirths(data) {
  saveJson(BIRTHS_FILE, data);
}

/** app.py::read_documents_index. */
function readDocumentsIndex() {
  return loadJson(DOCUMENTS_INDEX_FILE, {});
}

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ============================================================ *
 * /dashboard  ->  index  (GET + POST)
 * ============================================================ */
def(router, {
  name: 'index',
  method: ['get', 'post'],
  path: '/dashboard',
  handler: async (req, res) => {
    let message = '';
    let editMode = false;
    let editIndex = null;
    let familyData = null;

    const editParam = q(req, 'edit');
    if (editParam) {
      const parsedEdit = parseInt(editParam, 10);
      const families = getFamilies();
      if (!Number.isNaN(parsedEdit) && parsedEdit >= 0 && parsedEdit < families.length) {
        editIndex = parsedEdit;
        familyData = families[parsedEdit];
        editMode = true;
      }
    }

    if (req.method === 'POST') {
      const name = f(req, 'name');
      const nationalId = normalizeNid(f(req, 'national_id'));
      const editRaw = f(req, 'edit_index');
      const hasEdit = editRaw !== '';
      const editingIndex = hasEdit ? parseInt(editRaw, 10) : null;
      const nidError = checkNationalId(nationalId, editingIndex);
      const governorate = f(req, 'governorate');
      const children = parseInt(f(req, 'children'), 10) || 0;
      const income = f(req, 'income');
      const hasDisabled = f(req, 'has_disabled');
      const hasOrphans = f(req, 'has_orphans');

      const eligible = children > 2 ? 'نعم' : 'لا';
      const [points, priorityLevel] = priorityTuple(children, income, hasDisabled, hasOrphans);
      const currentDate = nowStamp();

      if (nidError) {
        message = '❌ ' + nidError;
      } else if (hasEdit) {
        editIndex = editingIndex;

        const families = getFamilies().slice();
        const existing = families[editIndex] || {};
        const existingEmail = existing["البريد الإلكتروني"] || '';
        const existingEmailStatus = existing["حالة إشعار البريد"] || '';

        let emailStatus = existingEmailStatus;
        if (eligible === 'نعم' && existingEmailStatus !== 'تم الإرسال بنجاح') {
          if (existingEmail) {
            const sent = await sendSupportEmail(existingEmail, name);
            emailStatus = sent.ok ? 'تم الإرسال بنجاح' : `لم يتم الإرسال: ${sent.msg}`;
          } else {
            emailStatus = 'لا يوجد بريد إلكتروني';
          }
        }

        families[editIndex] = {
          ...existing,
          "اسم رب الأسرة": name,
          "الرقم القومي": nationalId,
          "البريد الإلكتروني": existingEmail,
          "المحافظة": governorate,
          "عدد الأطفال": children,
          "الدخل الشهري": income,
          "معيل معاق": hasDisabled,
          "أيتام": hasOrphans,
          "مؤهل للدعم": eligible,
          "درجة الأولوية": points,
          "مستوى الأولوية": priorityLevel,
          "تاريخ الإضافة": existing["تاريخ الإضافة"] ?? currentDate,
          "أضيف بواسطة": existing["أضيف بواسطة"] ?? req.user.username,
          "حالة إشعار البريد": emailStatus,
          "حالة الطلب": existing["حالة الطلب"] || 'قيد المراجعة'
        };

        saveFamilies(families);
        audit(req, 'family_edit', nationalId);
        message = '✅ تم تعديل بيانات الأسرة بنجاح';
      } else {
        const families = getFamilies().slice();
        families.push({
          "اسم رب الأسرة": name,
          "الرقم القومي": nationalId,
          "البريد الإلكتروني": "",
          "المحافظة": governorate,
          "عدد الأطفال": children,
          "الدخل الشهري": income,
          "معيل معاق": hasDisabled,
          "أيتام": hasOrphans,
          "مؤهل للدعم": eligible,
          "درجة الأولوية": points,
          "مستوى الأولوية": priorityLevel,
          "تاريخ الإضافة": currentDate,
          "أضيف بواسطة": req.user.username,
          "حالة إشعار البريد": "لا يوجد بريد إلكتروني",
          "حالة الطلب": "قيد المراجعة"
        });

        saveFamilies(families);
        audit(req, 'family_add', nationalId);
        message = `✅ الأسرة ${eligible === 'نعم' ? 'مؤهلة' : 'غير مؤهلة'} للدعم | ${priorityLevel}`;
      }
    }

    if (editMode) {
      const families = getFamilies();
      familyData = families[editIndex];
    }

    // بيانات رسم بياني: عدد الأسر المسجّلة شهريًا لآخر 6 شهور
    const allFamiliesForChart = getFamilies();

    const monthKeys = [];
    const monthLabels = [];
    for (let i = 5; i >= 0; i--) {
      let year = new Date().getFullYear();
      let month = (new Date().getMonth() + 1) - i;
      while (month <= 0) {
        month += 12;
        year -= 1;
      }
      monthKeys.push(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`);
      monthLabels.push(`${String(month).padStart(2, '0')}/${year}`);
    }

    const monthlyCounts = {};
    monthKeys.forEach((k) => { monthlyCounts[k] = 0; });
    for (const fam of allFamiliesForChart) {
      const dateStr = fam["تاريخ الإضافة"] || '';
      const key = dateStr.slice(0, 7); // "YYYY-MM"
      if (key in monthlyCounts) monthlyCounts[key] += 1;
    }

    const chartLabels = monthLabels;
    const chartValues = monthKeys.map((k) => monthlyCounts[k]);

    return res.view('index.html', {
      message,
      edit_mode: editMode,
      edit_index: editIndex,
      family: familyData,
      chart_labels: chartLabels,
      chart_values: chartValues
    });
  }
});

/* ============================================================ *
 * /families  ->  families
 * ============================================================ */
def(router, {
  name: 'families',
  path: '/families',
  handler: async (req, res) => {
    const searchQuery = String(q(req, 'search')).trim();
    const filterPriority = String(q(req, 'priority')).trim();
    const user = req.user;

    const allFamilies = [];
    for (const row of getFamilies()) {
      let match = true;

      if (searchQuery && !(
        String(row["اسم رب الأسرة"] || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        String(row["الرقم القومي"] || '').includes(searchQuery) ||
        String(row["المحافظة"] || '').toLowerCase().includes(searchQuery.toLowerCase())
      )) {
        match = false;
      }

      if (filterPriority && (row["مستوى الأولوية"] || '') !== filterPriority) {
        match = false;
      }

      // لو موظف مخصص لمحافظة معيّنة، يشوف بس أسر المحافظة دي
      const gov = user.governorate || '';
      if (
        (user.role === 'employee' || user.role === 'psychologist') &&
        gov && (row["المحافظة"] || '') !== gov
      ) {
        match = false;
      }

      if (match) allFamilies.push(row);
    }

    const eligibleCount = allFamilies.filter((fam) => (fam["مؤهل للدعم"] || '') === 'نعم').length;
    const notEligibleCount = allFamilies.length - eligibleCount;

    // إحصائيات الأولوية
    const priorityStats = {
      "أولوية قصوى 🔴": 0,
      "أولوية متوسطة 🟡": 0,
      "أولوية منخفضة 🟢": 0
    };
    const priorityLevels = Array.from(new Set(
      allFamilies
        .map((fam) => (fam["مستوى الأولوية"] || '').trim())
        .filter((level) => level)
    )).sort();

    for (const fam of allFamilies) {
      const level = (fam["مستوى الأولوية"] || '').trim();
      // نصنّف لأغراض العرض فقط؛ قيمة مستوى الأولوية الأصلية تظل محفوظة دون تعديل.
      if (level.includes('قصوى') || level.includes('حرج')) {
        priorityStats["أولوية قصوى 🔴"] += 1;
      } else if (level.includes('متوسط') || level.includes('عالي')) {
        priorityStats["أولوية متوسطة 🟡"] += 1;
      } else if (level) {
        priorityStats["أولوية منخفضة 🟢"] += 1;
      }
    }

    return res.view('families.html', {
      families: allFamilies,
      eligible_count: eligibleCount,
      not_eligible_count: notEligibleCount,
      priority_stats: priorityStats,
      search_query: searchQuery,
      filter_priority: filterPriority,
      priority_levels: priorityLevels,
      documents_index: readDocumentsIndex()
    });
  }
});

/* ============================================================ *
 * /delete/:index  ->  delete  (admin only)
 * ============================================================ */
def(router, {
  name: 'delete',
  path: '/delete/:index',
  handler: async (req, res) => {
    if (req.user.role !== 'admin') {
      return res.flashRedirect('/families', 'ليس لديك صلاحية الحذف — هذه الصلاحية للمدير فقط', 'danger');
    }

    const index = parseInt(req.params.index, 10);
    const families = getFamilies().slice();

    if (index >= 0 && index < families.length) {
      audit(req, 'family_delete', families[index]["الرقم القومي"] || '');
      families.splice(index, 1);
    }

    saveFamilies(families);
    return res.flashRedirect('/families', 'تم حذف الأسرة بنجاح', 'success');
  }
});

/* ============================================================ *
 * /families/:index/set-status  ->  set_request_status (POST)
 * ============================================================ */
def(router, {
  name: 'set_request_status',
  method: 'post',
  path: '/families/:index/set-status',
  handler: async (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'employee') {
      return res.flashRedirect('/families', 'ليس لديك صلاحية تغيير حالة الطلب', 'danger');
    }

    const newStatus = String(f(req, 'status')).trim();
    if (!STATUSES.includes(newStatus)) {
      return res.flashRedirect('/families', 'حالة غير صحيحة', 'danger');
    }

    const index = parseInt(req.params.index, 10);
    const families = getFamilies().slice();

    if (index >= 0 && index < families.length) {
      families[index]["حالة الطلب"] = newStatus;
      saveFamilies(families);
      audit(req, 'status_change', families[index]["الرقم القومي"] || '', newStatus);
      return res.flashRedirect('/families', `✅ تم تحديث حالة الطلب إلى: ${newStatus}`, 'success');
    }

    return res.flashRedirect('/families', 'الأسرة غير موجودة', 'danger');
  }
});

/* ============================================================ *
 * /register-family  ->  register_family  (GET + POST)
 * ============================================================ */
def(router, {
  name: 'register_family',
  method: ['get', 'post'],
  path: '/register-family',
  middleware: [
    docUpload.fields([
      { name: 'id_document', maxCount: 1 },
      { name: 'health_insurance_document', maxCount: 1 },
      { name: 'child_birth_certificates', maxCount: 20 }
    ])
  ],
  handler: async (req, res) => {
    let message = '';

    if (req.method === 'POST') {
      const name = f(req, 'name');
      const nationalId = normalizeNid(f(req, 'national_id'));
      const email = String(f(req, 'email')).trim();
      const submittedAge = String(f(req, 'age')).trim();
      const age = Number(submittedAge);
      const address = String(f(req, 'address')).trim();
      const hasInsurance = f(req, 'has_health_insurance') === 'نعم';
      const idDoc = file(req, 'id_document');
      const insuranceDoc = file(req, 'health_insurance_document');
      const childCertificates = files(req, 'child_birth_certificates');

      const nidError = checkNationalId(nationalId);
      if (nidError) {
        return res.view('register_family.html', { message: '⚠️ ' + nidError });
      }

      const derivedAge = ageFromNationalId(nationalId);
      if (!name.trim() || !address || !Number.isInteger(age) || age < 0 || age !== derivedAge) {
        return res.view('register_family.html', { message: '⚠️ الاسم والعنوان والعمر مطلوبة، ويجب أن يطابق العمر تاريخ الميلاد المسجل في الرقم القومي.' });
      }
      const idValidation = validateFamilyDocument(idDoc);
      if (!idValidation.ok) return res.view('register_family.html', { message: '⚠️ صورة بطاقة الرقم القومي مطلوبة: ' + idValidation.info });
      if (hasInsurance) {
        const insuranceValidation = validateFamilyDocument(insuranceDoc);
        if (!insuranceValidation.ok) return res.view('register_family.html', { message: '⚠️ صورة بطاقة التأمين الصحي مطلوبة: ' + insuranceValidation.info });
      }

      const governorate = f(req, 'governorate');
      const children = parseInt(f(req, 'children'), 10) || 0;
      const childNames = fall(req, 'child_names').map((value) => String(value || '').trim());
      const childCertNumbers = fall(req, 'child_cert_numbers').map((value) => String(value || '').trim());
      const childrenMultiples = f(req, 'children_multiples', 'لا يوجد توائم بين الأطفال');
      if (children < 0 || children > 20 || childCertificates.length !== children) {
        return res.view('register_family.html', { message: '⚠️ ارفع شهادة ميلاد مستقلة لكل طفل، ويجب أن يطابق عدد الشهادات عدد الأطفال.' });
      }
      if (childNames.length !== children || childNames.some((childName) => !childName) ||
          childCertNumbers.length !== children || childCertNumbers.some((n) => !n) ||
          new Set(childCertNumbers).size !== childCertNumbers.length ||
          !['لا يوجد توائم بين الأطفال', 'توأم', 'ثلاثة توائم أو أكثر'].includes(childrenMultiples) ||
          (childrenMultiples === 'توأم' && children < 2) ||
          (childrenMultiples === 'ثلاثة توائم أو أكثر' && children < 3)) {
        return res.view('register_family.html', { message: '⚠️ أدخلي اسم كل طفل ورقم شهادة ميلاده (أرقام مختلفة لكل طفل) وحددي تعدد المواليد الحالي بشكل صحيح.' });
      }
      const pregnant = f(req, 'pregnant');
      const pregnancyKind = pregnant === 'نعم' ? f(req, 'pregnancy_kind') : 'لا يوجد';
      const fetusCount = pregnant === 'نعم' ? Number(f(req, 'fetus_count')) : 0;
      const familyType = pregnant === 'نعم'
        ? (pregnancyKind === 'مفرد' ? 'حمل مفرد' : pregnancyKind === 'توأم' ? 'حمل بتوأم' : 'حمل بثلاثة توائم أو أكثر')
        : (childrenMultiples === 'توأم' ? 'لديها أطفال توائم'
          : childrenMultiples === 'ثلاثة توائم أو أكثر' ? 'لديها أطفال ثلاثة توائم أو أكثر'
            : children > 0 ? 'أسرة لديها أطفال' : 'أسرة أخرى');
      if (!['نعم', 'لا'].includes(pregnant) ||
          (pregnant === 'نعم' && (!Number.isInteger(fetusCount) || fetusCount < 1 || fetusCount > 10 ||
            !['مفرد', 'توأم', 'ثلاثة توائم أو أكثر'].includes(pregnancyKind) ||
            (pregnancyKind === 'مفرد' && fetusCount !== 1) ||
            (pregnancyKind === 'توأم' && fetusCount !== 2) ||
            (pregnancyKind === 'ثلاثة توائم أو أكثر' && fetusCount < 3)))) {
        return res.view('register_family.html', { message: '⚠️ حددي حالة الحمل الحالية وعدد الأجنة بشكل صحيح.' });
      }
      for (let i = 0; i < childCertificates.length; i++) {
        const certValidation = validateFamilyDocument(childCertificates[i]);
        if (!certValidation.ok) {
          return res.view('register_family.html', { message: `⚠️ شهادة ميلاد الطفل ${i + 1}: ${certValidation.info}` });
        }
      }
      const income = f(req, 'income');
      const hasDisabled = f(req, 'has_disabled');
      const hasOrphans = f(req, 'has_orphans');

      const eligible = children > 2 ? 'نعم' : 'لا';
      const [points, priorityLevel] = priorityTuple(children, income, hasDisabled, hasOrphans);
      const currentDate = nowStamp();

      // Store pregnancy status and multiples explicitly for staff triage.
      let healthRow = {};
      {

        let under5 = 0;
        try {
          let raw = String(f(req, 'under5', '0') || '0').trim();
          let parsed = parseInt(raw, 10);
          if (Number.isNaN(parsed)) throw new Error('bad');
          under5 = Math.max(0, Math.min(parsed, children));
        } catch {
          under5 = 0;
        }

        let treatmentCost = 0;
        try {
          let raw = String(f(req, 'treatment_cost', '0') || '0').trim();
          let parsed = parseFloat(raw);
          if (Number.isNaN(parsed)) throw new Error('bad');
          treatmentCost = Math.max(0, Math.trunc(parsed));
        } catch {
          treatmentCost = 0;
        }

        const pregnancyFollowup = pregnant === 'نعم'
          ? f(req, 'pregnancy_followup', 'لا')
          : 'لا ينطبق';

        healthRow = {
          "حامل": pregnant,
          "متابعة حمل": pregnancyFollowup,
          "أطفال تحت 5": String(under5),
          "تطعيمات مكتملة": under5 ? f(req, 'vaccines_complete', 'نعم') : 'لا ينطبق',
          "مرض مزمن": f(req, 'chronic', 'لا'),
          "سوء تغذية": children ? f(req, 'malnutrition', 'لا') : 'لا ينطبق',
          "تكلفة العلاج الشهرية": String(treatmentCost),
          "آخر متابعة حمل": pregnancyFollowup === 'نعم' ? cleanDate(f(req, 'last_pregnancy_visit')) : '',
          "آخر تطعيم": under5 ? cleanDate(f(req, 'last_vaccine')) : '',
          "تاريخ آخر ولادة": cleanDate(f(req, 'last_delivery')) || 'لا ينطبق'
        };

        const hs = healthRules.healthScore({ ...healthRow, "الدخل الشهري": income });
        healthRow["درجة الأولوية الصحية"] = hs.score;
        healthRow["مستوى الأولوية الصحية"] = hs.level;
      }

      let emailStatus = 'غير مؤهل، لا يستحق إشعار';
      if (eligible === 'نعم') {
        if (email) {
          const sent = await sendSupportEmail(email, name);
          emailStatus = sent.ok ? 'تم الإرسال بنجاح' : `لم يتم الإرسال: ${sent.msg}`;
        } else {
          emailStatus = 'لا يوجد بريد إلكتروني';
        }
      }

      const families = getFamilies().slice();
      families.push({
        "اسم رب الأسرة": name,
        "الرقم القومي": nationalId,
        "البريد الإلكتروني": email,
        "المحافظة": governorate,
        "عدد الأطفال": children,
        "العمر": age,
        "العنوان التفصيلي": address,
        "لديه تأمين صحي": hasInsurance ? 'نعم' : 'لا',
        "تصنيف الأسرة": familyType,
        "تعدد مواليد الأطفال الحاليين": childrenMultiples,
        "نوع الحمل الحالي": pregnancyKind,
        "عدد الأجنة": fetusCount,
        "عدد شهادات ميلاد الأطفال": childCertificates.length,
        "الدخل الشهري": income,
        "معيل معاق": hasDisabled,
        "أيتام": hasOrphans,
        "مؤهل للدعم": eligible,
        "درجة الأولوية": points,
        "مستوى الأولوية": priorityLevel,
        "تاريخ الإضافة": currentDate,
        "أضيف بواسطة": req.user.username,
        "حالة إشعار البريد": emailStatus,
        "حالة الطلب": "قيد المراجعة",
        ...healthRow
      });

      saveFamilies(families);
      audit(req, 'family_add_citizen', nationalId);

      message = '✅ تم إرسال بيانات الأسرة بنجاح، وسيتم مراجعتها من قِبل فريق الدعم.';

      const docErrors = [];

      const idResult = saveFamilyDocument(nationalId, idDoc, 'بطاقة الرقم القومي');
      if (!idResult.ok) {
        docErrors.push(`بطاقة الرقم القومي: ${idResult.info}`);
      }

      if (hasInsurance) {
        const insuranceResult = saveFamilyDocument(nationalId, insuranceDoc, 'بطاقة التأمين الصحي');
        if (!insuranceResult.ok) docErrors.push(`بطاقة التأمين الصحي: ${insuranceResult.info}`);
      }
      childCertificates.forEach((cert, index) => {
        const result = saveFamilyDocument(nationalId, cert, `شهادة ميلاد طفل ${index + 1}`);
        if (!result.ok) docErrors.push(`شهادة ميلاد الطفل ${index + 1}: ${result.info}`);
      });
      const childRecords = loadJson(CHILDREN_FILE, {});
      const uploadedDocuments = readDocumentsIndex()[nationalId] || [];
      childRecords[nationalId] = childNames.map((childName, index) => {
        const certificateType = `شهادة ميلاد طفل ${index + 1}`;
        const uploaded = uploadedDocuments.find((document) => document.type === certificateType);
        return {
          child_number: index + 1,
          child_name: childName,
          certificate_number: childCertNumbers[index],
          parent_national_id: nationalId,
          relationship: 'ابن/ابنة',
          certificate_type: certificateType,
          certificate_filename: uploaded ? uploaded.filename : ''
        };
      });
      saveJson(CHILDREN_FILE, childRecords);

      // OCR workflow: read each birth certificate and check the printed
      // child/father/mother names against the form inputs. Advisory only —
      // never blocks the registration.
      const ocrNotes = [];
      try {
        const { verifyBirthCertificate, ocrAvailable } = require('../helpers/ocr');
        if (childCertificates.length && !ocrAvailable()) {
          ocrNotes.push('الفحص الآلي لشهادات الميلاد غير متاح حاليًا — برجاء المراجعة اليدوية للأسماء.');
        } else {
          for (let i = 0; i < childCertificates.length; i++) {
            const check = await verifyBirthCertificate(childCertificates[i], {
              childName: childNames[i],
              headName: name
            });
            const label = `الطفل ${i + 1} (${childNames[i]})`;
            if (!check.checked) {
              ocrNotes.push(`⚠️ ${label}: ${check.detail}`);
            } else if (check.childMatch && check.parentMatch) {
              ocrNotes.push(`✅ ${label}: الأسماء مطابقة لشهادة الميلاد.`);
            } else {
              const missing = [];
              if (!check.childMatch) missing.push('اسم الطفل');
              if (!check.parentMatch) missing.push('اسم الأب/الأم');
              ocrNotes.push(`⚠️ ${label}: ${missing.join(' و')} غير مطابق لشهادة الميلاد — برجاء المراجعة.`);
            }
          }
        }
      } catch (ocrErr) {
        console.error('[ocr] birth certificate check failed:', ocrErr.message);
      }

      // Mirror the registration into SQLite (mandatory fields, documents,
      // pregnancy). Never breaks the response if the DB is unavailable.
      try {
        const { syncRegistrationToDb } = require('../db/sync');
        syncRegistrationToDb({
          name, nationalId, age, address, governorate, email,
          children, income, hasDisabled, hasOrphans, eligible,
          points, priorityLevel, currentDate, username: req.user.username,
          emailStatus, healthRow, pregnant, pregnancyKind, fetusCount,
          familyType, childrenMultiples, hasInsurance,
          uploadedDocuments, childRecords: childRecords[nationalId]
        });
      } catch (dbErr) {
        console.error('[db-sync] registration mirror failed:', dbErr.message);
      }

      if (docErrors.length) {
        message += ' ⚠️ لكن حصلت مشكلة في رفع بعض المستندات: ' + docErrors.join(' | ');
      }
      if (ocrNotes.length) {
        message += ' | فحص شهادات الميلاد: ' + ocrNotes.join(' | ');
      }
    }

    return res.view('register_family.html', { message });
  }
});

/* ============================================================ *
 * /register-birth  ->  register_birth  (GET + POST)
 * ============================================================ */
def(router, {
  name: 'register_birth',
  method: ['get', 'post'],
  path: '/register-birth',
  handler: async (req, res) => {
    let resultMessage = null;

    if (req.method === 'POST') {
      const motherName = String(f(req, 'mother_name')).trim();
      const motherNationalId = String(f(req, 'mother_national_id')).trim();
      const phone = String(f(req, 'phone')).trim();
      const governorate = String(f(req, 'governorate')).trim();
      const hospital = String(f(req, 'hospital')).trim();
      const birthDate = String(f(req, 'birth_date')).trim();
      const babyName = String(f(req, 'baby_name')).trim();
      const gender = String(f(req, 'gender')).trim();

      const births = readBirths();
      const newId = births.length ? Math.max(...births.map((b) => b.id)) + 1 : 1;
      const record = {
        id: newId,
        mother_name: motherName,
        mother_national_id: motherNationalId,
        phone,
        governorate,
        hospital,
        birth_date: birthDate,
        baby_name: babyName,
        gender,
        registered_by: req.user.username,
        registered_at: nowStamp(),
        sms_status: 'غير مطلوب (مولود مفرد)'
      };
      births.push(record);

      // كشف التوأم: نفس الرقم القومي للأم + نفس تاريخ الميلاد = نفس واقعة الولادة
      const siblings = births.filter((b) =>
        b.mother_national_id === motherNationalId && b.birth_date === birthDate
      );

      if (siblings.length >= 2) {
        const alreadySent = siblings.some((s) => s.sms_status === 'تم الإرسال بنجاح');
        if (!alreadySent) {
          const sent = await sendSupportSms(phone, motherName);
          const newStatus = sent.ok ? 'تم الإرسال بنجاح' : `لم يتم الإرسال: ${sent.msg}`;
          for (const b of births) {
            if (b.mother_national_id === motherNationalId && b.birth_date === birthDate) {
              b.sms_status = newStatus;
            }
          }
          resultMessage = `تم رصد توأم (عدد المواليد: ${siblings.length}). ${sent.msg}`;
        } else {
          record.sms_status = 'جزء من حالة توأم سبق إرسال رسالتها';
          resultMessage = 'تم رصد توأم — الرسالة كانت اتبعتت قبل كده لنفس الأسرة.';
        }
      } else {
        resultMessage = 'تم تسجيل المولود بنجاح (مولود مفرد، لا يستحق دعم التوائم).';
      }

      writeBirths(births);

      // Mirror the newborn into SQLite and auto-link twins sharing a birth date.
      try {
        const dbModels = require('../db/models');
        const fam = dbModels.getFamilyByNid(normalizeNid(motherNationalId));
        if (fam) {
          const added = dbModels.addChild(fam.id, {
            name: babyName, birth_date: birthDate, gender
          });
          if (added.ok) {
            const linked = dbModels.detectAndLinkTwins(fam.id, birthDate);
            if (linked.twins && siblings.length < 2) {
              resultMessage += ` (تم ربط التوأم في قاعدة البيانات: ${linked.count} مواليد)`;
            }
          }
        }
      } catch (dbErr) {
        console.error('[db-sync] birth mirror failed:', dbErr.message);
      }
    }

    return res.view('register_birth.html', { result_message: resultMessage });
  }
});

/* ============================================================ *
 * /births  ->  births_list
 * ============================================================ */
def(router, {
  name: 'births_list',
  path: '/births',
  handler: async (req, res) => {
    const births = readBirths();
    births.sort((a, b) => b.id - a.id);
    return res.view('births_list.html', { births });
  }
});

/* ============================================================ *
 * /documents/:national_id/:doc_filename  ->  download_document
 * ============================================================ */
def(router, {
  name: 'download_document',
  path: '/documents/:national_id/:doc_filename',
  handler: async (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'employee') {
      return res.flashRedirect('/', 'ليس لديك صلاحية الوصول لهذا المستند', 'danger');
    }

    const nationalId = req.params.national_id;
    const docFilename = req.params.doc_filename;
    const safeNationalId = safeName(nationalId) || 'unknown';

    audit(req, 'document_view', nationalId, docFilename);

    const absPath = path.join(DOCUMENTS_DIR, safeNationalId, path.basename(docFilename));
    if (!fs.existsSync(absPath)) {
      return res.status(404).type('html').send(
        '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
        '<title>الملف غير موجود</title></head><body style="font-family:sans-serif;text-align:center;padding:60px">' +
        '<h1>404</h1><p>الملف غير موجود</p><a href="/families">الرجوع للأسر</a></body></html>'
      );
    }
    return res.sendFile(absPath);
  }
});

/* ============================================================ *
 * /documents  ->  document_recognition  (GET + POST)
 * ============================================================ */
def(router, {
  name: 'document_recognition',
  method: ['get', 'post'],
  path: '/documents',
  middleware: [docUpload.fields([{ name: 'document_image', maxCount: 1 }])],
  handler: async (req, res) => {
    let result = null;
    let error = null;

    if (req.method === 'POST') {
      const docImage = file(req, 'document_image');

      // ── مسار 1: رفع صورة مستند ──
      if (docImage && docImage.originalname) {
        const allowed = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff', 'pdf']);
        const fname = docImage.originalname;
        const ext = fname.includes('.') ? fname.split('.').pop().toLowerCase() : '';

        if (!allowed.has(ext)) {
          error = 'نوع الملف غير مدعوم. يُرجى رفع صورة (JPG, PNG, PDF)';
        } else {
          // app.py runs pytesseract/PIL OCR here. Neither library exists in this
          // Node runtime, so we surface the same ImportError fallback message.
          error = 'مكتبة OCR غير مثبتة على الخادم. يُرجى استخدام إدخال النص اليدوي.';
        }

      // ── مسار 2: إدخال نص يدوي (للتجربة والتطوير) ──
      } else if (String(f(req, 'manual_text')).trim()) {
        const text = String(f(req, 'manual_text')).trim();
        if (text.length < 10) {
          error = 'النص قصير جداً، يُرجى إدخال محتوى المستند';
        } else {
          result = analyzeDocumentText(text);
          result.raw_text = text.slice(0, 500);
          result.input_method = 'manual';
        }
      } else {
        error = 'يُرجى رفع صورة مستند أو إدخال نصه يدوياً';
      }
    }

    return res.view('documents.html', { result, error });
  }
});

/* ============================================================ *
 * /certificate/:index  ->  certificate
 *
 * app.py streams a reportlab PDF. reportlab has no Node equivalent here, so we
 * return a self-contained, printable Arabic RTL HTML page carrying the exact
 * same information (unique reference id, family data, health alerts, signature
 * area) plus a print button. This is the PDF -> HTML substitution.
 * ============================================================ */
def(router, {
  name: 'certificate',
  path: '/certificate/:index',
  handler: async (req, res) => {
    const families = getFamilies();
    const index = parseInt(req.params.index, 10);

    if (Number.isNaN(index) || index < 0 || index >= families.length) {
      return res.flashRedirect('/families', 'الأسرة غير موجودة', 'danger');
    }

    const family = families[index];

    if ((family["مؤهل للدعم"] || '') !== 'نعم') {
      return res.flashRedirect('/families', 'هذه الأسرة غير مؤهلة للدعم', 'warning');
    }

    const nid = normalizeNid(family["الرقم القومي"]);
    const referenceId = 'CERT-' + (nid || 'unknown') + '-' +
      crypto.randomBytes(3).toString('hex').toUpperCase();
    const issueDate = new Date().toISOString().slice(0, 10);

    const level = family["مستوى الأولوية"] || '';
    const priorityColor = level.includes('أولوية قصوى')
      ? '#dc3545'
      : (level.includes('متوسطة') ? '#fd7e14' : '#198754');

    const alerts = healthAlerts(family);
    const alertsHtml = alerts.length
      ? '<ul style="margin:6px 0;padding-inline-start:22px">' +
        alerts.map((a) => `<li>${esc(ALERT_TYPES[a] || a)}</li>`).join('') +
        '</ul>'
      : '<p style="margin:6px 0;color:#6c757d">لا توجد تنبيهات صحية</p>';

    const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>شهادة دعم اجتماعي</title>
<style>
  body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; background:#f4f6fb; margin:0; padding:24px; color:#1f2937; }
  .sheet { max-width: 760px; margin: 0 auto; background:#fff; border:1px solid #e5e7eb; border-radius:14px; padding:40px; box-shadow:0 10px 30px rgba(0,0,0,.06); }
  h1 { color:#4361EE; text-align:center; font-size:28px; margin:0 0 6px; }
  .ref { text-align:center; color:#6c757d; font-size:13px; margin-bottom:24px; }
  .row { display:flex; justify-content:space-between; border-bottom:1px dashed #e5e7eb; padding:10px 0; font-size:16px; }
  .row .k { color:#6c757d; }
  .row .v { font-weight:700; }
  .priority { text-align:center; font-size:20px; font-weight:700; margin:24px 0; color:${priorityColor}; }
  .eligible { text-align:center; color:#10b981; font-weight:700; font-size:18px; margin:18px 0 6px; }
  .alerts { background:#fff8e1; border:1px solid #ffe08a; border-radius:10px; padding:12px 16px; margin:18px 0; }
  .alerts h3 { margin:0; font-size:15px; }
  .sign { margin-top:56px; display:flex; justify-content:space-between; }
  .sign .line { border-top:1px solid #9ca3af; width:220px; text-align:center; padding-top:8px; color:#6c757d; }
  .actions { text-align:center; margin:24px 0; }
  button { background:#4361EE; color:#fff; border:0; border-radius:8px; padding:10px 26px; font-size:16px; cursor:pointer; }
  @media print { .actions { display:none; } body { background:#fff; padding:0; } .sheet { box-shadow:none; border:0; } }
</style>
</head>
<body>
  <div class="sheet">
    <h1>شهادة دعم اجتماعي</h1>
    <div class="ref">الرقم المرجعي: ${esc(referenceId)}</div>

    <div class="row"><span class="k">اسم رب الأسرة</span><span class="v">${esc(family["اسم رب الأسرة"])}</span></div>
    <div class="row"><span class="k">الرقم القومي</span><span class="v">${esc(family["الرقم القومي"])}</span></div>
    <div class="row"><span class="k">المحافظة</span><span class="v">${esc(family["المحافظة"])}</span></div>
    <div class="row"><span class="k">عدد الأطفال</span><span class="v">${esc(family["عدد الأطفال"])}</span></div>
    <div class="row"><span class="k">عدد أفراد الأسرة</span><span class="v">${esc(family["عدد أفراد الأسرة"])}</span></div>
    <div class="row"><span class="k">الدخل الشهري</span><span class="v">${esc(family["الدخل الشهري"])} جنيه</span></div>
    <div class="row"><span class="k">معيل معاق</span><span class="v">${esc(family["معيل معاق"])}</span></div>
    <div class="row"><span class="k">أيتام</span><span class="v">${esc(family["أيتام"])}</span></div>

    <div class="priority">مستوى الأولوية: ${esc(level)}</div>

    <div class="eligible">✅ هذه الأسرة مؤهلة للحصول على الدعم الاجتماعي</div>

    <div class="alerts">
      <h3>التنبيهات الصحية</h3>
      ${alertsHtml}
    </div>

    <div class="row"><span class="k">تاريخ الإصدار</span><span class="v">${esc(issueDate)}</span></div>
    <div class="row"><span class="k">أصدرت بواسطة</span><span class="v">${esc(req.user.name)}</span></div>

    <div class="sign">
      <div class="line">توقيع المسؤول</div>
      <div class="line">ختم الوزارة</div>
    </div>
  </div>

  <div class="actions">
    <button onclick="window.print()">طباعة</button>
  </div>
</body>
</html>`;

    return res.type('html').send(html);
  }
});

/* ============================================================ *
 * /api/analyze-document  ->  api_analyze_document  (POST)
 * ============================================================ */
def(router, {
  name: 'api_analyze_document',
  method: 'post',
  path: '/api/analyze-document',
  handler: async (req, res) => {
    const data = req.body;
    if (!data || typeof data.text === 'undefined') {
      return res.status(400).json({ error: "يُرجى إرسال نص المستند في حقل 'text'" });
    }
    return res.json(analyzeDocumentText(data.text));
  }
});

module.exports = router;
