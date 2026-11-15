from flask import Flask, render_template, request, redirect, url_for, send_file, jsonify, flash, make_response
from flask_login import LoginManager, UserMixin, login_user, login_required, logout_user, current_user
import csv
import os
import pandas as pd
from datetime import datetime
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib import colors
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_RIGHT, TA_LEFT
import io
import shutil
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
import json
import base64
import re

import secrets
import hashlib
from functools import wraps
from datetime import timedelta
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
import smtplib
import egypt_family_generator
import health_rules
from email.mime.text import MIMEText

app = Flask(__name__)

@app.route('/brand-logo.jpeg')
def brand_logo():
    """Serve the project logo stored alongside the application folder."""
    logo_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "Gemini_Generated_Image_oc83fvoc83fvoc83.jpeg")
    return send_file(logo_path, mimetype='image/jpeg', max_age=86400)

def _load_secret_key():
    """Stable session key: env var SECRET_KEY, else a key file created once (so logins survive restarts)."""
    env_key = os.environ.get("SECRET_KEY")
    if env_key:
        return env_key
    key_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "secret.key")
    os.makedirs(os.path.dirname(key_path), exist_ok=True)
    if os.path.exists(key_path):
        with open(key_path, "r", encoding="utf-8") as f:
            existing = f.read().strip()
            if existing:
                return existing
    new_key = secrets.token_hex(32)
    with open(key_path, "w", encoding="utf-8") as f:
        f.write(new_key)
    return new_key

app.secret_key = _load_secret_key()
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(minutes=30)
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'

login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'login'

# ========================================
# نظام الأمان
# ========================================
failed_attempts = {}
blocked_ips = {}
security_log = []

def get_client_ip():
    return request.environ.get('HTTP_X_FORWARDED_FOR', request.remote_addr)

def is_blocked(ip):
    if ip in blocked_ips:
        if (datetime.now() - blocked_ips[ip]).seconds < 300:
            return True
        del blocked_ips[ip]
        failed_attempts.pop(ip, None)
    return False

def record_failed_attempt(ip, username):
    failed_attempts[ip] = failed_attempts.get(ip, 0) + 1
    log_security_event("محاولة دخول فاشلة", username, ip)
    if failed_attempts[ip] >= 3:
        blocked_ips[ip] = datetime.now()
        log_security_event("حجب IP بعد 3 محاولات فاشلة", username, ip)
        return True
    return False

def record_success(ip, username):
    failed_attempts.pop(ip, None)
    log_security_event("دخول ناجح", username, ip)

def log_security_event(event, username, ip):
    security_log.append({"time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "event": event, "username": username, "ip": ip})
    if len(security_log) > 500:
        security_log.pop(0)

def encrypt_sensitive(text):
    if not text: return text
    return "ENC:" + base64.b64encode(str(text).encode('utf-8')).decode('utf-8')

def decrypt_sensitive(text):
    if not text or not str(text).startswith("ENC:"): return text
    try: return base64.b64decode(str(text)[4:].encode()).decode('utf-8')
    except: return text

def is_strong_password(password):
    if len(password) < 8: return False, "كلمة السر لازم تكون 8 أحرف على الأقل"
    if not re.search(r'[A-Z]', password): return False, "لازم تحتوي على حرف كبير"
    if not re.search(r'[0-9]', password): return False, "لازم تحتوي على رقم"
    return True, "قوية"

def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not current_user.is_authenticated or current_user.role != 'admin':
            flash('مش مسموح لك بدخول هذه الصفحة', 'danger')
            return redirect(url_for('index'))
        return f(*args, **kwargs)
    return decorated

# ========================================
# التحكم في صلاحيات الوصول حسب الدور (Role-Based Access Control)
# ========================================
EMPLOYEE_ALLOWED_ENDPOINTS = {'welcome', 'index', 'families', 'employee_home', 'change_password', 'login', 'logout', 'static', 'register_birth', 'births_list', 'download_document', 'set_request_status', 'health_alerts_view', 'health_stats_view', 'health_caravans', 'health_caravans_export', 'health_referral', 'health_gap', 'health_family_labs', 'download_lab'}
USER_ALLOWED_ENDPOINTS = {'welcome', 'public_home', 'account_home', 'my_support', 'register_family', 'change_password', 'login', 'logout', 'signup', 'static', 'my_labs', 'download_lab'}
PSYCH_ALLOWED_ENDPOINTS = {'welcome', 'ppd_list', 'ppd_record', 'change_password', 'login', 'logout', 'static'}

@app.before_request
def enforce_role_access():
    if not current_user.is_authenticated:
        return
    endpoint = request.endpoint
    if endpoint is None:
        return
    role = getattr(current_user, 'role', None)
    if role == 'employee' and endpoint not in EMPLOYEE_ALLOWED_ENDPOINTS:
        flash('ليس لديك صلاحية للوصول لهذه الصفحة — يمكنك فقط إضافة/تعديل بيانات الأسر', 'warning')
        return redirect(url_for('employee_home'))
    if role == 'psychologist' and endpoint not in PSYCH_ALLOWED_ENDPOINTS:
        flash('هذه الصفحات خاصة بالأخصائي النفسي: قائمة أمهات ما بعد الولادة فقط', 'warning')
        return redirect(url_for('ppd_list'))
    if role == 'user' and endpoint not in USER_ALLOWED_ENDPOINTS:
        flash('ليس لديك صلاحية للوصول لهذه الصفحة', 'warning')
        return redirect(url_for('public_home'))

@app.context_processor
def inject_layout():
    role = getattr(current_user, 'role', None) if current_user.is_authenticated else None
    layout = {'employee': 'base_employee.html', 'psychologist': 'base_employee.html', 'user': 'base_public.html'}.get(role, 'base.html')
    return {"layout": layout}

filename = "families.csv"
notes_file = "family_notes.json"
visits_file = "family_visits.json"
backups_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backups")
# إنشاء مجلد النسخ الاحتياطية لو مش موجود
if not os.path.exists(backups_dir):
    os.makedirs(backups_dir)

# إنشاء ملف الزيارات لو مش موجود
if not os.path.exists(visits_file):
    with open(visits_file, 'w', encoding='utf-8') as f:
        json.dump({}, f, ensure_ascii=False, indent=2)

# ========================================
# أسماء أعمدة ملف الأسر (مصدر واحد يتشارك فيه كل الكود)
# ========================================
CSV_FIELDNAMES = [
    "اسم رب الأسرة",
    "الرقم القومي",
    "البريد الإلكتروني",
    "المحافظة",
    "عدد الأطفال",
    "عدد أفراد الأسرة",
    "الدخل الشهري",
    "معيل معاق",
    "أيتام",
    "مؤهل للدعم",
    "درجة الأولوية",
    "مستوى الأولوية",
    "العمر",
    "العنوان التفصيلي",
    "لديه تأمين صحي",
    "تصنيف الأسرة",
    "تعدد مواليد الأطفال الحاليين",
    "نوع الحمل الحالي",
    "عدد الأجنة",
    "عدد شهادات ميلاد الأطفال",
    "تاريخ الإضافة",
    "أضيف بواسطة",
    "حالة إشعار البريد",
    "حالة الطلب"
] + health_rules.HEALTH_FIELDS
REQUEST_STATUSES = ["قيد المراجعة", "مقبول", "مرفوض"]

# إنشاء الملف لو مش موجود (مع الحقول الجديدة للتقييم الاجتماعي)
if not os.path.exists(filename):
    with open(filename, mode="w", newline="", encoding="utf-8-sig") as file:
        writer = csv.writer(file)
        writer.writerow(CSV_FIELDNAMES)


def ensure_csv_schema():
    """
    لو ملف الأسر موجود من قبل بعمود أقدم (من غير 'البريد الإلكتروني')،
    الدالة دي بتظبطه تلقائيًا أول ما السيرفر يشتغل من غير ما تفقد أي بيانات موجودة.
    """
    with open(filename, mode="r", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        current_header = reader.fieldnames or []
        rows = list(reader)

    if current_header == CSV_FIELDNAMES:
        return  # الملف متظبط بالفعل، مفيش حاجة تتعمل

    with open(filename, mode="w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, fieldnames=CSV_FIELDNAMES)
        writer.writeheader()
        for row in rows:
            new_row = {key: row.get(key, "") for key in CSV_FIELDNAMES}
            if not new_row.get("حالة الطلب"):
                new_row["حالة الطلب"] = "قيد المراجعة"
            writer.writerow(new_row)


ensure_csv_schema()
health_rules.configure(os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "health_schedule.json"))
HEALTH_FACILITIES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "health_facilities.json")

# إنشاء ملف الملاحظات لو مش موجود
if not os.path.exists(notes_file):
    with open(notes_file, 'w', encoding='utf-8') as f:
        json.dump({}, f, ensure_ascii=False, indent=2)

# قاعدة بيانات المستخدمين
users_db = {
    'admin': {
        'password': generate_password_hash('admin123'),
        'role': 'admin',
        'name': 'المدير'
    },
    'employee': {
        'password': generate_password_hash('employee123'),
        'role': 'employee',
        'name': 'موظف',
        'governorate': ''
    },
    'psychologist': {
        'password': generate_password_hash('psych123'),
        'role': 'psychologist',
        'name': 'أخصائي نفسي',
        'governorate': ''
    },
    'user': {
        'password': generate_password_hash('user123'),
        'role': 'user',
        'name': 'مستخدم عادي'
    }
}

# ========================================
# حسابات المستخدمين اللي بتسجل نفسها (User role) - تخزين دائم في ملف JSON
# ========================================
user_accounts_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "user_accounts.json")

def load_user_accounts():
    if os.path.exists(user_accounts_file):
        with open(user_accounts_file, encoding="utf-8") as f:
            return json.load(f)
    return {}

def save_user_accounts(accounts):
    with open(user_accounts_file, "w", encoding="utf-8") as f:
        json.dump(accounts, f, ensure_ascii=False, indent=2)

# ========================================
# حسابات الموظفين (Employee role) - كل موظف ممكن يتخصص بمحافظة معيّنة
# محافظة فاضية "" = يشوف كل المحافظات (زي حساب الموظف الافتراضي)
# ========================================
employee_accounts_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "employee_accounts.json")

def load_employee_accounts():
    if os.path.exists(employee_accounts_file):
        with open(employee_accounts_file, encoding="utf-8") as f:
            return json.load(f)
    return {}

def save_employee_accounts(accounts):
    with open(employee_accounts_file, "w", encoding="utf-8") as f:
        json.dump(accounts, f, ensure_ascii=False, indent=2)

# دمج الحسابات المسجلة ذاتيًا وحسابات الموظفين في users_db عند بدء التشغيل
users_db.update(load_user_accounts())
users_db.update(load_employee_accounts())

class User(UserMixin):
    def __init__(self, username, role, name, governorate=''):
        self.id = username
        self.username = username
        self.role = role
        self.name = name
        self.governorate = governorate

@login_manager.user_loader
def load_user(user_id):
    if user_id in users_db:
        user_data = users_db[user_id]
        return User(user_id, user_data['role'], user_data['name'], user_data.get('governorate', ''))
    return None

# ========================================
# نظام حساب الأولوية المحسّن (Weighted Multi-Factor Scoring)
# ========================================
# ========================================
# الرقم القومي: تنظيف + تحقق من الصيغة + منع التكرار
# STRICT_NID_VALIDATION=0 بيقفل التحقق من الصيغة (لبيانات تجريبية بس). منع التكرار شغال دايمًا.
# ========================================
STRICT_NID_VALIDATION = os.environ.get("STRICT_NID_VALIDATION", "1") == "1"
DEFAULT_PASSWORDS = {"admin123", "employee123", "user123"}


