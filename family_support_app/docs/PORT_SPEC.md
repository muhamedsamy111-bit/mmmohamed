# Express port — implementation contract

The Flask app (`app.py`, 3274 lines, 57 routes) is the source of truth. The
Express port must behave the same: same URLs, same template context keys, same
flash messages, same role rules, same files on disk.

Project root: the repo you are in (`family_support_app/`). Node 24, Express 4,
CommonJS (`require`). Templates are Jinja2 and are rendered as-is by the
compatibility layer listed below — **never edit files in `templates/`.**

## 1. Registering a route

```js
const express = require('express');
const { def } = require('./registry');           // src/routes/registry.js

const router = express.Router();

def(router, {
  name: 'health_alerts_view',      // EXACT Flask endpoint function name
  method: 'get',                   // 'get' | 'post' | array of both
  path: '/health/alerts',          // Express path: :index instead of <int:index>
  auth: true,                      // default true -> requireAuth
  middleware: [],                  // e.g. [docUpload.fields([...])]
  handler: async (req, res) => { }
});

module.exports = router;
```

`name` matters twice: templates call `url_for('name')` and the role guard uses
it, so it must match the Flask function name exactly.

## 2. Replying

| Flask | Express port |
|---|---|
| `render_template("x.html", a=1)` | `res.view('x.html', { a: 1 })` |
| `render_template("x.html", a=1), 404` | `res.view('x.html', { a: 1 }, 404)` |
| `flash(msg, 'danger')` | `res.flashRedirect(url, msg, 'danger')` |
| `redirect(url_for('y'))` | `res.redirect('/y-path')` |
| `redirect(url_for('y', index=3))` | `res.redirect('/y-path/' + 3)` |
| `jsonify({...})` | `res.json({...})` |
| `send_file(...)` | `res.sendFile(absPath)` / `res.download(absPath, name)` |

`res.view` renders through the Jinja compatibility layer and injects
`url_for`, `request`, `current_user`, `get_flashed_messages`, `layout`, plus the
data object you pass.

## 3. Request parsing

```js
const { q, qint, f, fall, files, file } = require('../helpers/httpx');
q(req,'page')        // request.args.get('page')
qint(req,'page',1)   // int(request.args.get('page',1))
f(req,'name')        // request.form.get('name')
fall(req,'fields')   // request.form.getlist('fields')
file(req,'id_document')  // request.files.get('id_document')
files(req,'lab_images')  // request.files.getlist('lab_images')
```
Uploaded files are multer objects: `{ originalname, mimetype, size, buffer }`.
Python's `.filename` -> `file.originalname`; save with `file.buffer`.

## 4. Available helpers

```js
// data layer (absolute paths accepted by loadJson/saveJson)
require('../helpers/paths');
// BASE_DIR DATA_DIR FAMILIES_CSV LABS_INDEX MENTAL_FILE NOTES_FILE VISITS_FILE
// BIRTHS_FILE DOCUMENTS_INDEX_FILE BACKUPS_DIR CAPMAS_FILE HEALTH_FACILITIES_FILE
// HEALTH_SCHEDULE_FILE USER_ACCOUNTS_FILE EMPLOYEE_ACCOUNTS_FILE AUDIT_LOG_FILE
// CSV_FIELDNAMES loadJson saveJson getFamilies saveFamilies getFamilyByIndex
// getFamilyByNid GENERATED_BY DATASET_IMPORTED_BY STATUSES
loadJson(p, {})      // {"a":1} default; {} default as in python
saveJson(p, obj)

// scoring / health rules
require('../helpers/scoring');
priorityTuple(children, income, hasDisabled, hasOrphans) -> [score, level, color, breakdown]
alertsFor(row, screenedSet) -> array of alert keys
pct(a, b) -> number|null      // round(a/b*100, 1)
healthScore(row), totalScore(row), healthAlerts(row), burdenPct(row),
hasHealthData(row), isPostpartum(row), ppdRisk(record), daysSince(dateStr)
ALERT_TYPES, ALERT_BADGE, PPD_RANK, CONFIG

// audit trail
require('../helpers/audit');        // audit(req, action, target, details), AUDIT_LABELS, maskNid, getAuditLogs

// security
require('../helpers/security');
// isStrongPassword(pw)->{ok,msg} encryptSensitive decryptSensitive clientIp(req)
// isBlocked(ip) recordFailedAttempt(ip,user) recordSuccess(ip,user) getSecurityLog()

// accounts
require('../services/authService');
// getAllUsers() verifyPassword(plain, stored) hashPassword(pw)
// registerUser(username,password,name) registerEmployee(username,password,name,gov,role)
// changeUserPassword(username,newPassword)

// uploads
require('../helpers/uploads');
// saveFamilyDocument(nid, file, label) -> {ok, info}
// saveLabImage(nid, file, category, note, username) -> Promise<{ok,msg}>
// LAB_CATEGORIES LAB_MAX_PER_FAMILY safeName

// multer
require('../middlewares/upload');   // { docUpload, labUpload, importUpload }

// national id
require('./priorityShim' or '../helpers/priorityShim');
calculatePriority(children, income, hasDisabled, hasOrphans) -> {score, level, color, breakdown}
normalizeNid(v), validateNationalIdFormat(nid) -> {ok, msg}
```

