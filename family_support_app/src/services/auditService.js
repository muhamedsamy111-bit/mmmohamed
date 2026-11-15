const { AUDIT_LOG_FILE, loadJson, saveJson } = require('./dataService');

const AUDIT_MAX_ENTRIES = 5000;

const AUDIT_LABELS = {
  "login_success": "تسجيل دخول",
  "family_add_citizen": "تسجيل أسرة (مواطن)",
  "family_add": "إضافة أسرة",
  "family_edit": "تعديل أسرة",
  "family_delete": "حذف أسرة",
  "status_change": "تغيير حالة طلب",
  "document_view": "فتح مستند",
  "export_excel": "تصدير Excel",
  "export_monthly_report": "تقرير شهري",
  "import": "استيراد بيانات",
  "generate_families": "توليد أسر تجريبية",
  "clear_generated": "حذف الأسر المولّدة",
  "employee_create": "إنشاء حساب موظف",
  "lab_upload": "رفع صورة تحليل",
  "lab_delete": "حذف صورة تحليل",
  "lab_view": "عرض صورة تحليل",
  "ppd_record": "تسجيل مسح اكتئاب ما بعد الولادة",
  "ppd_view": "عرض سجلات اكتئاب ما بعد الولادة"
};

function maskNid(value) {
  const str = String(value || "");
  if (/^\d{8,}$/.test(str)) {
    return str.slice(0, 3) + "*".repeat(str.length - 5) + str.slice(-2);
  }
  return str;
}

function formatDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const Y = date.getFullYear();
  const M = pad(date.getMonth() + 1);
  const D = pad(date.getDate());
  const h = pad(date.getHours());
  const m = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  return `${Y}-${M}-${D} ${h}:${m}:${s}`;
}

function logAudit(req, action, target = "", details = "") {
  try {
    const entries = loadJson(AUDIT_LOG_FILE, []);
    const user = req && req.user ? req.user.username : "anonymous";
    const role = req && req.user ? req.user.role : "";
    const ip = req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '') : '';

    entries.push({
      time: formatDate(),
      user,
      role,
      action,
      target: maskNid(target),
      details: String(details),
      ip: String(ip).replace(/^.*:/, '') // clean IPv6 prefix if present
    });

    const trimmed = entries.slice(-AUDIT_MAX_ENTRIES);
    saveJson(AUDIT_LOG_FILE, trimmed);
  } catch (err) {
    // Audit must never crash request handling
  }
}

function getAuditLogs(limit = 300) {
  const entries = loadJson(AUDIT_LOG_FILE, []);
  return entries.slice(-limit).reverse();
}

module.exports = {
  AUDIT_LABELS,
  maskNid,
  logAudit,
  getAuditLogs
};