def normalize_nid(value):
    s = str(value if value is not None else "").strip()
    s = s.translate(str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789"))
    s = re.sub(r"\s+", "", s)
    if re.fullmatch(r"\d+\.0", s):      # Excel بيحوّل الرقم أحيانًا لـ 29001011234567.0
        s = s[:-2]
    return s


def validate_national_id_format(nid):
    """بيتحقق من: 14 رقم، رقم القرن (2/3)، تاريخ ميلاد منطقي وغير مستقبلي. (مفيش تحقق من رقم المراجعة الأخير)."""
    if not re.fullmatch(r"\d{14}", nid):
        return False, "الرقم القومي لازم يكون 14 رقم بالظبط."
    if nid[0] not in ("2", "3"):
        return False, "الرقم القومي غير صحيح (الرقم الأول لازم يكون 2 أو 3)."
    century = 1900 if nid[0] == "2" else 2000
    try:
        birth = datetime(century + int(nid[1:3]), int(nid[3:5]), int(nid[5:7]))
    except ValueError:
        return False, "الرقم القومي غير صحيح (تاريخ الميلاد المضمّن فيه غير منطقي)."
    if birth > datetime.now():
        return False, "الرقم القومي غير صحيح (تاريخ الميلاد في المستقبل)."
    return True, ""


def existing_national_ids():
    with open(filename, mode="r", encoding="utf-8-sig") as f:
        return {normalize_nid(r.get("الرقم القومي", "")) for r in csv.DictReader(f)}


def check_national_id(national_id, editing_index=None):
    """يرجع None لو الرقم تمام، أو رسالة خطأ بالعربي. أثناء التعديل: لو الرقم ما اتغيّرش مفيش فحص."""
    with open(filename, mode="r", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    if editing_index is not None and 0 <= editing_index < len(rows):
        if normalize_nid(rows[editing_index].get("الرقم القومي", "")) == national_id:
            return None
    if STRICT_NID_VALIDATION:
        ok, msg = validate_national_id_format(national_id)
        if not ok:
            return msg
    for i, r in enumerate(rows):
        if i != editing_index and normalize_nid(r.get("الرقم القومي", "")) == national_id:
            return "الرقم القومي ده مسجّل بالفعل في النظام. لو محتاج تعدّل بياناتك كلّم فريق الدعم."
    return None


# ========================================
# سجل التدقيق (Audit Log): مين عمل إيه، على مين، وإمتى
# الرقم القومي بيتسجّل مخفي جزئيًا، والسجل محدود بآخر 5000 حدث
# ========================================
audit_log_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "audit_log.json")
AUDIT_MAX_ENTRIES = 5000
AUDIT_LABELS = {
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
}


def mask_nid(value):
    value = str(value or "")
    if value.isdigit() and len(value) >= 8:
        return value[:3] + "*" * (len(value) - 5) + value[-2:]
    return value


def audit(action, target="", details=""):
    try:
        entries = []
        if os.path.exists(audit_log_file):
            with open(audit_log_file, encoding="utf-8") as f:
                entries = json.load(f)
        entries.append({
            "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "user": current_user.username if current_user.is_authenticated else "anonymous",
            "role": current_user.role if current_user.is_authenticated else "",
            "action": action,
            "target": mask_nid(target),
            "details": details,
            "ip": request.remote_addr or "",
        })
        with open(audit_log_file, "w", encoding="utf-8") as f:
            json.dump(entries[-AUDIT_MAX_ENTRIES:], f, ensure_ascii=False, indent=1)
    except Exception:
        pass  # التسجيل لازم ما يوقّفش الطلب أبدًا


@app.route("/admin/audit")
@login_required
def admin_audit():
    if current_user.role != 'admin':
        flash('هذه الصفحة للمدير فقط', 'danger')
        return redirect(url_for('index'))
    entries = []
    if os.path.exists(audit_log_file):
        with open(audit_log_file, encoding="utf-8") as f:
            entries = json.load(f)
    entries = list(reversed(entries))[:300]
    return render_template("admin_audit.html", entries=entries, labels=AUDIT_LABELS)


def calculate_priority(children, income, has_disabled, has_orphans):
    """
    نظام نقاط مرجّح متعدد العوامل:
    - يحسب نسبة الدخل للفرد (الدخل ÷ حجم الأسرة المقدّر)
    - يأخذ في الاعتبار التراكم السلبي (كل عامل خطورة يرفع أثر العوامل الأخرى)
    - النقاط من 0 إلى 100 مع أوزان مختلفة لكل عامل
    """
    score = 0
    breakdown = {}

    # ── 1. عامل الأطفال (وزن: 25 نقطة) ──────────────────────────
    # نستخدم دالة لوغاريتمية بدل الجمع الخطي عشان الأسر الكبيرة جداً لا تأخذ امتيازاً غير واقعي
    try:
        children = int(children)
    except:
        children = 0

    if children == 0:
        children_score = 0
    elif children <= 2:
        children_score = 8
    elif children <= 4:
        children_score = 16
    elif children <= 6:
        children_score = 22
    else:
        children_score = 25  # سقف عند 7+ أطفال
    score += children_score
    breakdown['children'] = children_score

    # ── 2. عامل الدخل بالنسبة لحجم الأسرة (وزن: 35 نقطة) ────────
    # حجم الأسرة المقدّر = الأطفال + 2 (الوالدان)
    try:
        income = int(income)
    except:
        income = 0

    family_size = max(children + 2, 1)
    income_per_person = income / family_size

    if income_per_person == 0:
        income_score = 35         # دخل صفر = أقصى خطورة
    elif income_per_person < 300:
        income_score = 35
    elif income_per_person < 600:
        income_score = 28
    elif income_per_person < 1000:
        income_score = 20
    elif income_per_person < 1500:
        income_score = 10
    elif income_per_person < 2000:
        income_score = 5
    else:
        income_score = 0
    score += income_score
    breakdown['income'] = income_score

    # ── 3. عامل الإعاقة (وزن: 25 نقطة) ──────────────────────────
    disability_score = 25 if has_disabled == "نعم" else 0
    score += disability_score
    breakdown['disability'] = disability_score

    # ── 4. عامل الأيتام (وزن: 15 نقطة) ──────────────────────────
    orphan_score = 15 if has_orphans == "نعم" else 0
    score += orphan_score
    breakdown['orphan'] = orphan_score

    # ── 5. مضاعف التراكم السلبي ───────────────────────────────────
    # لو في أكثر من عاملَين خطورة مجتمعين، نرفع النقاط بنسبة 10%
    risk_factors = sum([
        1 if children > 4 else 0,
        1 if income_per_person < 600 else 0,
        1 if has_disabled == "نعم" else 0,
        1 if has_orphans == "نعم" else 0
    ])
    if risk_factors >= 3:
        bonus = round(score * 0.10)
        score = min(score + bonus, 100)
        breakdown['cumulative_bonus'] = bonus
    else:
        breakdown['cumulative_bonus'] = 0

    score = round(score)

    # ── تحديد مستوى الأولوية ──────────────────────────────────────
    if score >= 70:
        level = "أولوية قصوى 🔴"
        color = "danger"
    elif score >= 40:
        level = "أولوية متوسطة 🟡"
        color = "warning"
    else:
        level = "أولوية منخفضة 🟢"
        color = "success"

    return score, level, color, breakdown


def calculate_priority_simple(children, income, has_disabled, has_orphans):
    """واجهة مبسطة للاستخدام في الأماكن اللي مش محتاجة التفاصيل"""
    score, level, color, _ = calculate_priority(children, income, has_disabled, has_orphans)
    return score, level, color

# ========================================
# صفحات تسجيل الدخول
# ========================================

def redirect_for_role(role):
    if role == 'admin':
        return redirect(url_for('index'))
    elif role == 'employee':
        return redirect(url_for('employee_home'))
    elif role == 'psychologist':
        return redirect(url_for('ppd_list'))
    else:
        return redirect(url_for('public_home'))

@app.route("/")
def welcome():
    if current_user.is_authenticated:
        return redirect_for_role(current_user.role)
    news = fetch_health_news(limit=3)
    return render_template("welcome.html", health_news=news)


@app.route("/login", methods=["GET", "POST"])
def login():
    if current_user.is_authenticated:
        return redirect_for_role(current_user.role)
    
    error = None
    if request.method == "POST":
        username = request.form.get("username")
        password = request.form.get("password")
        
        ip = get_client_ip()
        if is_blocked(ip):
            error = "تم حجب هذا الجهاز مؤقتاً بسبب محاولات دخول متعددة. انتظر 5 دقائق."
        elif username in users_db and check_password_hash(users_db[username]['password'], password):
            user = User(username, users_db[username]['role'], users_db[username]['name'], users_db[username].get('governorate', ''))
            login_user(user, remember=False)
            record_success(ip, username)
            audit("login_success", "", username)
            if password in DEFAULT_PASSWORDS:
                flash('⚠️ بتستخدم كلمة مرور افتراضية معروفة للجميع. غيّرها فورًا من "تغيير كلمة المرور".', 'warning')
            flash(f'مرحباً {user.name}!', 'success')
            return redirect_for_role(user.role)
        else:
            blocked = record_failed_attempt(ip, username)
            remaining = max(0, 3 - failed_attempts.get(ip, 0))
            if blocked:
                error = "تم حجب هذا الجهاز مؤقتاً. انتظر 5 دقائق."
            else:
                error = f"اسم المستخدم أو كلمة السر غلط. متبقي {remaining} محاولة."

    return render_template("login.html", error=error)

@app.route("/signup", methods=["GET", "POST"])
def signup():
    if current_user.is_authenticated:
        return redirect_for_role(current_user.role)

    error = None
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        name = request.form.get("name", "").strip()

        if not username or not password or not name:
            error = "من فضلك املأ كل الحقول"
        elif username in users_db:
            error = "اسم المستخدم ده موجود بالفعل، اختار اسم تاني"
        elif len(password) < 6:
            error = "كلمة المرور لازم تكون 6 حروف/أرقام على الأقل"
        else:
            accounts = load_user_accounts()
            accounts[username] = {
                'password': generate_password_hash(password),
                'role': 'user',
                'name': name
            }
            save_user_accounts(accounts)
            users_db[username] = accounts[username]

            user = User(username, 'user', name)
            login_user(user, remember=False)
            flash(f'تم إنشاء حسابك بنجاح، أهلاً {name}!', 'success')
            return redirect(url_for('account_home'))

    return render_template("signup.html", error=error)

# ========================================
# جلب أخبار وزارة الصحة والسكان أول بأول (Google News RSS)
# مع كاش داخلي (20 دقيقة) وfallback لو حصل خطأ في الاتصال
# ========================================
_news_cache = {"items": [], "fetched_at": None}
NEWS_CACHE_MINUTES = 0  # 0 = يجيب أخبار جديدة فعليًا مع كل تحميل للصفحة (بدون كاش)

def fetch_health_news(limit=6):
    global _news_cache
    now = datetime.now()
    if _news_cache["fetched_at"] and (now - _news_cache["fetched_at"]).total_seconds() < NEWS_CACHE_MINUTES * 60:
        return _news_cache["items"]

    fallback = [
        {"title": "حملة التطعيم الموسمية ضد الإنفلونزا", "date": "2026-07-20", "link": "#",
         "desc": "تعلن وزارة الصحة عن انطلاق حملة التطعيم المجاني ضد الإنفلونزا الموسمية بجميع الوحدات الصحية، مع الأولوية لكبار السن وذوي الأمراض المزمنة."},
        {"title": "توسيع مظلة 'دعم صحي' للأسر الأولى بالرعاية", "date": "2026-07-10", "link": "#",
         "desc": "استمرار العمل على ربط قواعد بيانات الدعم الاجتماعي بالوحدات الصحية لتسهيل حصول الأسر المستحقة على الخدمات الطبية والدوائية."},
        {"title": "قوافل طبية مجانية بالمحافظات", "date": "2026-06-28", "link": "#",
         "desc": "تنظيم قوافل طبية مجانية بعدد من المحافظات لتقديم الكشف والعلاج للأسر الأولى بالرعاية بالتنسيق مع الجمعيات الأهلية."},
    ]

    try:
        query = urllib.parse.quote("وزارة الصحة والسكان مصر")
        url = f"https://news.google.com/rss/search?q={query}&hl=ar&gl=EG&ceid=EG:ar"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=6) as resp:
            data = resp.read()

        root = ET.fromstring(data)
        items = []
        for item in root.findall(".//item")[:limit]:
            title = (item.findtext("title") or "").strip()
            link = (item.findtext("link") or "#").strip()
            pub_date = item.findtext("pubDate") or ""
            desc_raw = item.findtext("description") or ""
            desc = re.sub("<[^<]+?>", "", desc_raw).strip()

            try:
                dt = datetime.strptime(pub_date, "%a, %d %b %Y %H:%M:%S %Z")
                date_str = dt.strftime("%Y-%m-%d")
            except Exception:
                date_str = pub_date[:16] if pub_date else ""

            if title:
                items.append({"title": title, "link": link, "date": date_str, "desc": desc})

        if items:
            _news_cache = {"items": items, "fetched_at": now}
            return items
        return fallback
    except Exception:
        # مفيش اتصال بالإنترنت أو مصدر الأخبار مش متاح دلوقتي → نرجع آخر نسخة اتخزنت، أو fallback ثابت
        return _news_cache["items"] or fallback


@app.route("/logout")
@login_required
def logout():
    logout_user()
    flash('تم تسجيل الخروج بنجاح', 'info')
    return redirect(url_for('login'))

# ========================================
# الصفحة العامة (User) - إعلانات وزارة الصحة + إحصائيات عامة
# ========================================
@app.route("/home")
@login_required
def public_home():
    capmas_path = os.path.join(os.path.dirname(__file__), "data", "capmas_governorates.json")
    with open(capmas_path, encoding="utf-8") as f:
        capmas = json.load(f)
    national_indicators = capmas.get("national_indicators", {})
    with open(filename, mode="r", encoding="utf-8-sig") as file:
        total_families = sum(1 for _ in csv.DictReader(file))
    health_news = fetch_health_news()
    return render_template("public_home.html", ni=national_indicators, total_families=total_families, health_news=health_news)

# ========================================
# الصفحة الرئيسية للموظف (Employee) - إضافة/تعديل بس
# ========================================
# ========================================
# إعدادات بوابة الـ SMS (لازم تتظبط ببيانات حقيقية عشان الإرسال يشتغل فعليًا)
# البوابات المدعومة: "sms_misr" (بوابة مصرية، موصى بيها) أو "twilio"
# ========================================
SMS_PROVIDER = os.environ.get("SMS_PROVIDER", "sms_misr")
SITE_BASE_URL = os.environ.get("SITE_BASE_URL", "http://127.0.0.1:5000")

TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN", "")
TWILIO_FROM_NUMBER = os.environ.get("TWILIO_FROM_NUMBER", "")

SMS_MISR_USERNAME = os.environ.get("SMS_MISR_USERNAME", "")
SMS_MISR_PASSWORD = os.environ.get("SMS_MISR_PASSWORD", "")
SMS_MISR_SENDER = os.environ.get("SMS_MISR_SENDER", "")
# القيمة دي بتختلف حسب حسابك (تجربة/مباشر) — راجعها في صفحة الـ API جوه لوحة تحكم SMS Misr بعد التسجيل
SMS_MISR_ENVIRONMENT = os.environ.get("SMS_MISR_ENVIRONMENT", "2")


# ========================================
# إعدادات إرسال البريد الإلكتروني (مجاني عن طريق Gmail أو أي حساب SMTP)
# ========================================
SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USERNAME = os.environ.get("SMTP_USERNAME", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
SMTP_FROM_NAME = os.environ.get("SMTP_FROM_NAME", "بوابة دعم الأسر")


def send_support_email(to_email, family_name):
    """
    بيبعت إيميل حقيقي للأسرة يبلغها بأهليتها للدعم.
    يرجع (success: bool, info: str).
    محتاج بيانات حساب SMTP في متغيرات البيئة:
        SMTP_USERNAME, SMTP_PASSWORD (لجيميل: App Password مش الباسورد العادي)
    """
    if not (SMTP_USERNAME and SMTP_PASSWORD):
        return False, "إرسال الإيميل غير مُفعّل (محتاج SMTP_USERNAME و SMTP_PASSWORD في متغيرات البيئة). الرسالة اتجهزت ومتبعتتش."

    if not to_email:
        return False, "لا يوجد بريد إلكتروني مسجّل لهذه الأسرة."

    login_link = f"{SITE_BASE_URL}/login"
    subject = "تهانينا! أسرتكم مؤهلة للحصول على الدعم"
    body = (
        f"السلام عليكم أسرة {family_name}،\n\n"
        f"يسعدنا إبلاغكم بأن بيانات أسرتكم تمت مراجعتها وثبتت أهليتكم للحصول على الدعم "
        f"من وزارة الصحة والسكان.\n\n"
        f"لتقديم طلبكم ومتابعة استلام الدعم، سجّلوا الدخول لحسابكم من الرابط التالي:\n"
        f"{login_link}\n\n"
        f"مع تحيات وزارة الصحة والسكان\nبوابة دعم الأسر المجتمعية"
    )

    try:
        msg = MIMEText(body, "plain", "utf-8")
        msg["Subject"] = subject
        msg["From"] = f"{SMTP_FROM_NAME} <{SMTP_USERNAME}>"
        msg["To"] = to_email

        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10) as server:
            server.starttls()
            server.login(SMTP_USERNAME, SMTP_PASSWORD)
            server.sendmail(SMTP_USERNAME, [to_email], msg.as_string())

        return True, "تم إرسال الإيميل بنجاح"
    except Exception as e:
        return False, f"فشل إرسال الإيميل: {e}"


def _send_via_sms_misr(phone, message_body):
    if not (SMS_MISR_USERNAME and SMS_MISR_PASSWORD and SMS_MISR_SENDER):
        return False, "بوابة SMS Misr غير مُفعّلة (محتاج SMS_MISR_USERNAME / PASSWORD / SENDER في متغيرات البيئة). الرسالة اتجهزت ومتبعتتش."
    try:
        mobile = phone.strip().replace("+", "").replace(" ", "").replace("-", "")
        if mobile.startswith("0"):
            mobile = "2" + mobile  # تحويل 010xxxxxxxx لصيغة 2010xxxxxxxx اللي بتطلبها البوابة

        data = urllib.parse.urlencode({
            "environment": SMS_MISR_ENVIRONMENT,
            "username": SMS_MISR_USERNAME,
            "password": SMS_MISR_PASSWORD,
            "sender": SMS_MISR_SENDER,
            "mobile": mobile,
            "language": "1",  # 1 = عربي حسب توثيق البوابة
            "message": message_body,
        }).encode()

        req = urllib.request.Request("https://smsmisr.com/api/SMS/", data=data)
        with urllib.request.urlopen(req, timeout=8) as resp:
            result = resp.read().decode("utf-8", errors="ignore")
        return True, f"تم الإرسال عبر SMS Misr (رد البوابة: {result[:200]})"
    except Exception as e:
        return False, f"فشل الإرسال عبر SMS Misr: {e}"


def _send_via_twilio(phone, message_body):
    if not (TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER):
        return False, "بوابة Twilio غير مُفعّلة (محتاج بيانات Twilio في متغيرات البيئة). الرسالة اتجهزت ومتبعتتش."
    try:
        from twilio.rest import Client
        client = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
        client.messages.create(body=message_body, from_=TWILIO_FROM_NUMBER, to=phone)
        return True, "تم إرسال الرسالة بنجاح عبر Twilio"
    except ImportError:
        return False, "مكتبة twilio غير مثبتة — شغّل: pip install twilio"
    except Exception as e:
        return False, f"فشل الإرسال عبر Twilio: {e}"


