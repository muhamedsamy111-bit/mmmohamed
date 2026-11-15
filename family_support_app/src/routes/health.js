'use strict';

/**
 * Health layer routes (port of the matching app.py endpoints):
 *   health_alerts_view, health_stats_view, health_caravans,
 *   health_caravans_export, health_referral, health_gap,
 *   my_labs, download_lab, health_family_labs, ppd_list, ppd_record.
 *
 * The scoring/alerts logic lives in src/config/healthRules.js and is exposed
 * through src/helpers/scoring.js so these handlers read like the Python.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');

const { def } = require('./registry');
const { q, qint, f, files } = require('../helpers/httpx');
const {
  loadJson,
  saveJson,
  getFamilies,
  saveFamilies,
  LABS_INDEX,
  MENTAL_FILE,
  HEALTH_FACILITIES_FILE,
  FAMILIES_CSV,
  BACKUPS_DIR,
  LABS_DIR,
  GENERATED_BY,
  DATASET_IMPORTED_BY
} = require('../helpers/paths');
const {
  alertsFor,
  pct,
  healthAlerts,
  totalScore,
  hasHealthData,
  burdenPct,
  isPostpartum,
  ppdRisk,
  daysSince,
  PPD_RANK,
  ALERT_TYPES,
  ALERT_BADGE,
  CONFIG
} = require('../helpers/scoring');
const healthRules = require('../config/healthRules');
const { audit } = require('../helpers/audit');
const { flash } = require('../jinja/context');
const { labUpload } = require('../middlewares/upload');
const storage = require('../storage');
const {
  saveLabImage,
  safeName,
  LAB_CATEGORIES,
  LAB_MAX_MB,
  LAB_MAX_PER_FAMILY
} = require('../helpers/uploads');

const router = express.Router();

/* ------------------------------------------------------------------ *
 * Constants / small helpers (mirror the module-level bits in app.py)
 * ------------------------------------------------------------------ */

// egypt_family_generator.GOVERNORATES — key order matters for /health/gap.
const GOVERNORATES = [
  'القاهرة', 'الإسكندرية', 'بورسعيد', 'السويس', 'دمياط', 'الدقهلية',
  'الشرقية', 'القليوبية', 'كفر الشيخ', 'الغربية', 'المنوفية', 'البحيرة',
  'الإسماعيلية', 'الجيزة', 'بني سويف', 'الفيوم', 'المنيا', 'أسيوط',
  'سوهاج', 'قنا', 'أسوان', 'الأقصر', 'البحر الأحمر', 'الوادي الجديد',
  'مطروح', 'شمال سيناء', 'جنوب سيناء'
];

const pad2 = (n) => String(n).padStart(2, '0');