`getFamilies()` returns an array of plain objects keyed by the Arabic CSV column
names. `saveFamilies(rows)` rewrites `families.csv` (BOM + the shared field
order in `CSV_FIELDNAMES`, which already includes the 12 health columns).

## 5. Endpoint name -> path (use these literal URLs)

| endpoint | path |
|---|---|
| welcome | `/` |
| login | `/login` |
| signup | `/signup` |
| logout | `/logout` |
| public_home | `/home` |
| employee_home | `/employee` |
| index | `/dashboard` |
| families | `/families` |
| delete | `/delete/:index` |
| set_request_status | `/families/:index/set-status` |
| register_family | `/register-family` |
| register_birth | `/register-birth` |
| births_list | `/births` |
| download_document | `/documents/:national_id/:doc_filename` |
| document_recognition | `/documents` |
| certificate | `/certificate/:index` |
| family_notes | `/notes/:index` |
| delete_note | `/notes/delete/:index/:note_index` |
| followup | `/followup/:index` |
| delete_visit | `/followup/delete/:index/:visit_index` |
| followup_report | `/followup-report` |
| compare_families | `/compare` |
| account_home | `/account` |
| my_support | `/my-support` |
| change_password | `/change-password` |
| security_page | `/security` |
| admin_employees | `/admin/employees` |
| admin_audit | `/admin/audit` |
| import_data | `/import` |
| generate_fake_families | `/admin/generate` |
| export_excel | `/export/excel` |
| export_monthly_report | `/export/monthly-report` |
| backup | `/backup` |
| backups_list | `/backups` |
| restore_backup | `/backups/restore/:backup_name` |
| download_backup | `/backups/download/:backup_name` |
| health_alerts_view | `/health/alerts` |
| health_stats_view | `/health/stats` |
| health_caravans | `/health/caravans` |
| health_caravans_export | `/health/caravans/export` |
| health_referral | `/health/referral/:index` |
| health_gap | `/health/gap` |
| health_family_labs | `/health/labs/:index` |
| my_labs | `/my-labs` |
| download_lab | `/labs/:nid/:fname` |
| ppd_list | `/mental/ppd` |
| ppd_record | `/mental/ppd/:index` |
| api_stats | `/api/stats` |
| charts | `/charts` |
| analytics | `/analytics` |
| dashboard_stats | `/dashboard/stats` |
| notifications_page | `/notifications` |
| api_notifications | `/api/notifications` |
| map_view | `/map` |
| ml_prediction | `/ml` |
| api_analyze_document | `/api/analyze-document` |

## 6. Roles

Global guard already implemented (`src/middlewares/authMiddleware.js`): the
employee / psychologist / `user` allow-lists from app.py. Inside a handler,
admin-only routes start with:

```js
if (req.user.role !== 'admin') {
  return res.flashRedirect('/dashboard', 'هذه الصفحة للمدير فقط', 'danger');
}
```

## 7. Style

- Keep Arabic strings byte-identical to app.py.
- Keep the same validation messages and audit actions.
- Route handlers are `async`; `def` catches thrown errors and forwards them.
- Python `sorted(..., key=lambda r: ...)` -> `[...].sort(...)`.
- Python `datetime.now().strftime("%Y-%m-%d %H:%M:%S")` -> see
  `require('../services/auditService')` style formatting or write inline.
- Do not add npm dependencies without saying so; the available ones are
  express, ejs, multer, sharp, xlsx, uuid, bcryptjs, cookie-session,
  cookie-parser, cors, csv-parser, csv-stringify, dotenv, express-ejs-layouts.
