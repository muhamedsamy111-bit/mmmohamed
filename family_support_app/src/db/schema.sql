-- Family Support database schema (SQLite, portable to PostgreSQL).
--
-- Entities the backend must know about:
--   families    household head. Mandatory: name, national_id, age, address.
--   children    every child, incl. رقم شهادة الميلاد + twin linkage.
--   documents   ID card, the 3 health-insurance IDs, birth certificates.
--   pregnancies current + history; a pregnant customer is flagged differently.
--
-- Twins: twin children share one twin_group_id. twin_type is one of
--   'identical' (متماثل) | 'fraternal' (غير متماثل) | 'other' (أخرى/غير محدد).
-- A non-twin child is simply is_twin = 0 (the "other" bucket).

PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS families (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,             -- اسم رب الأسرة (mandatory)
  national_id       TEXT NOT NULL UNIQUE,      -- الرقم القومي 14 رقم (mandatory)
  age               INTEGER,                   -- العمر (mandatory on create)
  address           TEXT NOT NULL DEFAULT '',  -- العنوان (mandatory on create)
  governorate       TEXT DEFAULT '',
  email             TEXT DEFAULT '',
  phone             TEXT DEFAULT '',
  children_count    INTEGER DEFAULT 0,
  family_members    INTEGER DEFAULT 1,
  income            REAL DEFAULT 0,
  has_disabled      TEXT DEFAULT 'لا',
  has_orphans       TEXT DEFAULT 'لا',
  eligible          TEXT DEFAULT 'لا',
  priority_score    REAL DEFAULT 0,
  priority_level    TEXT DEFAULT '',
  added_at          TEXT DEFAULT (strftime('%Y-%m-%d %H:%M', 'now')),
  added_by          TEXT DEFAULT '',
  mail_status       TEXT DEFAULT '',
  request_status    TEXT DEFAULT 'قيد المراجعة',
  is_pregnant       TEXT DEFAULT 'لا',
  pregnancy_followup TEXT DEFAULT 'لا ينطبق',
  under_5           INTEGER DEFAULT 0,
  vaccines_complete TEXT DEFAULT 'لا ينطبق',
  chronic_disease   TEXT DEFAULT 'لا',
  malnutrition      TEXT DEFAULT 'لا ينطبق',
  treatment_cost    REAL DEFAULT 0,
  last_pregnancy_visit TEXT DEFAULT '',
  last_vaccine      TEXT DEFAULT '',
  last_delivery     TEXT DEFAULT '',
  health_score      REAL DEFAULT 0,
  health_level      TEXT DEFAULT '',
  has_insurance     TEXT DEFAULT 'لا',       -- لديه تأمين صحي
  family_type       TEXT DEFAULT '',          -- تصنيف الأسرة (حمل بتوأم / أسرة أخرى ...)
  children_multiples TEXT DEFAULT '',         -- تعدد مواليد الأطفال الحاليين
  pregnancy_kind    TEXT DEFAULT '',          -- نوع الحمل الحالي
  fetus_count       INTEGER DEFAULT 0         -- عدد الأجنة
);

CREATE TABLE IF NOT EXISTS children (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id             INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,         -- اسم الطفل
  birth_date            TEXT DEFAULT '',        -- YYYY-MM-DD
  gender                TEXT DEFAULT '',        -- ذكر / أنثى
  national_id           TEXT DEFAULT '',        -- الرقم القومي للطفل إن وجد
  birth_certificate_no  TEXT DEFAULT '',        -- رقم شهادة الميلاد
  birth_certificate_file TEXT DEFAULT '',       -- مسار صورة الشهادة
  relation              TEXT DEFAULT 'ابن/ابنة',
  is_twin               INTEGER DEFAULT 0,     -- 1 = توأم
  twin_group_id         INTEGER,               -- نفس القيمة تربط التوأم ببعضه
  twin_type             TEXT,                  -- identical | fraternal | other
  notes                 TEXT DEFAULT '',
  created_at            TEXT DEFAULT (strftime('%Y-%m-%d %H:%M', 'now')),
  CHECK (is_twin IN (0, 1)),
  CHECK (twin_type IS NULL OR twin_type IN ('identical', 'fraternal', 'other'))
);

CREATE TABLE IF NOT EXISTS documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_kind    TEXT NOT NULL,                 -- 'family' | 'child'
  owner_id      INTEGER NOT NULL,
  doc_type      TEXT NOT NULL,                 -- national_id_card | birth_certificate
                                               -- | insurance_1 | insurance_2 | insurance_3 | other
  doc_number    TEXT DEFAULT '',                -- رقم المستند إن وجد
  file_path     TEXT DEFAULT '',
  verified      INTEGER DEFAULT 0,
  uploaded_by   TEXT DEFAULT '',
  uploaded_at   TEXT DEFAULT (strftime('%Y-%m-%d %H:%M', 'now')),
  CHECK (owner_kind IN ('family', 'child'))
);