def send_support_sms(phone, family_name):
    """
    بيبعت رسالة SMS حقيقية للأسرة تبلغهم بأهليتهم لدعم التوائم.
    يرجع (success: bool, info: str).
    البوابة بتتحدد من متغير SMS_PROVIDER ("sms_misr" أو "twilio").
    """
    signup_link = f"{SITE_BASE_URL}/signup"
    message_body = (
        f"تهانينا لأسرة {family_name} بالمولودين الجدد \U0001F389\n"
        f"نفيدكم بأن أسرتكم مؤهلة للحصول على دعم خاص بالتوائم من وزارة الصحة والسكان.\n"
        f"لتسجيل بيانات أسرتكم ومتابعة الطلب من هنا:\n{signup_link}\n"
        f"وزارة الصحة والسكان"
    )

    if SMS_PROVIDER == "sms_misr":
        return _send_via_sms_misr(phone, message_body)
    elif SMS_PROVIDER == "twilio":
        return _send_via_twilio(phone, message_body)
    else:
        return False, f"بوابة SMS غير معروفة: {SMS_PROVIDER}"


# ========================================
# تسجيل مواليد المستشفيات + كشف التوائم تلقائيًا
# ========================================
births_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "births.json")
if not os.path.exists(births_file):
    with open(births_file, "w", encoding="utf-8") as f:
        json.dump([], f, ensure_ascii=False, indent=2)


def read_births():
    with open(births_file, "r", encoding="utf-8") as f:
        return json.load(f)


def write_births(data):
    with open(births_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# ========================================
# رفع مستندات الأسرة (بطاقة الرقم القومي / شهادة الميلاد)
# ========================================
UPLOAD_FOLDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads", "documents")
ALLOWED_DOC_EXTENSIONS = {"png", "jpg", "jpeg", "pdf"}
MAX_DOC_SIZE_MB = 5
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

documents_index_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "family_documents.json")
if not os.path.exists(documents_index_file):
    with open(documents_index_file, "w", encoding="utf-8") as f:
        json.dump({}, f, ensure_ascii=False, indent=2)


def read_documents_index():
    with open(documents_index_file, "r", encoding="utf-8") as f:
        return json.load(f)