/** datetime.now().strftime("%Y-%m-%d") */
function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** datetime.now().strftime("%Y-%m-%d %H:%M") */
function nowStamp(d = new Date()) {
  return `${todayStr(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** datetime.now().strftime("%Y%m%d_%H%M%S") — used for backup file names. */
function tsCompact(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** Strict "%Y-%m-%d" round-trip check (mirrors datetime.strptime). */
function isValidDate(value) {
  const s = String(value === null || value === undefined ? '' : value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  const d = new Date(year, month - 1, day);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

/** app.py::_visible_family_rows — employee scoped to their governorate. */
function visibleFamilyRows(req) {
  const user = req.user || {};
  const out = [];
  getFamilies().forEach((row, index) => {
    if (user.role === 'employee' && user.governorate &&
        (row['المحافظة'] || '') !== user.governorate) {
      return;
    }
    out.push({ index, row });
  });
  return out;
}

/** app.py::_staff_only — returns true when it already sent the response. */
function staffOnly(req, res) {
  if (req.user.role !== 'admin' && req.user.role !== 'employee') {
    res.flashRedirect('/dashboard', 'هذه الصفحة للموظفين والمدير فقط', 'danger');
    return true;
  }
  return false;
}

/** app.py::_psych_only — returns true when it already sent the response. */
function psychOnly(req, res) {
  if (req.user.role !== 'admin' && req.user.role !== 'psychologist') {
    res.flashRedirect('/dashboard', 'هذه الصفحة للأخصائي النفسي والمدير فقط', 'danger');
    return true;
  }
  return false;
}

/** app.py::_load_facilities. */
function loadFacilities() {
  let data = {};
  try {
    data = loadJson(HEALTH_FACILITIES_FILE, {});
  } catch {
    data = {};
  }
  const units = data.units || {};
  const out = {};
  for (const g of GOVERNORATES) {
    out[g] = Object.prototype.hasOwnProperty.call(units, g) ? units[g] : null;
  }
  return { source: data.source || '', year: data.year || '', units: out };
}

/** app.py::_caravan_selection. */
function caravanSelection(req, gov, capacity) {
  const chosen = [];
  for (const { index, row } of visibleFamilyRows(req)) {
    if ((row['المحافظة'] || '') === gov && healthRules.needsFollowup(row)) {
      chosen.push({
        idx: index,
        row,
        alerts: alertsFor(row),
        total: totalScore(row)
      });
    }
  }
  chosen.sort((a, b) => b.total - a.total);
  return [chosen, chosen.slice(0, capacity)];
}

/** app.py::_my_family_rows. */
function myFamilyRows(req) {
  return getFamilies().filter((r) => (r['أضيف بواسطة'] || '') === req.user.username);
}

function labsFor(nid) {
  const idx = loadJson(LABS_INDEX, {});
  return Array.isArray(idx[nid]) ? idx[nid] : [];
}

/** csv.writer cell quoting (used by health_caravans_export). */
function csvValue(v) {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function csvRow(values) {
  return values.map(csvValue).join(',');
}

/* ============================================================ *
 * /health/alerts  ->  health_alerts_view
 * ============================================================ */
def(router, {
  name: 'health_alerts_view',
  path: '/health/alerts',
  handler: async (req, res) => {
    if (staffOnly(req, res)) return;

    const alertType = String(q(req, 'type')).trim();
    const gov = String(q(req, 'gov')).trim();
    const rawSearch = q(req, 'search');
    const search = String(rawSearch).trim().toLowerCase();
    let page = Math.max(1, qint(req, 'page', 1));
    const perPage = 50;

    const visible = visibleFamilyRows(req);
    const mh = loadJson(MENTAL_FILE, {});
    const screened = new Set(
      Object.keys(mh).filter((n) =>
        mh[n] && Array.isArray(mh[n].records) && mh[n].records.length)
    );
    const labsIdx = loadJson(LABS_INDEX, {});

    const typeCounts = {};
    for (const k of Object.keys(ALERT_TYPES)) typeCounts[k] = 0;

    const govSet = new Set();
    for (const { row } of visible) {
      if (row['المحافظة']) govSet.add(row['المحافظة']);
    }
    const governorates = Array.from(govSet).sort();

    const items = [];
    for (const { index, row } of visible) {
      const alerts = alertsFor(row, screened);
      if (!alerts.length) continue;
      if (gov && (row['المحافظة'] || '') !== gov) continue;
      if (search &&
          !String(row['اسم رب الأسرة'] || '').toLowerCase().includes(search) &&
          !String(row['الرقم القومي'] || '').includes(search)) {
        continue;
      }
      for (const a of alerts) typeCounts[a] += 1;
      if (alertType && !alerts.includes(alertType)) continue;
      items.push({
        idx: index,
        row,
        alerts,
        total: totalScore(row),
        labs: Array.isArray(labsIdx[row['الرقم القومي']]) ? labsIdx[row['الرقم القومي']].length : 0
      });
    }
    items.sort((a, b) => b.total - a.total);

    const totalCount = items.length;
    const pages = Math.max(1, Math.ceil(totalCount / perPage));
    page = Math.min(page, pages);

    return res.view('health_alerts.html', {
      items: items.slice((page - 1) * perPage, page * perPage),
      total_count: totalCount,
      page,
      pages,
      per_page: perPage,
      type_counts: typeCounts,
      alert_types: ALERT_TYPES,
      alert_badge: ALERT_BADGE,
      selected_type: alertType,
      selected_gov: gov,
      search: rawSearch,
      governorates,
      offset: (page - 1) * perPage
    });
  }
});

/* ============================================================ *
 * /health/stats  ->  health_stats_view
 * ============================================================ */
def(router, {
  name: 'health_stats_view',
  path: '/health/stats',
  handler: async (req, res) => {
    if (staffOnly(req, res)) return;

    const visible = visibleFamilyRows(req);
    const tot = {
      families: 0, with_data: 0, pregnant: 0, preg_unmon: 0, under5_fam: 0,
      vacc_total: 0, vacc_ok: 0, malnut: 0, chronic: 0, need: 0, burden: 0, overdue: 0
    };
    const byGov = {};

    for (const { row: r } of visible) {
      tot.families += 1;
      if (!hasHealthData(r)) continue;
      const g = (r['المحافظة'] !== undefined && r['المحافظة'] !== null)
        ? r['المحافظة'] : 'غير معروف';
      if (!byGov[g]) {
        byGov[g] = {
          n: 0, preg: 0, preg_unmon: 0, vacc_total: 0, vacc_ok: 0,
          malnut: 0, chronic: 0, need: 0, burden: 0, overdue: 0
        };
      }
      const d = byGov[g];
      const al = healthAlerts(r);

      tot.with_data += 1; d.n += 1;
      if (r['حامل'] === 'نعم') { tot.pregnant += 1; d.preg += 1; }
      if (al.includes('pregnant')) { tot.preg_unmon += 1; d.preg_unmon += 1; }
      if (r['تطعيمات مكتملة'] === 'نعم' || r['تطعيمات مكتملة'] === 'لا') {
        tot.under5_fam += 1; tot.vacc_total += 1; d.vacc_total += 1;
        if (r['تطعيمات مكتملة'] === 'نعم') { tot.vacc_ok += 1; d.vacc_ok += 1; }
      }
      if (al.includes('malnutrition')) { tot.malnut += 1; d.malnut += 1; }
      if (al.includes('chronic')) { tot.chronic += 1; d.chronic += 1; }
      if (al.includes('burden')) { tot.burden += 1; d.burden += 1; }
      if (al.includes('overdue')) { tot.overdue += 1; d.overdue += 1; }
      if (healthRules.needsFollowup(r)) { tot.need += 1; d.need += 1; }
    }

    const rows = Object.keys(byGov).map((g) => {
      const d = byGov[g];
      return {
        gov: g,
        ...d,
        vacc_pct: pct(d.vacc_ok, d.vacc_total),
        need_pct: pct(d.need, d.n) || 0
      };
    });
    rows.sort((a, b) => b.need_pct - a.need_pct);

    const chartData = JSON.stringify({
      labels: rows.map((r) => r.gov),
      values: rows.map((r) => r.need_pct)
    });

    return res.view('health_stats.html', {
      tot,
      rows,
      cfg: CONFIG,
      vacc_pct: pct(tot.vacc_ok, tot.vacc_total),
      need_pct: pct(tot.need, tot.with_data),
      chart_data: chartData
    });
  }
});

/* ============================================================ *
 * /health/caravans  ->  health_caravans
 * ============================================================ */
def(router, {
  name: 'health_caravans',
  path: '/health/caravans',
  handler: async (req, res) => {
    if (staffOnly(req, res)) return;

    const by = q(req, 'by', 'count');
    const capacity = Math.max(10, Math.min(qint(req, 'capacity', 150), 2000));

    const perGov = {};
    for (const { row: r } of visibleFamilyRows(req)) {
      if (!hasHealthData(r)) continue;
      const g = (r['المحافظة'] !== undefined && r['المحافظة'] !== null)
        ? r['المحافظة'] : 'غير معروف';
      if (!perGov[g]) perGov[g] = { gov: g, n: 0, need: 0 };
      const d = perGov[g];
      d.n += 1;
      if (healthRules.needsFollowup(r)) d.need += 1;
    }

    const govs = Object.values(perGov);
    for (const d of govs) {
      d.pct = d.n ? Math.round((d.need / d.n) * 1000) / 10 : 0;
    }
    if (by === 'pct') {
      govs.sort((a, b) => b.pct - a.pct);
    } else {
      govs.sort((a, b) => b.need - a.need);
    }

    let gov = String(q(req, 'gov')).trim();
    if (!gov) gov = govs.length ? govs[0].gov : '';

    let allNeed = [];
    let selected = [];
    if (gov) {
      [allNeed, selected] = caravanSelection(req, gov, capacity);
    }

    return res.view('health_caravans.html', {
      govs,
      gov,
      by,
      capacity,
      selected,
      need_total: allNeed.length,
      alert_types: ALERT_TYPES,
      alert_badge: ALERT_BADGE
    });
  }
});

/* ============================================================ *
 * /health/caravans/export  ->  health_caravans_export
 * ============================================================ */
def(router, {
  name: 'health_caravans_export',
  path: '/health/caravans/export',
  handler: async (req, res) => {
    if (staffOnly(req, res)) return;

    const gov = String(q(req, 'gov')).trim();
    const capacity = Math.max(10, Math.min(qint(req, 'capacity', 150), 2000));
    const [, selected] = caravanSelection(req, gov, capacity);

    const lines = [];
    lines.push(csvRow([
      'الترتيب', 'اسم رب الأسرة', 'الرقم القومي', 'المحافظة', 'التنبيهات',
      'الدرجة الاجتماعية', 'الدرجة الصحية', 'الدرجة الإجمالية'
    ]));
    selected.forEach((it, n) => {
      const r = it.row;
      lines.push(csvRow([
        n + 1,
        r['اسم رب الأسرة'],
        r['الرقم القومي'],
        r['المحافظة'],
        it.alerts.map((a) => ALERT_TYPES[a] || a).join(' | '),
        r['درجة الأولوية'],
        r['درجة الأولوية الصحية'],
        it.total
      ]));
    });

    audit(req, 'health_caravan_export', gov, `${selected.length} families`);

    res.type('text/csv');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename=caravan_list.csv');
    return res.send('\ufeff' + lines.join('\r\n') + '\r\n');
  }
});

/* ============================================================ *
 * /health/referral/:index  ->  health_referral
 * ============================================================ */
def(router, {
  name: 'health_referral',
  path: '/health/referral/:index',
  handler: async (req, res) => {
    if (staffOnly(req, res)) return;

    const index = parseInt(req.params.index, 10);
    const map = {};
    for (const { index: i, row } of visibleFamilyRows(req)) map[i] = row;
    const row = map[index];
    if (!row) {
      return res.flashRedirect('/health/alerts', 'الأسرة غير موجودة أو خارج نطاق صلاحيتك', 'danger');
    }

    audit(req, 'health_referral', row['الرقم القومي'] || '');

    const b = burdenPct(row);
    const burden = b === null
      ? '—'
      : (b === Infinity ? 'لا يوجد دخل' : `${b}%`);

    const now = new Date();
    const ymd = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;

    return res.view('health_referral.html', {
      family: row,
      index,
      alerts: alertsFor(row),
      alert_types: ALERT_TYPES,
      burden,
      total: totalScore(row),
      today: todayStr(now),
      issuer: req.user.name || req.user.username,
      ref: `REF-${index + 1}-${ymd}`
    });
  }
});

/* ============================================================ *
 * /health/gap  ->  health_gap  (GET + POST)
 *
 * POST saves the official health-unit counts (admin only). When the form
 * carries action=backfill_health it instead fills missing synthetic health
 * data via src/services/generator.js (also admin only).
 * ============================================================ */
function handleHealthBackfill(req, res) {
  let generator = null;
  try {
    generator = require('../services/generator');
  } catch {
    generator = null;
  }

  const needsBackfill = generator && (generator.needsBackfill || generator.needs_backfill);
  const backfillRow = generator && (generator.backfillRow || generator.backfill_row);
  if (typeof needsBackfill !== 'function' || typeof backfillRow !== 'function') {
    return res.flashRedirect(
      '/health/gap',
      'تعذّر تنفيذ التعبئة الصحية: وحدة توليد البيانات غير متاحة',
      'warning'
    );
  }

  let filled = 0;
  try {
    const synthetic = new Set([GENERATED_BY, DATASET_IMPORTED_BY]);
    const rows = getFamilies().map((r) => ({ ...r }));
    rows.forEach((r, i) => {
      if (synthetic.has(r['أضيف بواسطة']) && needsBackfill(r)) {
        backfillRow(r, i);
        filled += 1;
      }
    });
    if (filled) {
      try {
        fs.mkdirSync(BACKUPS_DIR, { recursive: true });
        fs.copyFileSync(
          FAMILIES_CSV,
          path.join(BACKUPS_DIR, `before_backfill_health_${tsCompact()}.csv`)
        );
      } catch {
        // Best-effort backup, same as the Python route.
      }
      saveFamilies(rows);
    }
  } catch {
    return res.flashRedirect('/health/gap', 'تعذّر تنفيذ التعبئة الصحية، حاول لاحقًا', 'warning');
  }

  audit(req, 'backfill_health', '', `${filled} rows`);
  return res.flashRedirect(
    '/health/gap',
    `تمت تعبئة بيانات صحية تجريبية لـ ${filled} أسرة (الأسر الحقيقية لم تتأثر).`,
    filled ? 'success' : 'info'
  );
}

def(router, {
  name: 'health_gap',
  method: ['get', 'post'],
  path: '/health/gap',
  handler: async (req, res) => {
    if (staffOnly(req, res)) return;

    if (req.method === 'POST') {
      if (req.user.role !== 'admin') {
        return res.flashRedirect('/health/gap', 'تعديل بيانات الوحدات الصحية للمدير فقط', 'danger');
      }
      if (String(f(req, 'action')).trim() === 'backfill_health') {
        return handleHealthBackfill(req, res);
      }

      const units = {};
      for (const g of GOVERNORATES) {
        const raw = String(f(req, 'units_' + g)).trim();
        let value = null;
        if (raw !== '') {
          value = /^[+-]?\d+$/.test(raw) ? Math.max(0, parseInt(raw, 10)) : null;
        }
        units[g] = value;
      }

      saveJson(HEALTH_FACILITIES_FILE, {
        source: String(f(req, 'source')).trim(),
        year: String(f(req, 'year')).trim(),
        units
      });

      const filled = Object.values(units).filter((v) => v !== null).length;
      audit(req, 'health_facilities_update', '', `${filled} governorates`);
      return res.flashRedirect('/health/gap', 'تم حفظ بيانات الوحدات الصحية', 'success');
    }

    const fac = loadFacilities();
    const need = {};
    for (const { row: r } of visibleFamilyRows(req)) {
      if (hasHealthData(r) && healthRules.needsFollowup(r)) {
        const g = (r['المحافظة'] !== undefined && r['المحافظة'] !== null)
          ? r['المحافظة'] : 'غير معروف';
        need[g] = (need[g] || 0) + 1;
      }
    }

    const rows = [];
    for (const g of Object.keys(fac.units)) {
      const u = fac.units[g];
      const n = need[g] || 0;
      rows.push({
        gov: g,
        units: u,
        need: n,
        per_unit: u ? Math.round((n / u) * 100) / 100 : null
      });
    }
    rows.sort((a, b) => {
      const an = a.per_unit === null;
      const bn = b.per_unit === null;
      if (an !== bn) return an ? 1 : -1;
      return (b.per_unit || 0) - (a.per_unit || 0);
    });

    return res.view('health_gap.html', {
      rows,
      source: fac.source,
      year: fac.year,
      filled: rows.filter((r) => r.units !== null).length,
      is_admin: req.user.role === 'admin'
    });
  }
});

/* ============================================================ *
 * /my-labs  ->  my_labs  (GET + POST)
 * ============================================================ */
def(router, {
  name: 'my_labs',
  method: ['get', 'post'],
  path: '/my-labs',
  middleware: [labUpload.array('lab_images', 5)],
  handler: async (req, res) => {
    const families = myFamilyRows(req);
    const myNids = new Set(families.map((fm) => fm['الرقم القومي']));

    if (req.method === 'POST') {
      const nid = f(req, 'nid');
      if (!myNids.has(nid)) {
        return res.flashRedirect('/my-labs', 'الأسرة دي مش مسجلة باسمك', 'danger');
      }

      const idx = loadJson(LABS_INDEX, {});
      const entriesOf = (key) => (Array.isArray(idx[key]) ? idx[key] : []);

      if (f(req, 'action') === 'delete') {
        const labId = f(req, 'lab_id');
        const entries = entriesOf(nid);
        const target = entries.find((e) => e.id === labId);
        if (target) {
          try {
            storage.remove(path.posix.join('uploads', 'labs', safeName(nid), target.filename));
          } catch {
            // Same as os.remove(...) OSError being swallowed.
          }
          idx[nid] = entries.filter((e) => e.id !== labId);
          saveJson(LABS_INDEX, idx);
          audit(req, 'lab_delete', nid, labId);
          return res.flashRedirect('/my-labs', 'تم حذف الصورة', 'info');
        }
        return res.redirect('/my-labs');
      }

      let category = f(req, 'category');
      if (!LAB_CATEGORIES.includes(category)) category = 'تحاليل أخرى';

      const uploadFiles = files(req, 'lab_images').filter((x) => x && x.originalname);

      if (!f(req, 'consent')) {
        flash(req, 'لازم توافق على حفظ الصور عشان نكمل', 'warning');
      } else if (!uploadFiles.length) {
        flash(req, 'اختار صورة واحدة على الأقل', 'warning');
      } else if (uploadFiles.length > 5) {
        flash(req, 'الحد الأقصى 5 صور في المرة الواحدة', 'warning');
      } else if (entriesOf(nid).length + uploadFiles.length > LAB_MAX_PER_FAMILY) {
        flash(req, `الحد الأقصى ${LAB_MAX_PER_FAMILY} صورة لكل أسرة`, 'warning');
      } else {
        let okCount = 0;
        const errors = [];
        for (const fl of uploadFiles) {
          const result = await saveLabImage(nid, fl, category, f(req, 'note'), req.user.username);
          if (result.ok) {
            okCount += 1;
          } else {
            errors.push(result.msg);
          }
        }
        if (okCount) {
          audit(req, 'lab_upload', nid, `${okCount} files, ${category}`);
          flash(req, `✅ تم حفظ ${okCount} صورة`, 'success');
        }
        for (const e of errors) flash(req, e, 'danger');
      }

      return res.redirect('/my-labs');
    }

    const idx = loadJson(LABS_INDEX, {});
    return res.view('my_labs.html', {
      families,
      labs: idx,
      categories: LAB_CATEGORIES,
      max_mb: LAB_MAX_MB,
      max_per: LAB_MAX_PER_FAMILY
    });
  }
});

/* ============================================================ *
 * /labs/:nid/:fname  ->  download_lab
 * ============================================================ */
def(router, {
  name: 'download_lab',
  path: '/labs/:nid/:fname',
  handler: async (req, res) => {
    const nid = req.params.nid;
    const fname = req.params.fname;

    const entries = labsFor(nid);
    if (!entries.some((e) => e.filename === fname)) {
      return res.status(404).type('html').send('غير موجود');
    }

    if (req.user.role === 'user') {
      const mine = new Set(myFamilyRows(req).map((fm) => fm['الرقم القومي']));
      if (!mine.has(nid)) {
        return res.status(403).type('html').send('غير مسموح');
      }
    }
    if (!['admin', 'employee', 'user'].includes(req.user.role)) {
      return res.status(403).type('html').send('غير مسموح');
    }

    audit(req, 'lab_view', nid, fname);

    const absPath = path.join(LABS_DIR, safeName(nid), path.basename(fname));
    if (!fs.existsSync(absPath)) {
      return res.status(404).type('html').send('غير موجود');
    }
    return res.sendFile(absPath);
  }
});

/* ============================================================ *
 * /health/labs/:index  ->  health_family_labs
 * ============================================================ */
def(router, {
  name: 'health_family_labs',
  path: '/health/labs/:index',
  handler: async (req, res) => {
    if (staffOnly(req, res)) return;

    const index = parseInt(req.params.index, 10);
    const map = {};
    for (const { index: i, row } of visibleFamilyRows(req)) map[i] = row;
    const row = map[index];
    if (!row) {
      return res.flashRedirect('/health/alerts', 'الأسرة غير موجودة أو خارج نطاق صلاحيتك', 'danger');
    }

    const nid = row['الرقم القومي'] || '';
    return res.view('health_labs.html', {
      family: row,
      labs: labsFor(nid),
      nid
    });
  }
});

/* ============================================================ *
 * /mental/ppd  ->  ppd_list
 * ============================================================ */
def(router, {
  name: 'ppd_list',
  path: '/mental/ppd',
  handler: async (req, res) => {
    if (psychOnly(req, res)) return;

    const show = q(req, 'show', 'all');
    let page = Math.max(1, qint(req, 'page', 1));

    const mh = loadJson(MENTAL_FILE, {});
    const items = [];
    for (const { index, row } of visibleFamilyRows(req)) {
      if (!isPostpartum(row)) continue;
      const nid = row['الرقم القومي'] || '';
      const node = mh[nid];
      const recs = node && Array.isArray(node.records) ? node.records : [];
      const last = recs.length ? recs[recs.length - 1] : null;
      items.push({
        idx: index,
        row,
        last,
        risk: ppdRisk(last),
        days: daysSince(row['تاريخ آخر ولادة'])
      });
    }

    const counts = {
      total: items.length,
      unscreened: items.filter((i) => i.risk === 'لم يُمسح').length,
      needs: items.filter((i) => i.risk === 'يحتاج تقييم').length,
      urgent: items.filter((i) => i.risk === 'عاجل').length
    };

    const flt = {
      unscreened: ['لم يُمسح'],
      needs: ['يحتاج تقييم'],
      urgent: ['عاجل']
    }[show];

    let filtered = items;
    if (flt) filtered = items.filter((i) => flt.includes(i.risk));

    filtered.sort((a, b) =>
      ((PPD_RANK[a.risk] !== undefined ? PPD_RANK[a.risk] : 9) -
       (PPD_RANK[b.risk] !== undefined ? PPD_RANK[b.risk] : 9)) ||
      ((a.days !== null && a.days !== undefined ? a.days : 9999) -
       (b.days !== null && b.days !== undefined ? b.days : 9999))
    );

    const perPage = 50;
    const pages = Math.max(1, Math.ceil(filtered.length / perPage));
    page = Math.min(page, pages);

    return res.view('ppd_list.html', {
      items: filtered.slice((page - 1) * perPage, page * perPage),
      counts,
      show,
      page,
      pages,
      offset: (page - 1) * perPage,
      cfg: CONFIG
    });
  }
});

/* ============================================================ *
 * /mental/ppd/:index  ->  ppd_record  (GET + POST)
 * ============================================================ */
def(router, {
  name: 'ppd_record',
  method: ['get', 'post'],
  path: '/mental/ppd/:index',
  handler: async (req, res) => {
    if (psychOnly(req, res)) return;

    const index = parseInt(req.params.index, 10);
    const map = {};
    for (const { index: i, row } of visibleFamilyRows(req)) map[i] = row;
    const row = map[index];
    if (!row) {
      return res.flashRedirect('/mental/ppd', 'الأسرة غير موجودة أو خارج نطاق صلاحيتك', 'danger');
    }
    const nid = row['الرقم القومي'] || '';
    const mh = loadJson(MENTAL_FILE, {});

    if (req.method === 'POST') {
      const rawDate = String(f(req, 'screening_date')).trim();
      const screeningDate = isValidDate(rawDate) ? rawDate : todayStr();

      const epdsRaw = String(f(req, 'epds')).trim();
      let epds = '';
      if (epdsRaw !== '') {
        epds = /^[+-]?\d+$/.test(epdsRaw)
          ? Math.max(0, Math.min(parseInt(epdsRaw, 10), 30))
          : '';
      }

      const record = {
        date: screeningDate,
        epds,
        self_harm: f(req, 'self_harm') === 'نعم' ? 'نعم' : 'لا',
        follow_up: f(req, 'follow_up', 'لم يبدأ'),
        notes: String(f(req, 'notes')).slice(0, 1000),
        // app.py stores "by"; the port also records it as specialist_name.
        by: req.user.username,
        specialist_name: req.user.username,
        at: nowStamp()
      };

      if (!mh[nid] || typeof mh[nid] !== 'object') mh[nid] = { records: [] };
      if (!Array.isArray(mh[nid].records)) mh[nid].records = [];
      mh[nid].records.push(record);
      saveJson(MENTAL_FILE, mh);

      audit(req, 'ppd_record', nid, ppdRisk(record));
      return res.flashRedirect(`/mental/ppd/${index}`, 'تم حفظ التقييم', 'success');
    }

    const node = mh[nid];
    const records = node && Array.isArray(node.records) ? node.records : [];
    audit(req, 'ppd_view', nid);

    return res.view('ppd_record.html', {
      family: row,
      index,
      records: records.slice().reverse(),
      risk: ppdRisk(records.length ? records[records.length - 1] : null),
      today: todayStr(),
      cfg: CONFIG,
      days: daysSince(row['تاريخ آخر ولادة'])
    });
  }
});

module.exports = router;