CREATE TABLE IF NOT EXISTS pregnancies (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id         INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'pregnant',  -- pregnant | delivered | not_pregnant
  is_current        INTEGER DEFAULT 1,
  expected_delivery TEXT DEFAULT '',
  last_visit        TEXT DEFAULT '',
  followup          TEXT DEFAULT 'لا',
  twins_expected    INTEGER DEFAULT 0,
  twin_type         TEXT,                        -- identical | fraternal | other
  notes             TEXT DEFAULT '',
  created_at        TEXT DEFAULT (strftime('%Y-%m-%d %H:%M', 'now')),
  updated_at        TEXT DEFAULT (strftime('%Y-%m-%d %H:%M', 'now')),
  CHECK (status IN ('pregnant', 'delivered', 'not_pregnant')),
  CHECK (twins_expected IN (0, 1))
);

CREATE TABLE IF NOT EXISTS shop_products (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL,
  description         TEXT DEFAULT '',
  category            TEXT DEFAULT 'ألعاب أطفال',
  age_min             INTEGER DEFAULT 0,
  age_max             INTEGER DEFAULT 18,
  sale_price          REAL NOT NULL DEFAULT 0 CHECK (sale_price >= 0),
  rental_daily_price  REAL NOT NULL DEFAULT 0 CHECK (rental_daily_price >= 0),
  sale_stock          INTEGER NOT NULL DEFAULT 0 CHECK (sale_stock >= 0),
  rental_stock        INTEGER NOT NULL DEFAULT 0 CHECK (rental_stock >= 0),
  image_url           TEXT DEFAULT '',
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at          TEXT DEFAULT (strftime('%Y-%m-%d %H:%M', 'now'))
);

CREATE TABLE IF NOT EXISTS shop_orders (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_username   TEXT NOT NULL,
  customer_name       TEXT NOT NULL,
  phone               TEXT NOT NULL,
  address             TEXT NOT NULL,
  order_status        TEXT NOT NULL DEFAULT 'قيد التجهيز',
  payment_method      TEXT NOT NULL DEFAULT 'الدفع عند الاستلام',
  total               REAL NOT NULL DEFAULT 0 CHECK (total >= 0),
  created_at          TEXT DEFAULT (strftime('%Y-%m-%d %H:%M', 'now'))
);

CREATE TABLE IF NOT EXISTS shop_order_items (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id            INTEGER NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
  product_id          INTEGER NOT NULL REFERENCES shop_products(id),
  product_name        TEXT NOT NULL,
  item_kind           TEXT NOT NULL CHECK (item_kind IN ('شراء', 'إيجار')),
  quantity            INTEGER NOT NULL CHECK (quantity > 0),
  unit_price          REAL NOT NULL CHECK (unit_price >= 0),
  rental_days         INTEGER NOT NULL DEFAULT 0,
  rental_due_date     TEXT DEFAULT '',
  rental_status       TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS community_posts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  author_username     TEXT NOT NULL,
  author_name         TEXT NOT NULL,
  category            TEXT NOT NULL,
  title               TEXT NOT NULL,
  body                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden')),
  created_at          TEXT DEFAULT (strftime('%Y-%m-%d %H:%M', 'now')),
  updated_at          TEXT DEFAULT (strftime('%Y-%m-%d %H:%M', 'now'))
);

CREATE TABLE IF NOT EXISTS community_replies (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id             INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  author_username     TEXT NOT NULL,
  author_name         TEXT NOT NULL,
  body                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden')),
  created_at          TEXT DEFAULT (strftime('%Y-%m-%d %H:%M', 'now'))
);

CREATE TABLE IF NOT EXISTS community_likes (
  post_id             INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  username            TEXT NOT NULL,
  created_at          TEXT DEFAULT (strftime('%Y-%m-%d %H:%M', 'now')),
  PRIMARY KEY (post_id, username)
);

CREATE INDEX IF NOT EXISTS idx_shop_products_active ON shop_products(active, category);
CREATE INDEX IF NOT EXISTS idx_shop_orders_customer ON shop_orders(customer_username, created_at);
CREATE INDEX IF NOT EXISTS idx_shop_order_items_order ON shop_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_community_posts_created ON community_posts(status, created_at);
CREATE INDEX IF NOT EXISTS idx_community_replies_post ON community_replies(post_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_children_family ON children(family_id);
CREATE INDEX IF NOT EXISTS idx_children_twin_group ON children(twin_group_id);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_kind, owner_id);
CREATE INDEX IF NOT EXISTS idx_pregnancies_family ON pregnancies(family_id);
CREATE INDEX IF NOT EXISTS idx_families_nid ON families(national_id);
CREATE INDEX IF NOT EXISTS idx_families_gov ON families(governorate);