def write_documents_index(data):
    with open(documents_index_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _allowed_doc_file(fname):
    return "." in fname and fname.rsplit(".", 1)[1].lower() in ALLOWED_DOC_EXTENSIONS


def save_family_document(national_id, file_storage, doc_type_label):
    """
    بيحفظ ملف مستند لأسرة معينة (بطاقة رقم قومي / شهادة ميلاد) على القرص،
    ويسجّله في family_documents.json. بيرجع (success: bool, info: str).
    """
    if not file_storage or file_storage.filename == "":
        return True, ""  # الرفع اختياري، مفيش ملف يبقى عادي

    if not _allowed_doc_file(file_storage.filename):
        return False, "امتداد الملف غير مسموح (المسموح: jpg, jpeg, png, pdf فقط)"

    file_storage.seek(0, os.SEEK_END)
    size_mb = file_storage.tell() / (1024 * 1024)
    file_storage.seek(0)
    if size_mb > MAX_DOC_SIZE_MB:
        return False, f"حجم الملف أكبر من {MAX_DOC_SIZE_MB} ميجا"

    safe_national_id = secure_filename(national_id) or "unknown"
    family_folder = os.path.join(UPLOAD_FOLDER, safe_national_id)
    os.makedirs(family_folder, exist_ok=True)

    ext = file_storage.filename.rsplit(".", 1)[1].lower()
    stored_name = f"{secure_filename(doc_type_label)}_{datetime.now().strftime('%Y%m%d%H%M%S')}.{ext}"
    file_storage.save(os.path.join(family_folder, stored_name))

    docs_index = read_documents_index()
    docs_index.setdefault(safe_national_id, []).append({
        "type": doc_type_label,
        "filename": stored_name,
        "uploaded_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
    })
    write_documents_index(docs_index)
    return True, "تم رفع الملف بنجاح"


@app.route("/documents/<national_id>/<path:doc_filename>")
@login_required
def download_document(national_id, doc_filename):
    if current_user.role not in ('admin', 'employee'):
        flash('ليس لديك صلاحية الوصول لهذا المستند', 'danger')
        return redirect(url_for('welcome'))
    safe_national_id = secure_filename(national_id) or "unknown"
    from flask import send_from_directory
    audit("document_view", national_id, doc_filename)
    return send_from_directory(os.path.join(UPLOAD_FOLDER, safe_national_id), doc_filename)


@app.route("/register-birth", methods=["GET", "POST"])
@login_required
def register_birth():
    result_message = None
    if request.method == "POST":
        mother_name = request.form.get("mother_name", "").strip()
        mother_national_id = request.form.get("mother_national_id", "").strip()
        phone = request.form.get("phone", "").strip()
        governorate = request.form.get("governorate", "").strip()
        hospital = request.form.get("hospital", "").strip()
        birth_date = request.form.get("birth_date", "").strip()
        baby_name = request.form.get("baby_name", "").strip()
        gender = request.form.get("gender", "").strip()

        births = read_births()
        new_id = (max([b["id"] for b in births]) + 1) if births else 1
        record = {
            "id": new_id,
            "mother_name": mother_name,
            "mother_national_id": mother_national_id,
            "phone": phone,
            "governorate": governorate,
            "hospital": hospital,
            "birth_date": birth_date,
            "baby_name": baby_name,
            "gender": gender,
            "registered_by": current_user.username,
            "registered_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
            "sms_status": "غير مطلوب (مولود مفرد)",
        }
        births.append(record)

        # كشف التوأم: نفس الرقم القومي للأم + نفس تاريخ الميلاد = نفس واقعة الولادة
        siblings = [
            b for b in births
            if b["mother_national_id"] == mother_national_id and b["birth_date"] == birth_date
        ]

        if len(siblings) >= 2:
            already_sent = any(s["sms_status"] == "تم الإرسال بنجاح" for s in siblings)
            if not already_sent:
                success, info = send_support_sms(phone, mother_name)
                new_status = "تم الإرسال بنجاح" if success else f"لم يتم الإرسال: {info}"
                for b in births:
                    if b["mother_national_id"] == mother_national_id and b["birth_date"] == birth_date:
                        b["sms_status"] = new_status
                result_message = (
                    f"تم رصد توأم (عدد المواليد: {len(siblings)}). {info}"
                )
            else:
                record["sms_status"] = "جزء من حالة توأم سبق إرسال رسالتها"
                result_message = "تم رصد توأم — الرسالة كانت اتبعتت قبل كده لنفس الأسرة."
        else:
            result_message = "تم تسجيل المولود بنجاح (مولود مفرد، لا يستحق دعم التوائم)."

        write_births(births)

    return render_template("register_birth.html", result_message=result_message)


@app.route("/births")
@login_required
def births_list():
    births = read_births()
    births.sort(key=lambda b: b["id"], reverse=True)
    return render_template("births_list.html", births=births)


@app.route("/employee")
@login_required
def employee_home():
    return render_template("employee_home.html")


@app.route("/admin/employees", methods=["GET", "POST"])
@login_required
def admin_employees():
    if current_user.role != 'admin':
        flash('هذه الصفحة للمدير فقط', 'danger')
        return redirect(url_for('index'))

    message = None
    error = None

    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        emp_name = request.form.get("name", "").strip()
        governorate = request.form.get("governorate", "").strip()
        new_role = request.form.get("role", "employee")
        if new_role not in ("employee", "psychologist"):
            new_role = "employee"

        if not username or not password or not emp_name:
            error = "من فضلك املأ اسم المستخدم وكلمة المرور والاسم"
        elif username in users_db:
            error = "اسم المستخدم ده مستخدم بالفعل"
        elif len(password) < 6:
            error = "كلمة المرور لازم تكون 6 أحرف على الأقل"
        else:
            accounts = load_employee_accounts()
            accounts[username] = {
                "password": generate_password_hash(password),
                "role": new_role,
                "name": emp_name,
                "governorate": governorate,
            }
            save_employee_accounts(accounts)
            users_db[username] = accounts[username]
            audit("employee_create", "", username)
            message = f"✅ تم إنشاء حساب الموظف '{emp_name}' بنجاح" + (f" (مخصص لمحافظة {governorate})" if governorate else " (يشوف كل المحافظات)")

    employees = load_employee_accounts()
    return render_template("admin_employees.html", employees=employees, message=message, error=error)

# ========================================
# تسجيل أسرة جديدة من واجهة المستخدم العامة (User) - إضافة فقط
# ========================================
@app.route("/account")
@login_required
def account_home():
    with open(filename, mode="r", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        my_requests = [row for row in reader if row.get("أضيف بواسطة") == current_user.username]
    labs_idx = _load_json(LABS_INDEX, {})
    labs_missing = any(not labs_idx.get(r.get("الرقم القومي", "")) for r in my_requests)
    return render_template("account_home.html", requests_count=len(my_requests),
                           labs_missing=labs_missing, has_requests=bool(my_requests))

@app.route("/my-support")
@login_required
def my_support():
    with open(filename, mode="r", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        my_requests = [row for row in reader if row.get("أضيف بواسطة") == current_user.username]
    return render_template("my_support.html", requests=my_requests)

@app.route("/register-family", methods=["GET", "POST"])
@login_required
def register_family():
    message = ""
    if request.method == "POST":
        name = request.form["name"]
        national_id = normalize_nid(request.form["national_id"])
        email = request.form.get("email", "").strip()
        nid_error = check_national_id(national_id)
        if nid_error:
            return render_template("register_family.html", message="⚠️ " + nid_error)
        governorate = request.form["governorate"]
        children = int(request.form["children"])
        income = request.form["income"]
        has_disabled = request.form["has_disabled"]
        has_orphans = request.form["has_orphans"]

        eligible = "نعم" if children > 2 else "لا"
        points, priority_level, priority_color, score_breakdown = calculate_priority(children, income, has_disabled, has_orphans)
        current_date = datetime.now().strftime("%Y-%m-%d %H:%M")

        # الجانب الصحي (اختياري) — لو الحقول مش مبعوتة بتفضل فاضية
        health_row = {}
        if request.form.get("pregnant"):
            pregnant = request.form.get("pregnant", "لا")
            try:
                under5 = max(0, min(int(request.form.get("under5", "0") or 0), children))
            except ValueError:
                under5 = 0
            def _clean_date(v):
                try:
                    return datetime.strptime((v or "").strip(), "%Y-%m-%d").strftime("%Y-%m-%d")
                except ValueError:
                    return ""
            try:
                treatment_cost = max(0, int(float(request.form.get("treatment_cost", "0") or 0)))
            except ValueError:
                treatment_cost = 0
            pregnancy_followup = request.form.get("pregnancy_followup", "لا") if pregnant == "نعم" else "لا ينطبق"
            health_row = {
                "حامل": pregnant,
                "متابعة حمل": pregnancy_followup,
                "أطفال تحت 5": str(under5),
                "تطعيمات مكتملة": request.form.get("vaccines_complete", "نعم") if under5 else "لا ينطبق",
                "مرض مزمن": request.form.get("chronic", "لا"),
                "سوء تغذية": request.form.get("malnutrition", "لا") if children else "لا ينطبق",
                "تكلفة العلاج الشهرية": str(treatment_cost),
                "آخر متابعة حمل": _clean_date(request.form.get("last_pregnancy_visit")) if pregnancy_followup == "نعم" else "",
                "آخر تطعيم": _clean_date(request.form.get("last_vaccine")) if under5 else "",
                "تاريخ آخر ولادة": _clean_date(request.form.get("last_delivery")) or "لا ينطبق",
            }
            health_row["درجة الأولوية الصحية"], health_row["مستوى الأولوية الصحية"] = health_rules.health_score({**health_row, "الدخل الشهري": income})

        email_status = "غير مؤهل، لا يستحق إشعار"
        if eligible == "نعم":
            if email:
                success, info = send_support_email(email, name)
                email_status = "تم الإرسال بنجاح" if success else f"لم يتم الإرسال: {info}"
            else:
                email_status = "لا يوجد بريد إلكتروني"

        with open(filename, mode="a", newline="", encoding="utf-8-sig") as file:
            writer = csv.DictWriter(file, fieldnames=CSV_FIELDNAMES)
            writer.writerow({
                "اسم رب الأسرة": name,
                "الرقم القومي": national_id,
                "البريد الإلكتروني": email,
                "المحافظة": governorate,
                "عدد الأطفال": children,
                "الدخل الشهري": income,
                "معيل معاق": has_disabled,
                "أيتام": has_orphans,
                "مؤهل للدعم": eligible,
                "درجة الأولوية": points,
                "مستوى الأولوية": priority_level,
                "تاريخ الإضافة": current_date,
                "أضيف بواسطة": current_user.username,
                "حالة إشعار البريد": email_status,
                "حالة الطلب": "قيد المراجعة",
                **health_row,
            })
        audit("family_add_citizen", national_id)

        message = "✅ تم إرسال بيانات الأسرة بنجاح، وسيتم مراجعتها من قِبل فريق الدعم."

        id_doc = request.files.get("id_document")
        birth_cert_doc = request.files.get("birth_certificate")
        doc_errors = []

        ok, info = save_family_document(national_id, id_doc, "بطاقة الرقم القومي")
        if not ok:
            doc_errors.append(f"بطاقة الرقم القومي: {info}")

        ok, info = save_family_document(national_id, birth_cert_doc, "شهادة الميلاد")
        if not ok:
            doc_errors.append(f"شهادة الميلاد: {info}")

        if doc_errors:
            message += " ⚠️ لكن حصلت مشكلة في رفع بعض المستندات: " + " | ".join(doc_errors)

    return render_template("register_family.html", message=message)

# ========================================
# الصفحة الرئيسية (مع نظام التقييم)
# ========================================

@app.route("/dashboard", methods=["GET", "POST"])
@login_required
def index():
    message = ""
    edit_mode = False
    edit_index = None
    
    if request.args.get("edit"):
        edit_index = int(request.args.get("edit"))
        with open(filename, mode="r", encoding="utf-8-sig") as file:
            reader = csv.DictReader(file)
            families = list(reader)
            if 0 <= edit_index < len(families):
                family = families[edit_index]
                edit_mode = True
    
    if request.method == "POST":
        name = request.form["name"]
        national_id = normalize_nid(request.form["national_id"])
        _edit_raw = request.form.get("edit_index")
        nid_error = check_national_id(national_id, int(_edit_raw) if _edit_raw is not None else None)
        governorate = request.form["governorate"]
        children = int(request.form["children"])
        income = request.form["income"]
        has_disabled = request.form["has_disabled"]
        has_orphans = request.form["has_orphans"]
        
        # حساب التأهيل للدعم
        eligible = "نعم" if children > 2 else "لا"
        
        # حساب درجة الأولوية
        points, priority_level, priority_color, score_breakdown = calculate_priority(children, income, has_disabled, has_orphans)
        
        current_date = datetime.now().strftime("%Y-%m-%d %H:%M")

        if nid_error:
            message = "❌ " + nid_error
        elif request.form.get("edit_index") is not None:
            edit_index = int(request.form.get("edit_index"))
            
            with open(filename, mode="r", encoding="utf-8-sig") as file:
                reader = csv.DictReader(file)
                families = list(reader)

            existing_email = families[edit_index].get("البريد الإلكتروني", "")
            existing_email_status = families[edit_index].get("حالة إشعار البريد", "")

            email_status = existing_email_status
            if eligible == "نعم" and existing_email_status != "تم الإرسال بنجاح":
                if existing_email:
                    success, info = send_support_email(existing_email, name)
                    email_status = "تم الإرسال بنجاح" if success else f"لم يتم الإرسال: {info}"
                else:
                    email_status = "لا يوجد بريد إلكتروني"

            families[edit_index] = {
                **families[edit_index],
                "اسم رب الأسرة": name,
                "الرقم القومي": national_id,
                "البريد الإلكتروني": existing_email,
                "المحافظة": governorate,
                "عدد الأطفال": children,
                "الدخل الشهري": income,
                "معيل معاق": has_disabled,
                "أيتام": has_orphans,
                "مؤهل للدعم": eligible,
                "درجة الأولوية": points,
                "مستوى الأولوية": priority_level,
                "تاريخ الإضافة": families[edit_index].get('تاريخ الإضافة', current_date),
                "أضيف بواسطة": families[edit_index].get('أضيف بواسطة', current_user.username),
                "حالة إشعار البريد": email_status,
                "حالة الطلب": families[edit_index].get("حالة الطلب", "قيد المراجعة") or "قيد المراجعة",
            }
            
            with open(filename, mode="w", newline="", encoding="utf-8-sig") as file:
                writer = csv.DictWriter(file, fieldnames=CSV_FIELDNAMES)
                writer.writeheader()
                writer.writerows(families)
            
            audit("family_edit", national_id)
            message = "✅ تم تعديل بيانات الأسرة بنجاح"
        else:
            with open(filename, mode="a", newline="", encoding="utf-8-sig") as file:
                writer = csv.DictWriter(file, fieldnames=CSV_FIELDNAMES)
                writer.writerow({
                    "اسم رب الأسرة": name,
                    "الرقم القومي": national_id,
                    "البريد الإلكتروني": "",
                    "المحافظة": governorate,
                    "عدد الأطفال": children,
                    "الدخل الشهري": income,
                    "معيل معاق": has_disabled,
                    "أيتام": has_orphans,
                    "مؤهل للدعم": eligible,
                    "درجة الأولوية": points,
                    "مستوى الأولوية": priority_level,
                    "تاريخ الإضافة": current_date,
                    "أضيف بواسطة": current_user.username,
                    "حالة إشعار البريد": "لا يوجد بريد إلكتروني",
                    "حالة الطلب": "قيد المراجعة",
                })

            audit("family_add", national_id)
            message = f"✅ الأسرة {'مؤهلة' if eligible == 'نعم' else 'غير مؤهلة'} للدعم | {priority_level}"

    family_data = None
    if edit_mode:
        with open(filename, mode="r", encoding="utf-8-sig") as file:
            reader = csv.DictReader(file)
            families = list(reader)
            family_data = families[edit_index]

    # بيانات رسم بياني: عدد الأسر المسجّلة شهريًا لآخر 6 شهور
    with open(filename, mode="r", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        all_families_for_chart = list(reader)

    from collections import OrderedDict

    today = datetime.now().replace(day=1)
    month_labels = []
    month_keys = []
    for i in range(5, -1, -1):
        year = today.year
        month = today.month - i
        while month <= 0:
            month += 12
            year -= 1
        month_keys.append(f"{year:04d}-{month:02d}")
        month_labels.append(f"{month:02d}/{year}")

    monthly_counts = OrderedDict((k, 0) for k in month_keys)
    for f in all_families_for_chart:
        date_str = f.get("تاريخ الإضافة", "")
        key = date_str[:7]  # "YYYY-MM"
        if key in monthly_counts:
            monthly_counts[key] += 1

    chart_labels = month_labels
    chart_values = list(monthly_counts.values())

    return render_template(
        "index.html", message=message, edit_mode=edit_mode, edit_index=edit_index,
        family=family_data, chart_labels=chart_labels, chart_values=chart_values
    )

# ========================================
# صفحة عرض الأسر (مع فلترة الأولوية)
# ========================================

@app.route("/families")
@login_required
def families():
    all_families = []
    search_query = request.args.get("search", "").strip()
    filter_priority = request.args.get("priority", "").strip()

    with open(filename, mode="r", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        for row in reader:
            match = True
            
            if search_query and not (
                search_query.lower() in row.get('اسم رب الأسرة', '').lower() or
                search_query in row.get('الرقم القومي', '') or
                search_query.lower() in row.get('المحافظة', '').lower()
            ):
                match = False
            
            if filter_priority and row.get('مستوى الأولوية', '') != filter_priority:
                match = False

            # لو موظف مخصص لمحافظة معيّنة، يشوف بس أسر المحافظة دي
            if (current_user.role in ('employee', 'psychologist') and getattr(current_user, 'governorate', '')
                    and row.get('المحافظة', '') != current_user.governorate):
                match = False

            if match:
                all_families.append(row)

    eligible_count = sum(1 for f in all_families if f.get('مؤهل للدعم', '') == 'نعم')
    not_eligible_count = len(all_families) - eligible_count
    
    # إحصائيات الأولوية
    priority_stats = {
        "أولوية قصوى 🔴": 0,
        "أولوية متوسطة 🟡": 0,
        "أولوية منخفضة 🟢": 0
    }
    priority_levels = sorted({f.get('مستوى الأولوية', '').strip() for f in all_families if f.get('مستوى الأولوية', '').strip()})
    for f in all_families:
        level = f.get('مستوى الأولوية', '').strip()
        # نصنّف لأغراض العرض فقط؛ قيمة مستوى الأولوية الأصلية تظل محفوظة دون تعديل.
        if 'قصوى' in level or 'حرج' in level:
            priority_stats["أولوية قصوى 🔴"] += 1
        elif 'متوسط' in level or 'عالي' in level:
            priority_stats["أولوية متوسطة 🟡"] += 1
        elif level:
            priority_stats["أولوية منخفضة 🟢"] += 1

    return render_template(
        "families.html",
        families=all_families,
        eligible_count=eligible_count,
        not_eligible_count=not_eligible_count,
        priority_stats=priority_stats,
        search_query=search_query,
        filter_priority=filter_priority,
        priority_levels=priority_levels,
        current_user=current_user,
        documents_index=read_documents_index()
    )

# ========================================
# حذف أسرة
# ========================================

@app.route("/delete/<int:index>")
@login_required
def delete(index):
    if current_user.role != 'admin':
        flash('ليس لديك صلاحية الحذف — هذه الصلاحية للمدير فقط', 'danger')
        return redirect(url_for('families'))
    
    with open(filename, mode="r", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        families = list(reader)
    
    if 0 <= index < len(families):
        audit("family_delete", families[index].get("الرقم القومي", ""))
        families.pop(index)
    
    with open(filename, mode="w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, fieldnames=CSV_FIELDNAMES)
        writer.writeheader()
        writer.writerows(families)
    
    flash('تم حذف الأسرة بنجاح', 'success')
    return redirect(url_for('families'))


@app.route("/families/<int:index>/set-status", methods=["POST"])
@login_required
def set_request_status(index):
    if current_user.role not in ('admin', 'employee'):
        flash('ليس لديك صلاحية تغيير حالة الطلب', 'danger')
        return redirect(url_for('families'))

    new_status = request.form.get("status", "").strip()
    if new_status not in REQUEST_STATUSES:
        flash('حالة غير صحيحة', 'danger')
        return redirect(url_for('families'))

    with open(filename, mode="r", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        families = list(reader)

    if 0 <= index < len(families):
        families[index]["حالة الطلب"] = new_status
        with open(filename, mode="w", newline="", encoding="utf-8-sig") as file:
            writer = csv.DictWriter(file, fieldnames=CSV_FIELDNAMES)
            writer.writeheader()
            writer.writerows(families)
        audit("status_change", families[index].get("الرقم القومي", ""), new_status)
        flash(f'✅ تم تحديث حالة الطلب إلى: {new_status}', 'success')
    else:
        flash('الأسرة غير موجودة', 'danger')

    return redirect(url_for('families'))

# ========================================
# تصدير لـ Excel
# ========================================

@app.route("/export/excel")
@login_required
def export_excel():
    audit("export_excel")
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment
    
    families = []
    with open(filename, mode="r", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        for row in reader:
            families.append(row)
    
    wb = Workbook()
    ws = wb.active
    ws.title = "الأسر المسجلة"
    
    headers = ["اسم رب الأسرة", "الرقم القومي", "البريد الإلكتروني", "المحافظة", "عدد الأطفال", "الدخل الشهري",
               "معيل معاق", "أيتام", "مؤهل للدعم", "درجة الأولوية", "مستوى الأولوية",
               "تاريخ الإضافة", "أضيف بواسطة", "حالة إشعار البريد", "حالة الطلب"]
    ws.append(headers)
    
    header_fill = PatternFill(start_color="4361EE", end_color="4361EE", fill_type="solid")
    header_font = Font(color="FFFFFF", bold=True, size=12)
    
    for col in range(1, len(headers) + 1):
        cell = ws.cell(row=1, column=col)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="center", vertical="center")
    
    for family in families:
        ws.append([
            family.get('اسم رب الأسرة', ''),
            family.get('الرقم القومي', ''),
            family.get('البريد الإلكتروني', ''),
            family.get('المحافظة', ''),
            int(family.get('عدد الأطفال', 0)),
            family.get('الدخل الشهري', ''),
            family.get('معيل معاق', ''),
            family.get('أيتام', ''),
            family.get('مؤهل للدعم', ''),
            int(family.get('درجة الأولوية', 0)),
            family.get('مستوى الأولوية', ''),
            family.get('تاريخ الإضافة', ''),
            family.get('أضيف بواسطة', ''),
            family.get('حالة إشعار البريد', ''),
            family.get('حالة الطلب', '')
        ])
    
    column_widths = [25, 15, 22, 15, 12, 12, 12, 10, 12, 12, 20, 20, 15, 22, 15]
    for i, width in enumerate(column_widths, start=1):
        ws.column_dimensions[chr(64 + i)].width = width
    
    ws.append([])
    ws.append(["الإحصائيات"])
    ws.cell(row=ws.max_row, column=1).font = Font(bold=True, size=14)
    
    eligible_count = sum(1 for f in families if f.get('مؤهل للدعم', '') == 'نعم')
    not_eligible_count = len(families) - eligible_count
    
    ws.append(["إجمالي الأسر", len(families)])
    ws.append(["مؤهلة للدعم", eligible_count])
    ws.append(["غير مؤهلة", not_eligible_count])
    
    output = io.BytesIO()
    wb.save(output)
    output.seek(0)
    
    return send_file(
        output,
        mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        as_attachment=True,
        download_name=f'الأسر_المسجلة_{datetime.now().strftime("%Y%m%d_%H%M%S")}.xlsx'
    )


@app.route("/export/monthly-report")
@login_required
def export_monthly_report():
    audit("export_monthly_report")
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment

    current_month_key = datetime.now().strftime("%Y-%m")

    with open(filename, mode="r", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        all_families = list(reader)

    month_families = [f for f in all_families if f.get("تاريخ الإضافة", "")[:7] == current_month_key]

    wb = Workbook()
    ws = wb.active
    ws.title = "تقرير الشهر الحالي"

    headers = ["اسم رب الأسرة", "الرقم القومي", "البريد الإلكتروني", "المحافظة", "عدد الأطفال",
               "الدخل الشهري", "مؤهل للدعم", "مستوى الأولوية", "حالة الطلب", "تاريخ الإضافة", "أضيف بواسطة"]
    ws.append([f"تقرير الأسر المسجّلة خلال شهر {current_month_key}"])
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(headers))
    ws.cell(row=1, column=1).font = Font(bold=True, size=14)
    ws.cell(row=1, column=1).alignment = Alignment(horizontal="center")
    ws.append([])
    ws.append(headers)

    header_row = 3
    header_fill = PatternFill(start_color="4361EE", end_color="4361EE", fill_type="solid")
    header_font = Font(color="FFFFFF", bold=True, size=12)
    for col in range(1, len(headers) + 1):
        cell = ws.cell(row=header_row, column=col)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="center", vertical="center")

    for f in month_families:
        ws.append([
            f.get('اسم رب الأسرة', ''),
            f.get('الرقم القومي', ''),
            f.get('البريد الإلكتروني', ''),
            f.get('المحافظة', ''),
            int(f.get('عدد الأطفال', 0) or 0),
            f.get('الدخل الشهري', ''),
            f.get('مؤهل للدعم', ''),
            f.get('مستوى الأولوية', ''),
            f.get('حالة الطلب', ''),
            f.get('تاريخ الإضافة', ''),
            f.get('أضيف بواسطة', ''),
        ])

    column_widths = [25, 15, 22, 15, 12, 12, 12, 20, 15, 18, 15]
    for i, width in enumerate(column_widths, start=1):
        ws.column_dimensions[chr(64 + i)].width = width

    eligible_count = sum(1 for f in month_families if f.get('مؤهل للدعم', '') == 'نعم')
    ws.append([])
    ws.append(["إجمالي الطلبات هذا الشهر", len(month_families)])
    ws.append(["مؤهلة للدعم", eligible_count])
    ws.append(["غير مؤهلة", len(month_families) - eligible_count])

    output = io.BytesIO()
    wb.save(output)
    output.seek(0)

    return send_file(
        output,
        mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        as_attachment=True,
        download_name=f'تقرير_شهر_{current_month_key}.xlsx'
    )

# ========================================
# استيراد من ملفات
# ========================================

@app.route("/import", methods=["GET", "POST"])
@login_required
def import_data():
    if current_user.role != 'admin':
        flash('ليس لديك صلاحية الاستيراد', 'danger')
        return redirect(url_for('families'))

    message = ""
    if request.method == "POST":
        if 'file' not in request.files:
            message = "لم يتم اختيار ملف"
        else:
            file = request.files['file']
            if not file.filename:
                message = "لم يتم اختيار ملف"
            else:
                try:
                    if file.filename.lower().endswith('.csv'):
                        df = pd.read_csv(file, encoding='utf-8-sig')
                    elif file.filename.lower().endswith(('.xlsx', '.xls')):
                        df = pd.read_excel(file)
                    else:
                        return render_template("import.html", message="نوع الملف غير مدعوم. اختر CSV أو Excel")

                    dataset_columns = {'اسم رب الأسرة', 'الرقم القومي', 'المحافظة', 'عدد الأطفال',
                                       'الدخل الشهري', 'معيل معاق', 'أيتام', 'عدد أفراد الأسرة',
                                       'درجة الأولوية', 'مستوى الأولوية', 'مؤهل للدعم', 'تاريخ التسجيل', 'الحالة'}
                    is_project_dataset = dataset_columns.issubset(set(df.columns))
                    required_columns = ['اسم رب الأسرة', 'الرقم القومي', 'المحافظة', 'عدد الأطفال',
                                        'الدخل الشهري', 'معيل معاق', 'أيتام']
                    if not is_project_dataset and not all(col in df.columns for col in required_columns):
                        message = f"الملف يجب أن يحتوي على الأعمدة المطلوبة: {', '.join(required_columns)}"
                        return render_template("import.html", message=message)

                    current_date = datetime.now().strftime("%Y-%m-%d %H:%M")
                    imported_count = skipped_invalid = skipped_duplicate = 0
                    existing_nids = existing_national_ids()
                    with open(filename, mode="a", newline="", encoding="utf-8-sig") as f:
                        writer = csv.DictWriter(f, fieldnames=CSV_FIELDNAMES)
                        for _, row in df.iterrows():
                            val = lambda key, default="": row[key] if key in df.columns and pd.notna(row[key]) else default
                            name = str(val('اسم رب الأسرة'))
                            national_id = normalize_nid(val('الرقم القومي'))
                            governorate = str(val('المحافظة'))
                            children = int(val('عدد الأطفال', 0) or 0)
                            family_size = int(val('عدد أفراد الأسرة')) if 'عدد أفراد الأسرة' in df.columns and pd.notna(val('عدد أفراد الأسرة')) else ""
                            income = str(val('الدخل الشهري', '0'))
                            has_disabled = str(val('معيل معاق', 'لا'))
                            has_orphans = str(val('أيتام', 'لا'))
                            if is_project_dataset:
                                eligible = str(val('مؤهل للدعم'))
                                points = val('درجة الأولوية')
                                priority_level = str(val('مستوى الأولوية'))
                                added_date = str(val('تاريخ التسجيل', current_date))
                                request_status = str(val('الحالة', 'قيد المراجعة'))
                            else:
                                if STRICT_NID_VALIDATION and not validate_national_id_format(national_id)[0]:
                                    skipped_invalid += 1
                                    continue
                                eligible = "نعم" if children > 2 else "لا"
                                points, priority_level, _ = calculate_priority_simple(children, income, has_disabled, has_orphans)
                                added_date, request_status = current_date, "قيد المراجعة"

                            if national_id in existing_nids:
                                skipped_duplicate += 1
                                continue
                            existing_nids.add(national_id)
                            writer.writerow({
                                "اسم رب الأسرة": name, "الرقم القومي": national_id,
                                "البريد الإلكتروني": str(val('البريد الإلكتروني')),
                                "المحافظة": governorate, "عدد الأطفال": children,
                                "عدد أفراد الأسرة": family_size, "الدخل الشهري": income,
                                "معيل معاق": has_disabled, "أيتام": has_orphans,
                                "مؤهل للدعم": eligible, "درجة الأولوية": points,
                                "مستوى الأولوية": priority_level, "تاريخ الإضافة": added_date,
                                "أضيف بواسطة": "استيراد Dataset" if is_project_dataset else current_user.username,
                                "حالة إشعار البريد": "بيانات تجريبية - لم يتم الإرسال" if is_project_dataset else "لم يتم الإرسال بعد (استيراد جماعي)",
                                "حالة الطلب": request_status
                            })
                            imported_count += 1
                    audit("import", "", f"{imported_count} rows")
                    message = f"✅ تم استيراد {imported_count} أسرة بنجاح"
                    if skipped_invalid or skipped_duplicate:
                        message += f" (تم تخطّي {skipped_invalid} صف برقم قومي غير صالح و{skipped_duplicate} صف مكرر)"
                except Exception as e:
                    message = f"❌ حدث خطأ أثناء الاستيراد: {str(e)}"
    return render_template("import.html", message=message)

# ========================================
# توليد أسر مصرية وهمية (بيانات تجريبية)
# ========================================
@app.route("/admin/generate", methods=["GET", "POST"])
@login_required
def generate_fake_families():
    if current_user.role != 'admin':
        flash('هذه الصفحة للمدير فقط', 'danger')
        return redirect(url_for('index'))

    if request.method == "POST":
        action = request.form.get("action", "generate")
        if action == "clear":
            with open(filename, mode="r", encoding="utf-8-sig") as f:
                rows = list(csv.DictReader(f))
            kept = [r for r in rows if r.get("أضيف بواسطة") != egypt_family_generator.GENERATED_BY]
            removed = len(rows) - len(kept)
            if removed:
                shutil.copy(filename, os.path.join(backups_dir, f"before_clear_generated_{datetime.now():%Y%m%d_%H%M%S}.csv"))
                with open(filename, mode="w", newline="", encoding="utf-8-sig") as f:
                    w = csv.DictWriter(f, fieldnames=CSV_FIELDNAMES)
                    w.writeheader()
                    for r in kept:
                        w.writerow({k: r.get(k, "") for k in CSV_FIELDNAMES})
            audit("clear_generated", "", f"{removed} rows")
            flash(f"تم حذف {removed} أسرة مولّدة (اتعمل نسخة احتياطية قبل الحذف).", "success" if removed else "info")
            return redirect(url_for("generate_fake_families"))

        if action == "backfill_health":
            synthetic = (egypt_family_generator.GENERATED_BY, "استيراد Dataset")
            with open(filename, mode="r", encoding="utf-8-sig") as f:
                rows = list(csv.DictReader(f))
            filled = 0
            for i, r in enumerate(rows):
                if r.get("أضيف بواسطة") in synthetic and health_rules.needs_backfill(r):
                    health_rules.backfill_row(r, seed=i)
                    filled += 1
            if filled:
                shutil.copy(filename, os.path.join(backups_dir, f"before_backfill_health_{datetime.now():%Y%m%d_%H%M%S}.csv"))
                with open(filename, mode="w", newline="", encoding="utf-8-sig") as f:
                    w = csv.DictWriter(f, fieldnames=CSV_FIELDNAMES)
                    w.writeheader()
                    for r in rows:
                        w.writerow({k: r.get(k, "") for k in CSV_FIELDNAMES})
            audit("backfill_health", "", f"{filled} rows")
            flash(f"تمت تعبئة بيانات صحية تجريبية لـ {filled} أسرة (الأسر الحقيقية لم تتأثر).", "success" if filled else "info")
            return redirect(url_for("generate_fake_families"))

        try:
            count = max(1, min(int(request.form.get("count", 100)), 5000))
            seed_raw = request.form.get("seed", "").strip()
            seed = int(seed_raw) if seed_raw else None
            gov = request.form.get("governorate", "").strip() or None
            names = request.form.get("names", "auto")
            if names not in ("auto", "faker", "builtin"):
                names = "auto"
            new_rows = egypt_family_generator.generate_families(
                count, seed=seed, governorate=gov, existing_nids=existing_national_ids(),
                priority_fn=calculate_priority_simple, names=names)
            with open(filename, mode="a", newline="", encoding="utf-8-sig") as f:
                w = csv.DictWriter(f, fieldnames=CSV_FIELDNAMES)
                for r in new_rows:
                    w.writerow({k: r.get(k, "") for k in CSV_FIELDNAMES})
            audit("generate_families", "", f"{len(new_rows)} rows, seed={seed}, gov={gov or 'all'}")
            flash(f"✅ تم توليد {len(new_rows)} أسرة وهمية وإضافتها للنظام.", "success")
        except Exception as e:
            flash(f"❌ تعذّر التوليد: {e}", "danger")
        return redirect(url_for("generate_fake_families"))

    with open(filename, mode="r", encoding="utf-8-sig") as f:
        _rows = list(csv.DictReader(f))
    generated_count = sum(1 for r in _rows if r.get("أضيف بواسطة") == egypt_family_generator.GENERATED_BY)
    missing_health_count = sum(1 for r in _rows if r.get("أضيف بواسطة") in (egypt_family_generator.GENERATED_BY, "استيراد Dataset")
                               and health_rules.needs_backfill(r))
    try:
        import faker  # noqa: F401
        faker_ok = True
    except Exception:
        faker_ok = False
    return render_template("generate.html", governorates=list(egypt_family_generator.GOVERNORATES),
                           generated_count=generated_count, faker_ok=faker_ok,
                           missing_health_count=missing_health_count)


# ========================================
# الطبقة الصحية: تنبيهات المتابعة + إحصائيات + ترتيب إجمالي
# ========================================
def _visible_family_rows():
    """[(index, row)] — الموظف المخصص لمحافظة يشوف أسر محافظته بس."""
    out = []
    with open(filename, mode="r", encoding="utf-8-sig") as f:
        for i, row in enumerate(csv.DictReader(f)):
            if (current_user.role == 'employee' and getattr(current_user, 'governorate', '')
                    and row.get('المحافظة', '') != current_user.governorate):
                continue
            out.append((i, row))
    return out


def _staff_only():
    if current_user.role not in ('admin', 'employee'):
        flash('هذه الصفحة للموظفين والمدير فقط', 'danger')
        return redirect(url_for('index'))
    return None


@app.route("/health/alerts")
@login_required
def health_alerts_view():
    denied = _staff_only()
    if denied:
        return denied
    alert_type = request.args.get("type", "").strip()
    gov = request.args.get("gov", "").strip()
    search = request.args.get("search", "").strip().lower()
    try:
        page = max(1, int(request.args.get("page", 1)))
    except ValueError:
        page = 1
    per_page = 50

    visible = _visible_family_rows()
    screened = {n for n, d in _load_json(MENTAL_FILE, {}).items() if d.get("records")}
    labs_idx = _load_json(LABS_INDEX, {})
    type_counts = {k: 0 for k in health_rules.ALERT_TYPES}
    governorates = sorted({r.get("المحافظة", "") for _, r in visible if r.get("المحافظة")})
    items = []
    for idx, row in visible:
        alerts = _alerts_for(row, screened)
        if not alerts:
            continue
        if gov and row.get("المحافظة") != gov:
            continue
        if search and search not in row.get("اسم رب الأسرة", "").lower() and search not in row.get("الرقم القومي", ""):
            continue
        for a in alerts:
            type_counts[a] += 1
        if alert_type and alert_type not in alerts:
            continue
        items.append({"idx": idx, "row": row, "alerts": alerts, "total": health_rules.total_score(row),
                      "labs": len(labs_idx.get(row.get("الرقم القومي", ""), []))})
    items.sort(key=lambda x: x["total"], reverse=True)

    total_count = len(items)
    pages = max(1, -(-total_count // per_page))
    page = min(page, pages)
    return render_template(
        "health_alerts.html", items=items[(page - 1) * per_page: page * per_page],
        total_count=total_count, page=page, pages=pages, per_page=per_page,
        type_counts=type_counts, alert_types=health_rules.ALERT_TYPES, alert_badge=health_rules.ALERT_BADGE,
        selected_type=alert_type, selected_gov=gov, search=request.args.get("search", ""),
        governorates=governorates, offset=(page - 1) * per_page)


@app.route("/health/stats")
@login_required
def health_stats_view():
    denied = _staff_only()
    if denied:
        return denied
    visible = _visible_family_rows()
    tot = {"families": 0, "with_data": 0, "pregnant": 0, "preg_unmon": 0, "under5_fam": 0,
           "vacc_total": 0, "vacc_ok": 0, "malnut": 0, "chronic": 0, "need": 0, "burden": 0, "overdue": 0}
    by_gov = {}
    for _, r in visible:
        tot["families"] += 1
        if not health_rules.has_health_data(r):
            continue
        g = r.get("المحافظة", "غير معروف")
        d = by_gov.setdefault(g, {"n": 0, "preg": 0, "preg_unmon": 0, "vacc_total": 0, "vacc_ok": 0, "malnut": 0, "chronic": 0, "need": 0, "burden": 0, "overdue": 0})
        al = health_rules.health_alerts(r)
        tot["with_data"] += 1; d["n"] += 1
        if r.get("حامل") == "نعم":
            tot["pregnant"] += 1; d["preg"] += 1
        if "pregnant" in al:
            tot["preg_unmon"] += 1; d["preg_unmon"] += 1
        if r.get("تطعيمات مكتملة") in ("نعم", "لا"):
            tot["under5_fam"] += 1; tot["vacc_total"] += 1; d["vacc_total"] += 1
            if r.get("تطعيمات مكتملة") == "نعم":
                tot["vacc_ok"] += 1; d["vacc_ok"] += 1
        if "malnutrition" in al:
            tot["malnut"] += 1; d["malnut"] += 1
        if "chronic" in al:
            tot["chronic"] += 1; d["chronic"] += 1
        if "burden" in al:
            tot["burden"] += 1; d["burden"] += 1
        if "overdue" in al:
            tot["overdue"] += 1; d["overdue"] += 1
        if health_rules.needs_followup(r):
            tot["need"] += 1; d["need"] += 1
    pct = lambda a, b: round(a / b * 100, 1) if b else None
    rows = []
    for g, d in by_gov.items():
        rows.append({"gov": g, **d, "vacc_pct": pct(d["vacc_ok"], d["vacc_total"]), "need_pct": pct(d["need"], d["n"]) or 0})
    rows.sort(key=lambda x: x["need_pct"], reverse=True)
    return render_template("health_stats.html", tot=tot, rows=rows, cfg=health_rules.CONFIG,
                           vacc_pct=pct(tot["vacc_ok"], tot["vacc_total"]), need_pct=pct(tot["need"], tot["with_data"]),
                           chart_data=json.dumps({"labels": [r["gov"] for r in rows], "values": [r["need_pct"] for r in rows]}, ensure_ascii=False))


def _alerts_for(row, screened=None):
    """تنبيهات الأسرة. لو screened اتمرّر، بيتضاف تنبيه 'مطلوب مسح اكتئاب ما بعد الولادة' (بدون أي نتائج)."""
    alerts = health_rules.health_alerts(row)
    if screened is not None and health_rules.is_postpartum(row) and row.get("الرقم القومي") not in screened:
        alerts.append("ppd")
    return alerts


def _load_facilities():
    try:
        with open(HEALTH_FACILITIES_PATH, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {}
    units = data.get("units") or {}
    return {"source": data.get("source", ""), "year": data.get("year", ""),
            "units": {g: units.get(g) for g in egypt_family_generator.GOVERNORATES}}


def _caravan_selection(gov, capacity):
    """أسر المحافظة المحتاجة متابعة، مرتبة بالدرجة الإجمالية، لحد سعة القافلة."""
    chosen = []
    for idx, row in _visible_family_rows():
        if row.get("المحافظة") == gov and health_rules.needs_followup(row):
            chosen.append({"idx": idx, "row": row, "alerts": _alerts_for(row), "total": health_rules.total_score(row)})
    chosen.sort(key=lambda x: x["total"], reverse=True)
    return chosen, chosen[:capacity]


@app.route("/health/caravans")
@login_required
def health_caravans():
    denied = _staff_only()
    if denied:
        return denied
    by = request.args.get("by", "count")
    try:
        capacity = max(10, min(int(request.args.get("capacity", 150)), 2000))
    except ValueError:
        capacity = 150
    per_gov = {}
    for _, r in _visible_family_rows():
        if not health_rules.has_health_data(r):
            continue
        g = r.get("المحافظة", "غير معروف")
        d = per_gov.setdefault(g, {"gov": g, "n": 0, "need": 0})
        d["n"] += 1
        if health_rules.needs_followup(r):
            d["need"] += 1
    govs = list(per_gov.values())
    for d in govs:
        d["pct"] = round(d["need"] / d["n"] * 100, 1) if d["n"] else 0
    govs.sort(key=(lambda d: d["pct"]) if by == "pct" else (lambda d: d["need"]), reverse=True)
    gov = request.args.get("gov", "").strip() or (govs[0]["gov"] if govs else "")
    all_need, selected = _caravan_selection(gov, capacity) if gov else ([], [])
    return render_template("health_caravans.html", govs=govs, gov=gov, by=by, capacity=capacity,
                           selected=selected, need_total=len(all_need),
                           alert_types=health_rules.ALERT_TYPES, alert_badge=health_rules.ALERT_BADGE)


@app.route("/health/caravans/export")
@login_required
def health_caravans_export():
    denied = _staff_only()
    if denied:
        return denied
    gov = request.args.get("gov", "").strip()
    try:
        capacity = max(10, min(int(request.args.get("capacity", 150)), 2000))
    except ValueError:
        capacity = 150
    _, selected = _caravan_selection(gov, capacity)
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["الترتيب", "اسم رب الأسرة", "الرقم القومي", "المحافظة", "التنبيهات", "الدرجة الاجتماعية", "الدرجة الصحية", "الدرجة الإجمالية"])
    for n, it in enumerate(selected, 1):
        r = it["row"]
        w.writerow([n, r.get("اسم رب الأسرة"), r.get("الرقم القومي"), r.get("المحافظة"),
                    " | ".join(health_rules.ALERT_TYPES[a] for a in it["alerts"]),
                    r.get("درجة الأولوية"), r.get("درجة الأولوية الصحية"), it["total"]])
    audit("health_caravan_export", gov, f"{len(selected)} families")
    resp = make_response("\ufeff" + out.getvalue())
    resp.headers["Content-Type"] = "text/csv; charset=utf-8"
    resp.headers["Content-Disposition"] = "attachment; filename=caravan_list.csv"
    return resp


@app.route("/health/referral/<int:index>")
@login_required
def health_referral(index):
    denied = _staff_only()
    if denied:
        return denied
    rows = dict(_visible_family_rows())
    row = rows.get(index)
    if row is None:
        flash("الأسرة غير موجودة أو خارج نطاق صلاحيتك", "danger")
        return redirect(url_for("health_alerts_view"))
    audit("health_referral", row.get("الرقم القومي", ""))
    b = health_rules.burden_pct(row)
    return render_template("health_referral.html", family=row, index=index,
                           alerts=_alerts_for(row), alert_types=health_rules.ALERT_TYPES,
                           burden=("—" if b is None else ("لا يوجد دخل" if b == float("inf") else f"{b}%")),
                           total=health_rules.total_score(row), today=datetime.now().strftime("%Y-%m-%d"),
                           issuer=getattr(current_user, "name", "") or current_user.username,
                           ref=f"REF-{index + 1}-{datetime.now():%Y%m%d}")


@app.route("/health/gap", methods=["GET", "POST"])
@login_required
def health_gap():
    denied = _staff_only()
    if denied:
        return denied
    if request.method == "POST":
        if current_user.role != "admin":
            flash("تعديل بيانات الوحدات الصحية للمدير فقط", "danger")
            return redirect(url_for("health_gap"))
        units = {}
        for g in egypt_family_generator.GOVERNORATES:
            raw = request.form.get("units_" + g, "").strip()
            try:
                units[g] = max(0, int(raw)) if raw != "" else None
            except ValueError:
                units[g] = None
        with open(HEALTH_FACILITIES_PATH, "w", encoding="utf-8") as f:
            json.dump({"source": request.form.get("source", "").strip(), "year": request.form.get("year", "").strip(),
                       "units": units}, f, ensure_ascii=False, indent=2)
        audit("health_facilities_update", "", f"{sum(1 for v in units.values() if v is not None)} governorates")
        flash("تم حفظ بيانات الوحدات الصحية", "success")
        return redirect(url_for("health_gap"))

    fac = _load_facilities()
    need = {}
    for _, r in _visible_family_rows():
        if health_rules.has_health_data(r) and health_rules.needs_followup(r):
            need[r.get("المحافظة")] = need.get(r.get("المحافظة"), 0) + 1
    rows = []
    for g, u in fac["units"].items():
        n = need.get(g, 0)
        rows.append({"gov": g, "units": u, "need": n, "per_unit": round(n / u, 2) if u else None})
    rows.sort(key=lambda r: (r["per_unit"] is None, -(r["per_unit"] or 0)))
    return render_template("health_gap.html", rows=rows, source=fac["source"], year=fac["year"],
                           filled=sum(1 for r in rows if r["units"] is not None), is_admin=current_user.role == "admin")


# ========================================
# رفع صور تحاليل الفيتامينات والمعادن (نسخة احتياطية فقط — مفيش تفسير للنتائج)
# ========================================
import uuid

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LABS_FOLDER = os.path.join(BASE_DIR, "uploads", "labs")
LABS_INDEX = os.path.join(BASE_DIR, "family_labs.json")
MENTAL_FILE = os.path.join(BASE_DIR, "family_mental_health.json")
os.makedirs(LABS_FOLDER, exist_ok=True)
LAB_CATEGORIES = ["فيتامينات", "معادن", "تحاليل أخرى"]
LAB_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}
LAB_MAX_MB = 8
LAB_MAX_PER_FAMILY = 20


def _load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _my_family_rows():
    with open(filename, mode="r", encoding="utf-8-sig") as f:
        return [r for r in csv.DictReader(f) if r.get("أضيف بواسطة") == current_user.username]


def _save_lab_image(nid, file_storage, category, note):
    """يتحقق إن الملف صورة فعلًا، يشيل بيانات EXIF (زي الموقع)، يصغّره، ويخزنه باسم عشوائي. بيرجع (ok, msg)."""
    from PIL import Image, ImageOps
    fname = file_storage.filename or ""
    if "." not in fname or fname.rsplit(".", 1)[1].lower() not in LAB_EXTENSIONS:
        return False, f"{fname}: امتداد غير مسموح (المسموح: jpg, png, webp)"
    file_storage.seek(0, os.SEEK_END)
    size_mb = file_storage.tell() / (1024 * 1024)
    file_storage.seek(0)
    if size_mb > LAB_MAX_MB:
        return False, f"{fname}: الحجم أكبر من {LAB_MAX_MB} ميجا"
    try:
        img = Image.open(file_storage)
        img.verify()
        file_storage.seek(0)
        img = ImageOps.exif_transpose(Image.open(file_storage)).convert("RGB")
        img.thumbnail((2200, 2200))
    except Exception:
        return False, f"{fname}: مش صورة صالحة"
    folder = os.path.join(LABS_FOLDER, secure_filename(nid) or "unknown")
    os.makedirs(folder, exist_ok=True)
    stored = f"{uuid.uuid4().hex}.jpg"
    img.save(os.path.join(folder, stored), "JPEG", quality=85)
    idx = _load_json(LABS_INDEX, {})
    idx.setdefault(nid, []).append({
        "id": uuid.uuid4().hex[:12], "filename": stored, "category": category,
        "note": (note or "")[:200], "uploaded_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "uploaded_by": current_user.username,
    })
    _save_json(LABS_INDEX, idx)
    return True, ""


@app.route("/my-labs", methods=["GET", "POST"])
@login_required
def my_labs():
    families = _my_family_rows()
    my_nids = {f.get("الرقم القومي") for f in families}
    if request.method == "POST":
        nid = request.form.get("nid", "")
        if nid not in my_nids:
            flash("الأسرة دي مش مسجلة باسمك", "danger")
            return redirect(url_for("my_labs"))
        idx = _load_json(LABS_INDEX, {})
        if request.form.get("action") == "delete":
            lab_id = request.form.get("lab_id", "")
            entries = idx.get(nid, [])
            target = next((e for e in entries if e["id"] == lab_id), None)
            if target:
                try:
                    os.remove(os.path.join(LABS_FOLDER, secure_filename(nid), target["filename"]))
                except OSError:
                    pass
                idx[nid] = [e for e in entries if e["id"] != lab_id]
                _save_json(LABS_INDEX, idx)
                audit("lab_delete", nid, lab_id)
                flash("تم حذف الصورة", "info")
            return redirect(url_for("my_labs"))

        category = request.form.get("category", "")
        if category not in LAB_CATEGORIES:
            category = "تحاليل أخرى"
        files = [f for f in request.files.getlist("lab_images") if f and f.filename]
        if not request.form.get("consent"):
            flash("لازم توافق على حفظ الصور عشان نكمل", "warning")
        elif not files:
            flash("اختار صورة واحدة على الأقل", "warning")
        elif len(files) > 5:
            flash("الحد الأقصى 5 صور في المرة الواحدة", "warning")
        elif len(idx.get(nid, [])) + len(files) > LAB_MAX_PER_FAMILY:
            flash(f"الحد الأقصى {LAB_MAX_PER_FAMILY} صورة لكل أسرة", "warning")
        else:
            ok_count, errors = 0, []
            for f in files:
                ok, msg = _save_lab_image(nid, f, category, request.form.get("note", ""))
                ok_count += ok
                if not ok:
                    errors.append(msg)
            if ok_count:
                audit("lab_upload", nid, f"{ok_count} files, {category}")
                flash(f"✅ تم حفظ {ok_count} صورة", "success")
            for e in errors:
                flash(e, "danger")
        return redirect(url_for("my_labs"))

    idx = _load_json(LABS_INDEX, {})
    return render_template("my_labs.html", families=families, labs=idx, categories=LAB_CATEGORIES,
                           max_mb=LAB_MAX_MB, max_per=LAB_MAX_PER_FAMILY)


@app.route("/labs/<nid>/<fname>")
@login_required
def download_lab(nid, fname):
    from flask import send_from_directory
    entries = _load_json(LABS_INDEX, {}).get(nid, [])
    if not any(e["filename"] == fname for e in entries):
        return ("غير موجود", 404)
    if current_user.role == "user" and nid not in {f.get("الرقم القومي") for f in _my_family_rows()}:
        return ("غير مسموح", 403)
    if current_user.role not in ("admin", "employee", "user"):
        return ("غير مسموح", 403)
    audit("lab_view", nid, fname)
    return send_from_directory(os.path.join(LABS_FOLDER, secure_filename(nid)), fname)


@app.route("/health/labs/<int:index>")
@login_required
def health_family_labs(index):
    denied = _staff_only()
    if denied:
        return denied
    row = dict(_visible_family_rows()).get(index)
    if row is None:
        flash("الأسرة غير موجودة أو خارج نطاق صلاحيتك", "danger")
        return redirect(url_for("health_alerts_view"))
    labs = _load_json(LABS_INDEX, {}).get(row.get("الرقم القومي", ""), [])
    return render_template("health_labs.html", family=row, labs=labs, nid=row.get("الرقم القومي", ""))


# ========================================
# الأخصائي النفسي: اكتئاب ما بعد الولادة (ترشيح للتقييم — مش تشخيص)
# بيانات حساسة: متخزنة في ملف منفصل ومحدودة لدور الأخصائي النفسي والمدير
# ========================================
def _psych_only():
    if current_user.role not in ("admin", "psychologist"):
        flash("هذه الصفحة للأخصائي النفسي والمدير فقط", "danger")
        return redirect(url_for("index"))
    return None


@app.route("/mental/ppd")
@login_required
def ppd_list():
    denied = _psych_only()
    if denied:
        return denied
    show = request.args.get("show", "all")
    try:
        page = max(1, int(request.args.get("page", 1)))
    except ValueError:
        page = 1
    mh = _load_json(MENTAL_FILE, {})
    items = []
    for idx, row in _visible_family_rows():
        if not health_rules.is_postpartum(row):
            continue
        recs = mh.get(row.get("الرقم القومي", ""), {}).get("records", [])
        last = recs[-1] if recs else None
        risk = health_rules.ppd_risk(last)
        days = health_rules._days_since(row.get("تاريخ آخر ولادة"))
        items.append({"idx": idx, "row": row, "last": last, "risk": risk, "days": days})
    counts = {"total": len(items),
              "unscreened": sum(1 for i in items if i["risk"] == "لم يُمسح"),
              "needs": sum(1 for i in items if i["risk"] == "يحتاج تقييم"),
              "urgent": sum(1 for i in items if i["risk"] == "عاجل")}
    flt = {"unscreened": ("لم يُمسح",), "needs": ("يحتاج تقييم",), "urgent": ("عاجل",)}.get(show)
    if flt:
        items = [i for i in items if i["risk"] in flt]
    items.sort(key=lambda i: (health_rules.PPD_RANK.get(i["risk"], 9), i["days"] if i["days"] is not None else 9999))
    per_page = 50
    pages = max(1, -(-len(items) // per_page))
    page = min(page, pages)
    return render_template("ppd_list.html", items=items[(page - 1) * per_page: page * per_page], counts=counts,
                           show=show, page=page, pages=pages, offset=(page - 1) * per_page, cfg=health_rules.CONFIG)


@app.route("/mental/ppd/<int:index>", methods=["GET", "POST"])
@login_required
def ppd_record(index):
    denied = _psych_only()
    if denied:
        return denied
    row = dict(_visible_family_rows()).get(index)
    if row is None:
        flash("الأسرة غير موجودة أو خارج نطاق صلاحيتك", "danger")
        return redirect(url_for("ppd_list"))
    nid = row.get("الرقم القومي", "")
    mh = _load_json(MENTAL_FILE, {})
    if request.method == "POST":
        try:
            screening_date = datetime.strptime(request.form.get("screening_date", ""), "%Y-%m-%d").strftime("%Y-%m-%d")
        except ValueError:
            screening_date = datetime.now().strftime("%Y-%m-%d")
        epds_raw = request.form.get("epds", "").strip()
        epds = ""
        if epds_raw != "":
            try:
                epds = max(0, min(int(epds_raw), 30))
            except ValueError:
                epds = ""
        record = {
            "date": screening_date, "epds": epds,
            "self_harm": "نعم" if request.form.get("self_harm") == "نعم" else "لا",
            "follow_up": request.form.get("follow_up", "لم يبدأ"),
            "notes": request.form.get("notes", "")[:1000],
            "by": current_user.username, "at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        }
        mh.setdefault(nid, {"records": []})["records"].append(record)
        _save_json(MENTAL_FILE, mh)
        audit("ppd_record", nid, health_rules.ppd_risk(record))
        flash("تم حفظ التقييم", "success")
        return redirect(url_for("ppd_record", index=index))
    records = mh.get(nid, {}).get("records", [])
    audit("ppd_view", nid)
    return render_template("ppd_record.html", family=row, index=index, records=list(reversed(records)),
                           risk=health_rules.ppd_risk(records[-1] if records else None),
                           today=datetime.now().strftime("%Y-%m-%d"), cfg=health_rules.CONFIG,
                           days=health_rules._days_since(row.get("تاريخ آخر ولادة")))


# ========================================
# طباعة شهادة دعم
# ========================================

@app.route("/certificate/<int:index>")
@login_required
def certificate(index):
    with open(filename, mode="r", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        families = list(reader)
    
    if index >= len(families):
        flash('الأسرة غير موجودة', 'danger')
        return redirect(url_for('families'))
    
    family = families[index]
    
    if family.get('مؤهل للدعم', '') != 'نعم':
        flash('هذه الأسرة غير مؤهلة للدعم', 'warning')
        return redirect(url_for('families'))
    
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, rightMargin=72, leftMargin=72, topMargin=72, bottomMargin=72)
    elements = []
    
    styles = getSampleStyleSheet()
    
    title_style = ParagraphStyle(
        'CustomTitle',
        parent=styles['Heading1'],
        fontSize=24,
        textColor=colors.HexColor('#4361EE'),
        alignment=TA_CENTER,
        spaceAfter=30,
        fontName='Helvetica-Bold'
    )
    
    normal_style = ParagraphStyle(
        'CustomNormal',
        parent=styles['Normal'],
        fontSize=14,
        alignment=TA_RIGHT,
        spaceAfter=12,
        fontName='Helvetica'
    )
    
    highlight_style = ParagraphStyle(
        'CustomHighlight',
        parent=styles['Normal'],
        fontSize=16,
        textColor=colors.HexColor('#10b981'),
        alignment=TA_CENTER,
        spaceAfter=20,
        fontName='Helvetica-Bold'
    )
    
    # العنوان
    elements.append(Paragraph("شهادة دعم اجتماعي", title_style))
    elements.append(Spacer(1, 20))
    
    # بيانات الأسرة
    elements.append(Paragraph(f"اسم رب الأسرة: <b>{family['اسم رب الأسرة']}</b>", normal_style))
    elements.append(Paragraph(f"الرقم القومي: <b>{family['الرقم القومي']}</b>", normal_style))
    elements.append(Paragraph(f"المحافظة: <b>{family['المحافظة']}</b>", normal_style))
    elements.append(Paragraph(f"عدد الأطفال: <b>{family['عدد الأطفال']}</b>", normal_style))
    elements.append(Paragraph(f"الدخل الشهري: <b>{family['الدخل الشهري']} جنيه</b>", normal_style))
    elements.append(Paragraph(f"معيل معاق: <b>{family['معيل معاق']}</b>", normal_style))
    elements.append(Paragraph(f"أيتام: <b>{family['أيتام']}</b>", normal_style))
    elements.append(Spacer(1, 20))
    
    # مستوى الأولوية
    priority_color = colors.red if "أولوية قصوى" in family['مستوى الأولوية'] else \
                    colors.orange if "متوسطة" in family['مستوى الأولوية'] else colors.green
    
    elements.append(Paragraph(f"مستوى الأولوية: <font color='{priority_color}'>{family['مستوى الأولوية']}</font>", 
                            ParagraphStyle('Priority', parent=styles['Heading2'], alignment=TA_CENTER, spaceAfter=30)))
    
    # رسالة التأهيل
    elements.append(Paragraph("✅ هذه الأسرة مؤهلة للحصول على الدعم الاجتماعي", highlight_style))
    elements.append(Spacer(1, 40))
    
    # توقيع
    issue_date = datetime.now().strftime("%Y-%m-%d")
    elements.append(Paragraph(f"تاريخ الإصدار: {issue_date}", normal_style))
    elements.append(Paragraph(f"أصدرت بواسطة: {current_user.name}", normal_style))
    elements.append(Spacer(1, 60))
    
    elements.append(Paragraph("_________________", normal_style))
    elements.append(Paragraph("توقيع المسؤول", normal_style))
    
    doc.build(elements)
    buffer.seek(0)
    
    return send_file(
        buffer,
        mimetype='application/pdf',
        as_attachment=True,
        download_name=f'شهادة_دعم_{family["اسم رب الأسرة"]}.pdf'
    )

# ========================================
# نظام الملاحظات
# ========================================

@app.route("/notes/<int:index>", methods=["GET", "POST"])
@login_required
def family_notes(index):
    with open(filename, mode="r", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        families = list(reader)
    
    if index >= len(families):
        flash('الأسرة غير موجودة', 'danger')
        return redirect(url_for('families'))
    
    family = families[index]
    
    with open(notes_file, 'r', encoding='utf-8') as f:
        all_notes = json.load(f)
    
    family_id = family['الرقم القومي']
    
    if request.method == "POST" and current_user.role in ['admin', 'employee']:
        note_text = request.form.get('note_text', '').strip()
        note_priority = request.form.get('note_priority', 'normal')
        
        if note_text:
            if family_id not in all_notes:
                all_notes[family_id] = []
            
            all_notes[family_id].append({
                'text': note_text,
                'priority': note_priority,
                'date': datetime.now().strftime("%Y-%m-%d %H:%M"),
                'author': current_user.username,
                'author_name': current_user.name
            })
            
            with open(notes_file, 'w', encoding='utf-8') as f:
                json.dump(all_notes, f, ensure_ascii=False, indent=2)
            
            flash('تم إضافة الملاحظة بنجاح', 'success')
            return redirect(url_for('family_notes', index=index))
    
    family_notes = all_notes.get(family_id, [])
    
    return render_template(
        "notes.html",
        family=family,
        notes=family_notes,
        index=index,
        current_user=current_user
    )

@app.route("/notes/delete/<int:index>/<int:note_index>")
@login_required
def delete_note(index, note_index):
    if current_user.role not in ['admin', 'employee']:
        flash('ليس لديك صلاحية الحذف', 'danger')
        return redirect(url_for('family_notes', index=index))
    
    with open(notes_file, 'r', encoding='utf-8') as f:
        all_notes = json.load(f)
    
    with open(filename, mode="r", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        families = list(reader)
    
    if index >= len(families):
        flash('الأسرة غير موجودة', 'danger')
        return redirect(url_for('families'))
    
    family_id = families[index]['الرقم القومي']
    
    if family_id in all_notes and 0 <= note_index < len(all_notes[family_id]):
        all_notes[family_id].pop(note_index)
        
        with open(notes_file, 'w', encoding='utf-8') as f:
            json.dump(all_notes, f, ensure_ascii=False, indent=2)
        
        flash('تم حذف الملاحظة بنجاح', 'success')
    
    return redirect(url_for('family_notes', index=index))

# ========================================
# نظام المتابعة الشهرية
# ========================================

@app.route("/followup/<int:index>", methods=["GET", "POST"])
@login_required
def followup(index):
    with open(filename, mode="r", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        families = list(reader)
    
    if index >= len(families):
        flash('الأسرة غير موجودة', 'danger')
        return redirect(url_for('families'))
    
    family = families[index]
    
    # تحميل الزيارات
    with open(visits_file, 'r', encoding='utf-8') as f:
        all_visits = json.load(f)
    
    family_id = family['الرقم القومي']
    
    if request.method == "POST" and current_user.role in ['admin', 'employee']:
        visit_type = request.form.get('visit_type', 'زياره عادية')
        support_received = request.form.get('support_received', 'لا')
        family_condition = request.form.get('family_condition', 'مستقر')
        notes = request.form.get('notes', '').strip()
        
        if family_id not in all_visits:
            all_visits[family_id] = []
        
        all_visits[family_id].append({
            'visit_type': visit_type,
            'support_received': support_received,
            'family_condition': family_condition,
            'notes': notes,
            'visit_date': datetime.now().strftime("%Y-%m-%d %H:%M"),
            'visited_by': current_user.username,
            'visited_by_name': current_user.name
        })
        
        with open(visits_file, 'w', encoding='utf-8') as f:
            json.dump(all_visits, f, ensure_ascii=False, indent=2)
        
        flash('تم تسجيل الزيارة بنجاح', 'success')
        return redirect(url_for('followup', index=index))
    
    family_visits = all_visits.get(family_id, [])
    
    # حساب الإحصائيات
    total_visits = len(family_visits)
    support_received_count = sum(1 for v in family_visits if v.get('support_received') == 'نعم')
    support_received_percentage = (support_received_count / total_visits * 100) if total_visits > 0 else 0
    
    return render_template(
        "followup.html",
        family=family,
        visits=family_visits,
        total_visits=total_visits,
        support_received_count=support_received_count,
        support_received_percentage=support_received_percentage,
        index=index,
        current_user=current_user
    )

@app.route("/followup/delete/<int:index>/<int:visit_index>")
@login_required
def delete_visit(index, visit_index):
    if current_user.role not in ['admin', 'employee']:
        flash('ليس لديك صلاحية الحذف', 'danger')
        return redirect(url_for('followup', index=index))
    
    with open(visits_file, 'r', encoding='utf-8') as f:
        all_visits = json.load(f)
    
    with open(filename, mode="r", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        families = list(reader)
    
    if index >= len(families):
        flash('الأسرة غير موجودة', 'danger')
        return redirect(url_for('families'))
    
    family_id = families[index]['الرقم القومي']
    
    if family_id in all_visits and 0 <= visit_index < len(all_visits[family_id]):
        all_visits[family_id].pop(visit_index)
        
        with open(visits_file, 'w', encoding='utf-8') as f:
            json.dump(all_visits, f, ensure_ascii=False, indent=2)
        
        flash('تم حذف الزيارة بنجاح', 'success')
    
    return redirect(url_for('followup', index=index))

# ========================================
# تقرير المتابعة الشهري
# ========================================

@app.route("/followup/report")
@login_required
def followup_report():
    with open(filename, mode="r", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        families = list(reader)
    
    with open(visits_file, 'r', encoding='utf-8') as f:
        all_visits = json.load(f)
    
    # حساب الإحصائيات الشاملة
    total_families = len(families)
    families_with_visits = len([f for f in families if f['الرقم القومي'] in all_visits])
    
    total_visits_all = sum(len(visits) for visits in all_visits.values())
    
    # إحصائيات استلام الدعم
    support_received_total = 0
    for family_id, visits in all_visits.items():
        support_received_total += sum(1 for v in visits if v.get('support_received') == 'نعم')
    
    support_received_percentage = (support_received_total / total_visits_all * 100) if total_visits_all > 0 else 0
    
    # ترتيب الأسر حسب عدد الزيارات
    families_visits = []
    for family in families:
        family_id = family['الرقم القومي']
        visit_count = len(all_visits.get(family_id, []))
        if visit_count > 0:
            families_visits.append({
                'family': family,
                'visit_count': visit_count,
                'last_visit': all_visits[family_id][-1]['visit_date'] if all_visits.get(family_id) else 'لا يوجد'
            })
    
    families_visits.sort(key=lambda x: x['visit_count'], reverse=True)
    
    # أحدث 10 زيارات
    all_visits_list = []
    for family_id, visits in all_visits.items():
        for visit in visits:
            family = next((f for f in families if f['الرقم القومي'] == family_id), None)
            if family:
                all_visits_list.append({
                    'family': family,
                    'visit': visit
                })
    
    all_visits_list.sort(key=lambda x: x['visit']['visit_date'], reverse=True)
    latest_visits = all_visits_list[:10]
    
    return render_template(
        "followup_report.html",
        total_families=total_families,
        families_with_visits=families_with_visits,
        total_visits_all=total_visits_all,
        support_received_total=support_received_total,
        support_received_percentage=support_received_percentage,
        families_visits=families_visits,
        latest_visits=latest_visits,
        current_user=current_user
    )

# ========================================
# API للإحصائيات
# ========================================

@app.route("/api/stats")
@login_required
def api_stats():
    families = []
    with open(filename, mode="r", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        for row in reader:
            families.append(row)
    
    eligible_count = sum(1 for f in families if f.get('مؤهل للدعم', '') == 'نعم')
    not_eligible_count = len(families) - eligible_count
    
    governorates = {}
    for family in families:
        gov = family.get('المحافظة', 'غير معروف')
        governorates[gov] = governorates.get(gov, 0) + 1
    
    children_stats = {"0-2": 0, "3-5": 0, "6+": 0}
    for family in families:
        try:
            children = int(family.get('عدد الأطفال', 0))
            if children <= 2:
                children_stats["0-2"] += 1
            elif children <= 5:
                children_stats["3-5"] += 1
            else:
                children_stats["6+"] += 1
        except:
            pass
    
    priority_stats = {"أولوية قصوى 🔴": 0, "أولوية متوسطة 🟡": 0, "أولوية منخفضة 🟢": 0}
    for family in families:
        level = family.get('مستوى الأولوية', '')
        if level in priority_stats:
            priority_stats[level] += 1
    
    return jsonify({
        "total": len(families),
        "eligible": eligible_count,
        "not_eligible": not_eligible_count,
        "governorates": governorates,
        "children_stats": children_stats,
        "priority_stats": priority_stats
    })

# ========================================
# الرسوم البيانية
# ========================================

@app.route("/charts")
@login_required
def charts():
    return render_template("charts.html", current_user=current_user)

# ========================================
# النسخ الاحتياطي
# ========================================

@app.route("/backup")
@login_required
def backup():
    if current_user.role != 'admin':
        flash('ليس لديك صلاحية النسخ الاحتياطي', 'danger')
        return redirect(url_for('index'))
    
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_filename = f"backup_{timestamp}.csv"
    backup_path = os.path.join(backups_dir, backup_filename)
    
    shutil.copy2(filename, backup_path)
    
    flash(f'تم إنشاء نسخة احتياطية: {backup_filename}', 'success')
    return redirect(url_for('backups_list'))

@app.route("/backups")
@login_required
def backups_list():
    if current_user.role != 'admin':
        flash('ليس لديك صلاحية عرض النسخ الاحتياطية', 'danger')
        return redirect(url_for('index'))
    
    backups = []
    for file in os.listdir(backups_dir):
        if file.endswith('.csv'):
            file_path = os.path.join(backups_dir, file)
            file_size = os.path.getsize(file_path) / 1024
            file_time = datetime.fromtimestamp(os.path.getmtime(file_path)).strftime("%Y-%m-%d %H:%M")
            backups.append({
                'name': file,
                'size': f"{file_size:.2f} KB",
                'time': file_time,
                'path': file_path
            })
    
    backups.sort(key=lambda x: x['time'], reverse=True)
    
    return render_template("backups.html", backups=backups, current_user=current_user)

@app.route("/backup/restore/<backup_name>")
@login_required
def restore_backup(backup_name):
    if current_user.role != 'admin':
        flash('ليس لديك صلاحية الاستعادة', 'danger')
        return redirect(url_for('backups_list'))
    
    backup_path = os.path.join(backups_dir, backup_name)
    
    if os.path.exists(backup_path):
        shutil.copy2(backup_path, filename)
        flash(f'تم استعادة النسخة الاحتياطية: {backup_name}', 'success')
    else:
        flash('النسخة الاحتياطية غير موجودة', 'danger')
    
    return redirect(url_for('backups_list'))

@app.route("/backup/download/<backup_name>")
@login_required
def download_backup(backup_name):
    if current_user.role != 'admin':
        flash('ليس لديك صلاحية التحميل', 'danger')
        return redirect(url_for('backups_list'))
    
    backup_path = os.path.join(backups_dir, backup_name)
    
    if os.path.exists(backup_path):
        return send_file(backup_path, as_attachment=True)
    else:
        flash('النسخة الاحتياطية غير موجودة', 'danger')
        return redirect(url_for('backups_list'))

# ========================================
# لوحة التحكم
# ========================================

@app.route("/dashboard")
@login_required
def dashboard():
    families = []
    with open(filename, mode="r", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        for row in reader:
            families.append(row)
    
    total_families = len(families)
    eligible_count = sum(1 for f in families if f.get('مؤهل للدعم', '') == 'نعم')
    not_eligible_count = total_families - eligible_count
    
    governorates_stats = {}
    for family in families:
        gov = family.get('المحافظة', 'غير معروف')
        governorates_stats[gov] = governorates_stats.get(gov, {'total': 0, 'eligible': 0})
        governorates_stats[gov]['total'] += 1
        if family.get('مؤهل للدعم', '') == 'نعم':
            governorates_stats[gov]['eligible'] += 1
    
    latest_families = families[-5:] if len(families) >= 5 else families
    
    return render_template(
        "dashboard.html",
        total_families=total_families,
        eligible_count=eligible_count,
        not_eligible_count=not_eligible_count,
        governorates_stats=governorates_stats,
        latest_families=latest_families,
        current_user=current_user
    )


# ========================================
# التعرف على المستندات بالذكاء الاصطناعي (Deep Learning)
# ========================================

# قواعد التعرف على أنواع المستندات (Regex + Keyword patterns)
DOCUMENT_PATTERNS = {
    "بطاقة رقم قومي": {
        "keywords": ["رقم قومي", "national id", "جمهورية مصر", "وزارة الداخلية",
                     "تاريخ الميلاد", "محل الإقامة", "الجنسية", "مصري"],
        "patterns": [r'\b\d{14}\b'],
        "confidence_boost": 30
    },
    "شهادة ميلاد": {
        "keywords": ["شهادة ميلاد", "birth certificate", "سجل مدني", "مواليد",
                     "الأب", "الأم", "رقم القيد", "محافظة"],
        "patterns": [r'مواليد\s+\d{4}', r'رقم القيد\s*:?\s*\d+'],
        "confidence_boost": 25
    },
    "إيصال راتب / مرتب": {
        "keywords": ["مرتب", "راتب", "salary", "payslip", "صافي", "إجمالي",
                     "خصومات", "بدل", "تأمينات", "الشهر"],
        "patterns": [r'صافي\s*[\d,\.]+', r'إجمالي\s*[\d,\.]+', r'\d+\s*جنيه'],
        "confidence_boost": 20
    },
    "عقد إيجار": {
        "keywords": ["عقد إيجار", "lease", "مستأجر", "مؤجر", "الوحدة السكنية",
                     "الإيجار الشهري", "مدة العقد", "مقدم الإيجار"],
        "patterns": [r'مدة\s+العقد\s+\d+', r'الإيجار\s+الشهري\s*[\d,\.]+'],
        "confidence_boost": 20
    },
    "شهادة إعاقة": {
        "keywords": ["إعاقة", "disability", "لجنة الإعاقة", "نسبة العجز",
                     "وزارة الصحة", "شهادة طبية", "عجز كلي", "عجز جزئي"],
        "patterns": [r'نسبة\s+العجز\s*:?\s*\d+%?', r'درجة\s+الإعاقة'],
        "confidence_boost": 25
    },
    "وثيقة وفاة": {
        "keywords": ["وفاة", "death certificate", "شهادة وفاة", "المتوفى",
                     "سجل الوفيات", "تاريخ الوفاة", "مستشفى"],
        "patterns": [r'تاريخ\s+الوفاة', r'المتوفى\s*:'],
        "confidence_boost": 25
    },
}

def analyze_document_text(text):
    """
    تحليل نص المستند واستخراج نوعه ومعلوماته
    يستخدم نظام نقاط مرجّح (keyword matching + regex patterns)
    """
    text_lower = text.lower()
    results = {}

    for doc_type, rules in DOCUMENT_PATTERNS.items():
        score = 0
        matched_keywords = []
        matched_patterns = []

        # نقاط الكلمات المفتاحية
        for kw in rules["keywords"]:
            if kw.lower() in text_lower:
                score += 10
                matched_keywords.append(kw)

        # نقاط إضافية من الأنماط
        for pattern in rules["patterns"]:
            if re.search(pattern, text, re.IGNORECASE):
                score += rules["confidence_boost"]
                matched_patterns.append(pattern)

        if score > 0:
            results[doc_type] = {
                "score": score,
                "matched_keywords": matched_keywords,
                "matched_patterns": matched_patterns
            }

    if not results:
        return {
            "document_type": "غير معروف",
            "confidence": 0,
            "all_scores": {},
            "extracted_info": {}
        }

    # أعلى نوع مستند
    best_type = max(results, key=lambda x: results[x]["score"])
    best_score = results[best_type]["score"]

    # تحويل النقاط إلى نسبة ثقة (0-100)
    max_possible = 10 * len(DOCUMENT_PATTERNS[best_type]["keywords"]) + \
                   DOCUMENT_PATTERNS[best_type]["confidence_boost"] * len(DOCUMENT_PATTERNS[best_type]["patterns"])
    confidence = min(round((best_score / max(max_possible, 1)) * 100), 100)

    # استخراج معلومات محددة
    extracted_info = {}
    national_id_match = re.search(r'\b(\d{14})\b', text)
    if national_id_match:
        extracted_info["الرقم القومي"] = national_id_match.group(1)

    date_match = re.search(r'\b(\d{1,2}[/\-]\d{1,2}[/\-]\d{4})\b', text)
    if date_match:
        extracted_info["تاريخ مُكتشف"] = date_match.group(1)

    amount_match = re.search(r'(\d[\d,\.]+)\s*جنيه', text)
    if amount_match:
        extracted_info["مبلغ مالي"] = amount_match.group(1) + " جنيه"

    return {
        "document_type": best_type,
        "confidence": confidence,
        "matched_keywords": results[best_type]["matched_keywords"],
        "all_scores": {k: v["score"] for k, v in results.items()},
        "extracted_info": extracted_info
    }


@app.route("/documents", methods=["GET", "POST"])
@login_required
def document_recognition():
    result = None
    error = None

    if request.method == "POST":
        # ── مسار 1: رفع صورة مستند ──
        if 'document_image' in request.files and request.files['document_image'].filename:
            file = request.files['document_image']
            allowed = {'png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff', 'pdf'}
            ext = file.filename.rsplit('.', 1)[-1].lower() if '.' in file.filename else ''

            if ext not in allowed:
                error = "نوع الملف غير مدعوم. يُرجى رفع صورة (JPG, PNG, PDF)"
            else:
                try:
                    import pytesseract
                    from PIL import Image

                    if ext == 'pdf':
                        error = "لاستخراج النصوص من PDF يُرجى تحويله لصورة أولاً"
                    else:
                        img = Image.open(file.stream)
                        # OCR مع دعم العربية والإنجليزية
                        extracted_text = pytesseract.image_to_string(img, lang='ara+eng')
                        result = analyze_document_text(extracted_text)
                        result['raw_text'] = extracted_text[:500] + ("..." if len(extracted_text) > 500 else "")
                        result['input_method'] = 'image'

                except ImportError:
                    # fallback لو مكتبة pytesseract مش موجودة
                    error = "مكتبة OCR غير مثبتة على الخادم. يُرجى استخدام إدخال النص اليدوي."
                except Exception as e:
                    error = f"حدث خطأ أثناء معالجة الصورة: {str(e)}"

        # ── مسار 2: إدخال نص يدوي (للتجربة والتطوير) ──
        elif request.form.get('manual_text', '').strip():
            text = request.form['manual_text'].strip()
            if len(text) < 10:
                error = "النص قصير جداً، يُرجى إدخال محتوى المستند"
            else:
                result = analyze_document_text(text)
                result['raw_text'] = text[:500]
                result['input_method'] = 'manual'
        else:
            error = "يُرجى رفع صورة مستند أو إدخال نصه يدوياً"

    return render_template("documents.html", result=result, error=error, current_user=current_user)


@app.route("/api/analyze-document", methods=["POST"])
@login_required
def api_analyze_document():
    """API endpoint لتحليل المستند برمجياً"""
    data = request.get_json()
    if not data or 'text' not in data:
        return jsonify({"error": "يُرجى إرسال نص المستند في حقل 'text'"}), 400

    result = analyze_document_text(data['text'])
    return jsonify(result)

# ========================================
# Analytics Dashboard
# ========================================
@app.route("/analytics")
@login_required
def analytics():
    return render_template("analytics.html", current_user=current_user)

@app.route("/dashboard/stats")
@login_required
def dashboard_stats():
    families = []
    with open(filename, mode="r", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        for row in reader:
            families.append(row)
    gov_counts = {}
    for f in families:
        g = f.get("المحافظة", "غير معروف")
        gov_counts[g] = gov_counts.get(g, 0) + 1
    income_buckets = {"أقل من 1000": 0, "1000-3000": 0, "3000-5000": 0, "أكثر من 5000": 0}
    for f in families:
        try:
            inc = int(f.get("الدخل الشهري", 0))
            if inc < 1000: income_buckets["أقل من 1000"] += 1
            elif inc < 3000: income_buckets["1000-3000"] += 1
            elif inc < 5000: income_buckets["3000-5000"] += 1
            else: income_buckets["أكثر من 5000"] += 1
        except: pass
    priority_counts = {"أولوية قصوى 🔴": 0, "أولوية متوسطة 🟡": 0, "أولوية منخفضة 🟢": 0}
    for f in families:
        lv = f.get("مستوى الأولوية", "")
        if lv in priority_counts: priority_counts[lv] += 1
    children_dist = {}
    for f in families:
        try:
            c = str(int(f.get("عدد الأطفال", 0)))
            children_dist[c] = children_dist.get(c, 0) + 1
        except: pass
    return jsonify({
        "total": len(families),
        "eligible": sum(1 for f in families if f.get("مؤهل للدعم") == "نعم"),
        "disabled": sum(1 for f in families if f.get("معيل معاق") == "نعم"),
        "orphans": sum(1 for f in families if f.get("أيتام") == "نعم"),
        "governorates": gov_counts,
        "income_distribution": income_buckets,
        "priority_distribution": priority_counts,
        "children_distribution": children_dist,
    })

# ========================================
# Notifications
# ========================================
@app.route("/notifications")
@login_required
def notifications_page():
    return render_template("notifications.html", current_user=current_user)

@app.route("/api/notifications")
@login_required
def api_notifications():
    families = []
    with open(filename, mode="r", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        for row in reader:
            families.append(row)
    with open(visits_file, "r", encoding="utf-8") as f:
        all_visits = json.load(f)
    now = datetime.now()
    notifications = []
    for i, family in enumerate(families):
        fid = family.get("الرقم القومي", "")
        visits = all_visits.get(fid, [])
        if not visits:
            try:
                added = datetime.strptime(family.get("تاريخ الإضافة",""), "%Y-%m-%d %H:%M")
                days_since = (now - added).days
            except: days_since = 999
            if days_since >= 30:
                notifications.append({"type":"no_visit","family_name":family.get("اسم رب الأسرة",""),
                    "family_index":i,"days":days_since,"priority":family.get("مستوى الأولوية",""),
                    "message":f"لم تزار منذ {days_since} يوم"})
        else:
            try:
                last_visit = datetime.strptime(visits[-1].get("visit_date",""), "%Y-%m-%d %H:%M")
                days_since = (now - last_visit).days
            except: days_since = 0
            if days_since >= 30:
                notifications.append({"type":"overdue_visit","family_name":family.get("اسم رب الأسرة",""),
                    "family_index":i,"days":days_since,"priority":family.get("مستوى الأولوية",""),
                    "message":f"آخر زيارة منذ {days_since} يوم"})
    return jsonify({"notifications": notifications, "count": len(notifications)})

# ========================================
# Map
# ========================================
@app.route("/map")
@login_required
def map_view():
    families = []
    with open(filename, mode="r", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        for row in reader:
            families.append(row)
    gov_data = {}
    for f in families:
        gov = f.get("المحافظة", "غير معروف")
        if gov not in gov_data:
            gov_data[gov] = {"total": 0, "eligible": 0, "high_priority": 0}
        gov_data[gov]["total"] += 1
        if f.get("مؤهل للدعم") == "نعم": gov_data[gov]["eligible"] += 1
        if "قصوى" in f.get("مستوى الأولوية", ""): gov_data[gov]["high_priority"] += 1
        if health_rules.has_health_data(f):
            gov_data[gov]["health_n"] = gov_data[gov].get("health_n", 0) + 1
            if health_rules.needs_followup(f):
                gov_data[gov]["health_need"] = gov_data[gov].get("health_need", 0) + 1
            if "pregnant" in health_rules.health_alerts(f):
                gov_data[gov]["preg_unmon"] = gov_data[gov].get("preg_unmon", 0) + 1

    # بيانات CAPMAS (نسبة الإعاقة لكل محافظة + مؤشرات قومية)
    capmas_path = os.path.join(os.path.dirname(__file__), "data", "capmas_governorates.json")
    with open(capmas_path, encoding="utf-8") as f:
        capmas = json.load(f)
    disability_by_gov = capmas.get("disability_by_governorate", {})
    national_indicators = capmas.get("national_indicators", {})

    # دمج نسبة الإعاقة (لو متاحة) داخل بيانات كل محافظة
    all_govs = set(gov_data.keys()) | set(disability_by_gov.keys())
    for gov in all_govs:
        if gov not in gov_data:
            gov_data[gov] = {"total": 0, "eligible": 0, "high_priority": 0}
        gov_data[gov]["disability_pct"] = disability_by_gov.get(gov)  # None لو مش متاحة

    return render_template(
        "map.html",
        gov_data=json.dumps(gov_data, ensure_ascii=False),
        national_indicators=json.dumps(national_indicators, ensure_ascii=False),
        current_user=current_user,
    )

# ========================================
# ML
# ========================================
@app.route("/ml")
@login_required
def ml_prediction():
    families = []
    with open(filename, mode="r", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        for row in reader:
            families.append(row)

    model_info = {
        "trained": False, "train_accuracy": None, "test_accuracy": None,
        "total_samples": len(families), "train_size": 0, "test_size": 0,
        "error": None, "warning": None, "feature_importance": [], "model_name": "Random Forest",
    }
    predictions = []

    try:
        from sklearn.ensemble import RandomForestClassifier
        from sklearn.model_selection import train_test_split
        from sklearn.metrics import accuracy_score
        import numpy as np

        X, y, valid_families = [], [], []
        for f in families:
            try:
                children = int(f.get("عدد الأطفال", 0))
                income = int(f.get("الدخل الشهري", 0))
                disabled = 1 if f.get("معيل معاق") == "نعم" else 0
                orphans = 1 if f.get("أيتام") == "نعم" else 0
                label = 1 if f.get("مؤهل للدعم") == "نعم" else 0
                X.append([children, income, disabled, orphans])
                y.append(label)
                valid_families.append(f)
            except Exception:
                pass

        n_samples = len(X)
        n_classes = len(set(y))

        # ── تحقق من كفاية وتنوّع البيانات قبل أي تدريب ──────────────
        if n_samples < 10:
            model_info["error"] = f"البيانات غير كافية للتدريب الحقيقي ({n_samples} أسرة فقط). محتاج 10 أسر على الأقل، والأفضل 30+."
        elif n_classes < 2:
            model_info["error"] = (
                "كل الأسر المسجلة حاليًا لها نفس قيمة 'مؤهل للدعم' (كلهم نفس الفئة)، "
                "فمفيش للموديل حاجة يتعلم يميّز بينها. سجّل أسر متنوعة (مؤهلة وغير مؤهلة) وارجع تاني."
            )
        else:
            X_arr = np.array(X)
            y_arr = np.array(y)

            # ── تقسيم حقيقي: تدريب/اختبار، مع الحفاظ على نسبة الفئتين (stratify) ──
            test_fraction = 0.25 if n_samples >= 20 else max(1 / n_samples, 0.2)
            X_train, X_test, y_train, y_test, families_train, families_test = train_test_split(
                X_arr, y_arr, valid_families,
                test_size=test_fraction, random_state=42,
                stratify=y_arr if min(np.bincount(y_arr)) >= 2 else None,
            )

            clf = RandomForestClassifier(
                n_estimators=200, max_depth=5, random_state=42, class_weight="balanced"
            )
            clf.fit(X_train, y_train)

            train_acc = accuracy_score(y_train, clf.predict(X_train))
            test_acc = accuracy_score(y_test, clf.predict(X_test))

            model_info["trained"] = True
            model_info["train_accuracy"] = round(train_acc * 100, 1)
            model_info["test_accuracy"] = round(test_acc * 100, 1)
            model_info["train_size"] = len(X_train)
            model_info["test_size"] = len(X_test)

            if n_samples < 30:
                model_info["warning"] = (
                    f"العينة صغيرة ({n_samples} أسرة، منها {len(X_test)} بس للاختبار). "
                    "النسبة دي مؤشر مبدئي مش دقة موثوقة إحصائيًا — كل ما تزود بيانات حقيقية ومتنوعة، "
                    "كل ما الرقم يبقى معبّر أكتر."
                )

            feature_names = ["عدد الأطفال", "الدخل الشهري", "معيل معاق", "أيتام"]
            model_info["feature_importance"] = [
                {"feature": name, "importance": round(float(imp) * 100, 1)}
                for name, imp in zip(feature_names, clf.feature_importances_)
            ]

            # نعرض تنبؤات موديل على عينة الاختبار فقط (بيانات ما شافهاش وقت التدريب)
            for f, x, actual in zip(families_test, X_test, y_test):
                pred = clf.predict([x])[0]
                prob = clf.predict_proba([x])[0]
                predictions.append({
                    "name": f.get("اسم رب الأسرة", ""),
                    "actual": "مؤهل" if actual == 1 else "غير مؤهل",
                    "predicted": "مؤهل" if pred == 1 else "غير مؤهل",
                    "confidence": round(max(prob) * 100, 1),
                    "match": bool(pred == actual),
                    "priority": f.get("مستوى الأولوية", ""),
                    "set": "اختبار (بيانات لم يرها الموديل)",
                })

    except ImportError:
        model_info["error"] = "شغّل: python -m pip install scikit-learn"
    except Exception as e:
        model_info["error"] = str(e)

    return render_template("ml.html", model_info=model_info, predictions=predictions, current_user=current_user)

# ========================================
# Compare
# ========================================
@app.route("/compare")
@login_required
def compare_families():
    families = []
    with open(filename, mode="r", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        for row in reader:
            families.append(row)
    idx1 = request.args.get("f1", type=int)
    idx2 = request.args.get("f2", type=int)
    family1 = families[idx1] if idx1 is not None and 0 <= idx1 < len(families) else None
    family2 = families[idx2] if idx2 is not None and 0 <= idx2 < len(families) else None
    comparison = None
    if family1 and family2:
        def get_bd(f):
            _, _, _, bd = calculate_priority(f.get("عدد الأطفال",0), f.get("الدخل الشهري",0), f.get("معيل معاق","لا"), f.get("أيتام","لا"))
            return bd
        comparison = {"breakdown1": get_bd(family1), "breakdown2": get_bd(family2)}
    return render_template("compare.html", families=families, family1=family1, family2=family2, idx1=idx1, idx2=idx2, comparison=comparison, current_user=current_user)

# ========================================
# Security
# ========================================
@app.route("/security")
@login_required
def security_page():
    if current_user.role != 'admin':
        flash('مش مسموح لك', 'danger')
        return redirect(url_for('index'))
    return render_template("security.html", security_log=[], blocked_ips={}, failed_attempts={}, current_user=current_user)

@app.route("/change-password", methods=["GET", "POST"])
@login_required
def change_password():
    error = None
    success = None
    if request.method == "POST":
        old_pass = request.form.get("old_password", "")
        new_pass = request.form.get("new_password", "")
        confirm = request.form.get("confirm_password", "")
        if not check_password_hash(users_db[current_user.username]['password'], old_pass):
            error = "كلمة السر القديمة غلط"
        elif new_pass != confirm:
            error = "كلمة السر الجديدة مش متطابقة"
        elif len(new_pass) < 8:
            error = "كلمة السر لازم تكون 8 أحرف على الأقل"
        else:
            users_db[current_user.username]['password'] = generate_password_hash(new_pass)
            success = "تم تغيير كلمة السر بنجاح!"
    return render_template("change_password.html", error=error, success=success, current_user=current_user)


if __name__ == "__main__":
    app.run(debug=True)
