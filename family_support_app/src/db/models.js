'use strict';

/**
 * Data-access layer: families, children (+twins), documents, pregnancies.
 * All writes that belong together run in a transaction.
 */

const { getDb } = require('./index');
const { validateNationalIdFormat, normalizeNid } = require('../services/priorityCalculator');

const TWIN_TYPES = ['identical', 'fraternal', 'other'];
const TWIN_LABELS = { identical: 'متماثل', fraternal: 'غير متماثل', other: 'أخرى/غير محدد' };
const PREGNANCY_STATUS = ['pregnant', 'delivered', 'not_pregnant'];
const INSURANCE_DOCS = ['insurance_1', 'insurance_2', 'insurance_3'];
const DOC_LABELS = {
  national_id_card: 'بطاقة الرقم القومي',
  birth_certificate: 'شهادة الميلاد',
  insurance_1: 'إثبات تأمين صحي 1',
  insurance_2: 'إثبات تأمين صحي 2',
  insurance_3: 'إثبات تأمين صحي 3',
  other: 'مستند آخر'
};

/** Age in full years derived from the national ID birth date, or null. */
function ageFromNid(nid) {
  const s = normalizeNid(nid);
  if (!/^\d{14}$/.test(s) || (s[0] !== '2' && s[0] !== '3')) return null;
  const year = (s[0] === '2' ? 1900 : 2000) + parseInt(s.slice(1, 3), 10);
  const month = parseInt(s.slice(3, 5), 10);
  const day = parseInt(s.slice(5, 7), 10);
  const birth = new Date(year, month - 1, day);
  if (Number.isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  return age;
}

/**
 * Mandatory-field validation for a household head.
 * Returns an Arabic error message or null when the input is acceptable.
 */
function validateFamilyInput(input) {
  const name = String(input.name || '').trim();
  const nid = normalizeNid(input.national_id);
  const address = String(input.address || '').trim();
  const age = input.age === '' || input.age === undefined || input.age === null
    ? null
    : Number(input.age);

  if (!name) return 'اسم رب الأسرة مطلوب.';
  if (!nid) return 'الرقم القومي مطلوب.';
  const fmt = validateNationalIdFormat(nid);
  if (!fmt.ok) return fmt.msg;
  if (age === null || Number.isNaN(age)) return 'العمر مطلوب (سنوات).';
  if (!Number.isInteger(age) || age < 0 || age > 120) return 'العمر لازم يكون بين 0 و 120 سنة.';
  if (!address) return 'العنوان مطلوب.';
  const derived = ageFromNid(nid);
  if (derived !== null && Math.abs(derived - age) > 2) {
    return `العمر (${age}) غير متوافق مع تاريخ الميلاد في الرقم القومي (حوالي ${derived} سنة).`;
  }
  return null;
}

const FAMILY_COLS = [
  'name', 'national_id', 'age', 'address', 'governorate', 'email', 'phone',
  'children_count', 'family_members', 'income', 'has_disabled', 'has_orphans',
  'eligible', 'priority_score', 'priority_level', 'added_at', 'added_by',
  'mail_status', 'request_status', 'is_pregnant', 'pregnancy_followup',
  'under_5', 'vaccines_complete', 'chronic_disease', 'malnutrition',
  'treatment_cost', 'last_pregnancy_visit', 'last_vaccine', 'last_delivery',
  'health_score', 'health_level',
  'has_insurance', 'family_type', 'children_multiples', 'pregnancy_kind', 'fetus_count'
];

function insertFamilyRow(data) {
  const db = getDb();
  const row = {};
  for (const c of FAMILY_COLS) row[c] = data[c] === undefined ? null : data[c];
  const cols = FAMILY_COLS.filter(c => row[c] !== null && row[c] !== undefined);
  const placeholders = cols.map(() => '?').join(', ');
  try {
    const stmt = db.prepare(`INSERT INTO families (${cols.join(', ')}) VALUES (${placeholders})`);
    const info = stmt.run(...cols.map(c => row[c]));
    return { ok: true, id: Number(info.lastInsertRowid) };
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return { ok: false, msg: 'الرقم القومي ده مسجّل بالفعل في قاعدة البيانات.' };
    return { ok: false, msg: 'تعذّر الحفظ في قاعدة البيانات.' };
  }
}

function createFamily(data) {
  const err = validateFamilyInput(data);
  if (err) return { ok: false, msg: err };
  const clean = { ...data, national_id: normalizeNid(data.national_id) };
  return insertFamilyRow(clean);
}

/**
 * Bulk-import path for historical rows. The pre-existing dataset carries
 * 17-digit external identifiers instead of standard 14-digit national IDs,
 * so format validation is relaxed here (uniqueness still enforced) while new
 * registrations through createFamily() must pass full validation.
 */
function importFamily(data) {
  const nid = String(data.national_id || '').trim();
  if (!nid) return { ok: false, msg: 'الرقم القومي مطلوب.' };
  if (!String(data.name || '').trim()) return { ok: false, msg: 'اسم رب الأسرة مطلوب.' };
  return insertFamilyRow({ ...data, national_id: nid });
}

function getFamilyByNid(nid) {
  return getDb().prepare('SELECT * FROM families WHERE national_id = ?').get(normalizeNid(nid)) || null;
}

function getFamilyById(id) {
  return getDb().prepare('SELECT * FROM families WHERE id = ?').get(id) || null;
}

function countFamilies() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM families').get().n;
}

/* ---------------- toy shop: catalog, purchase + rentals ---------------- */

const SHOP_SEED_PRODUCTS = [
  { name: 'مكعبات البناء الملونة', description: 'مجموعة مكعبات آمنة لتنمية الخيال والمهارات الحركية.', category: 'تعليمي', age_min: 3, age_max: 8, sale_price: 320, rental_daily_price: 25, sale_stock: 8, rental_stock: 3, image_url: '/static/img/toys/building-blocks.jpeg' },
  { name: 'أرنب قماشي ناعم', description: 'لعبة قماشية لطيفة مناسبة للعب اليومي.', category: 'دمى وألعاب قماشية', age_min: 0, age_max: 5, sale_price: 240, rental_daily_price: 20, sale_stock: 10, rental_stock: 4, image_url: '/static/img/toys/soft-bunny.jpeg' },
  { name: 'أحجية الأشكال', description: 'لوحة أشكال تساعد الطفل على التعرف إلى الألوان والأحجام.', category: 'تعليمي', age_min: 2, age_max: 6, sale_price: 180, rental_daily_price: 15, sale_stock: 12, rental_stock: 4, image_url: '/static/img/toys/shape-puzzle.jpeg' },
  { name: 'مطبخ اللعب الصغير', description: 'مجموعة لعب تمثيلي لتشجيع المشاركة والخيال.', category: 'لعب تمثيلي', age_min: 3, age_max: 8, sale_price: 680, rental_daily_price: 55, sale_stock: 4, rental_stock: 2, image_url: '/static/img/toys/play-kitchen.jpeg' },
  { name: 'كتاب القماش الحسي', description: 'كتاب أنشطة آمن بملمس وألوان متنوعة للصغار.', category: 'رضّع وحواس', age_min: 0, age_max: 3, sale_price: 210, rental_daily_price: 18, sale_stock: 9, rental_stock: 3, image_url: '/static/img/toys/sensory-cloth-book.webp' },
  { name: 'مسار السيارات الخشبي', description: 'مسار بسيط للسيارات يساعد على التنسيق والتركيز.', category: 'ألعاب حركة', age_min: 3, age_max: 9, sale_price: 450, rental_daily_price: 36, sale_stock: 5, rental_stock: 2, image_url: '/static/img/toys/wooden-car-track.jpeg' }
];

function seedShopProducts() {
  const db = getDb();
  const existing = db.prepare('SELECT COUNT(*) AS n FROM shop_products').get().n;
  if (existing) {
    const updateMissingPhoto = db.prepare(`UPDATE shop_products SET image_url = ?
      WHERE name = ? AND (image_url IS NULL OR image_url = '' OR image_url LIKE 'bi-%')`);
    for (const p of SHOP_SEED_PRODUCTS) updateMissingPhoto.run(p.image_url, p.name);
    return;
  }
  const insert = db.prepare(`INSERT INTO shop_products
    (name, description, category, age_min, age_max, sale_price, rental_daily_price, sale_stock, rental_stock, image_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  try {
    for (const p of SHOP_SEED_PRODUCTS) insert.run(p.name, p.description, p.category, p.age_min, p.age_max, p.sale_price, p.rental_daily_price, p.sale_stock, p.rental_stock, p.image_url);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw err;
  }
}

function listShopProducts({ search = '', category = '' } = {}) {
  seedShopProducts();
  const terms = [];
  const values = [];
  if (search) { terms.push('(name LIKE ? OR description LIKE ?)'); values.push(`%${search}%`, `%${search}%`); }
  if (category) { terms.push('category = ?'); values.push(category); }
  return getDb().prepare(`SELECT * FROM shop_products WHERE active = 1 ${terms.length ? `AND ${terms.join(' AND ')}` : ''} ORDER BY category, name`).all(...values);
}

function getShopCategories() {
  seedShopProducts();
  return getDb().prepare('SELECT DISTINCT category FROM shop_products WHERE active = 1 ORDER BY category').all().map((r) => r.category);
}

function createShopOrder({ customer_username, customer_name, phone, address, items }) {
  const db = getDb();
  if (!Array.isArray(items) || !items.length) return { ok: false, msg: 'السلة فارغة.' };
  if (!String(customer_name || '').trim() || !String(phone || '').trim() || !String(address || '').trim()) {
    return { ok: false, msg: 'الاسم ورقم الهاتف والعنوان مطلوبون لإتمام الطلب.' };
  }
  const orderInsert = db.prepare(`INSERT INTO shop_orders
    (customer_username, customer_name, phone, address, total)
    VALUES (?, ?, ?, ?, 0)`);
  const itemInsert = db.prepare(`INSERT INTO shop_order_items
    (order_id, product_id, product_name, item_kind, quantity, unit_price, rental_days, rental_due_date, rental_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const stockSale = db.prepare('UPDATE shop_products SET sale_stock = sale_stock - ? WHERE id = ? AND active = 1 AND sale_stock >= ?');
  const stockRent = db.prepare('UPDATE shop_products SET rental_stock = rental_stock - ? WHERE id = ? AND active = 1 AND rental_stock >= ?');
  let total = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const order = orderInsert.run(String(customer_username), String(customer_name).trim(), String(phone).trim(), String(address).trim());
    const orderId = Number(order.lastInsertRowid);
    for (const item of items) {
      const productId = Number(item.product_id);
      const quantity = Number(item.quantity);
      const kind = item.item_kind;
      const days = kind === 'إيجار' ? Number(item.rental_days) : 0;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20 || !['شراء', 'إيجار'].includes(kind) ||
          (kind === 'إيجار' && (!Number.isInteger(days) || days < 1 || days > 30))) {
        throw new Error('بيانات أحد المنتجات أو مدة الإيجار غير صحيحة.');
      }
      const product = db.prepare('SELECT * FROM shop_products WHERE id = ? AND active = 1').get(productId);
      if (!product) throw new Error('أحد المنتجات لم يعد متاحًا.');
      const price = kind === 'شراء' ? Number(product.sale_price) : Number(product.rental_daily_price) * days;
      const stock = kind === 'شراء' ? stockSale.run(quantity, productId, quantity) : stockRent.run(quantity, productId, quantity);
      if (Number(stock.changes) !== 1) throw new Error(`المخزون غير كافٍ للمنتج: ${product.name}`);
      const dueDate = kind === 'إيجار' ? new Date(Date.now() + days * 86400000).toISOString().slice(0, 10) : '';
      const rentalStatus = kind === 'إيجار' ? 'بانتظار التسليم' : '';
      itemInsert.run(orderId, productId, product.name, kind, quantity, price / quantity, days, dueDate, rentalStatus);
      total += price * quantity;
    }
    db.prepare('UPDATE shop_orders SET total = ? WHERE id = ?').run(total, orderId);
    db.exec('COMMIT');
    return { ok: true, id: orderId, total };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already closed */ }
    return { ok: false, msg: err.message || 'تعذّر إتمام الطلب.' };
  }
}

function listShopOrders(username, isAdmin = false) {
  const db = getDb();
  const orders = isAdmin
    ? db.prepare('SELECT * FROM shop_orders ORDER BY id DESC').all()
    : db.prepare('SELECT * FROM shop_orders WHERE customer_username = ? ORDER BY id DESC').all(username);
  const getItems = db.prepare('SELECT * FROM shop_order_items WHERE order_id = ? ORDER BY id');
  return orders.map((order) => ({ ...order, items: getItems.all(order.id) }));
}

function updateShopRentalStatus(itemId, status) {
  const statuses = ['بانتظار التسليم', 'تم التسليم', 'تم الإرجاع', 'متأخر'];
  if (!statuses.includes(status)) return { ok: false, msg: 'حالة الإيجار غير صحيحة.' };
  const db = getDb();
  const item = db.prepare('SELECT * FROM shop_order_items WHERE id = ? AND item_kind = ?').get(itemId, 'إيجار');
  if (!item) return { ok: false, msg: 'طلب الإيجار غير موجود.' };
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = item.rental_status;
    db.prepare('UPDATE shop_order_items SET rental_status = ? WHERE id = ?').run(status, itemId);
    if (status === 'تم الإرجاع' && previous !== 'تم الإرجاع') {
      db.prepare('UPDATE shop_products SET rental_stock = rental_stock + ? WHERE id = ?').run(item.quantity, item.product_id);
    }
    if (previous === 'تم الإرجاع' && status !== 'تم الإرجاع') {
      const stock = db.prepare('UPDATE shop_products SET rental_stock = rental_stock - ? WHERE id = ? AND rental_stock >= ?').run(item.quantity, item.product_id, item.quantity);
      if (Number(stock.changes) !== 1) throw new Error('المخزون المتاح لا يكفي لإعادة فتح هذا الإيجار.');
    }
    db.exec('COMMIT');
    return { ok: true };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already closed */ }
    return { ok: false, msg: err.message };
  }
}

function listAllShopProducts() {
  seedShopProducts();
  return getDb().prepare('SELECT * FROM shop_products ORDER BY id DESC').all();
}

function saveShopProduct(input) {
  const name = String(input.name || '').trim();
  const description = String(input.description || '').trim().slice(0, 1000);
  const category = String(input.category || 'ألعاب أطفال').trim().slice(0, 60);
  const minAge = Number(input.age_min);
  const maxAge = Number(input.age_max);
  const salePrice = Number(input.sale_price);
  const rentPrice = Number(input.rental_daily_price);
  const saleStock = Number(input.sale_stock);
  const rentStock = Number(input.rental_stock);
  const requestedImage = String(input.image_url || '').trim();
  const imageUrl = (/^\/shop\/images\/[a-f0-9]{36}\.jpg$/.test(requestedImage) || /^\/static\/img\/toys\/[a-z0-9-]+\.(?:jpe?g|webp)$/.test(requestedImage))
    ? requestedImage
    : String(requestedImage || 'bi-gift').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
  if (!name || !category || ![minAge, maxAge, salePrice, rentPrice, saleStock, rentStock].every(Number.isFinite) ||
      ![minAge, maxAge, saleStock, rentStock].every(Number.isInteger) || minAge < 0 || maxAge < minAge || maxAge > 18 ||
      salePrice < 0 || rentPrice < 0 || saleStock < 0 || rentStock < 0) {
    return { ok: false, msg: 'راجعي الاسم والفئة والأعمار والأسعار والمخزون.' };
  }
  getDb().prepare(`INSERT INTO shop_products
    (name, description, category, age_min, age_max, sale_price, rental_daily_price, sale_stock, rental_stock, image_url, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(name, description, category, minAge, maxAge, salePrice, rentPrice, saleStock, rentStock, imageUrl);
  return { ok: true };
}

function setShopProductActive(id, active) {
  const result = getDb().prepare('UPDATE shop_products SET active = ? WHERE id = ?').run(active ? 1 : 0, Number(id));
  return Number(result.changes) === 1;
}

function updateShopProductImage(id, imageUrl) {
  const result = getDb().prepare('UPDATE shop_products SET image_url = ? WHERE id = ?')
    .run(String(imageUrl || ''), Number(id));
  return Number(result.changes) === 1;
}

/* ---------------- community: parent-to-parent discussions ---------------- */

const COMMUNITY_CATEGORIES = [
  'تربية الأطفال', 'الحمل والتوائم', 'الصحة والتغذية', 'أنشطة وألعاب', 'الدعم والأسرة', 'أسئلة عامة'
];

function listCommunityPosts({ category = '', search = '', username = '', includeHidden = false } = {}) {
  const where = includeHidden ? ['1 = 1'] : ["p.status = 'visible'"];
  const params = [];
  if (category && COMMUNITY_CATEGORIES.includes(category)) { where.push('p.category = ?'); params.push(category); }
  if (search) { where.push('(p.title LIKE ? OR p.body LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  return getDb().prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM community_replies r WHERE r.post_id = p.id AND r.status = 'visible') AS reply_count,
      (SELECT COUNT(*) FROM community_likes l WHERE l.post_id = p.id) AS like_count,
      EXISTS(SELECT 1 FROM community_likes l WHERE l.post_id = p.id AND l.username = ?) AS liked_by_me
    FROM community_posts p WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC, p.id DESC`)
    .all(username, ...params);
}

function getCommunityPost(id, { includeHidden = false } = {}) {
  const post = getDb().prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM community_replies r WHERE r.post_id = p.id AND r.status = 'visible') AS reply_count,
      (SELECT COUNT(*) FROM community_likes l WHERE l.post_id = p.id) AS like_count
    FROM community_posts p WHERE p.id = ? ${includeHidden ? '' : "AND p.status = 'visible'"}`).get(Number(id));
  if (!post) return null;
  post.replies = getDb().prepare(`SELECT * FROM community_replies WHERE post_id = ? ${includeHidden ? '' : "AND status = 'visible'"} ORDER BY created_at ASC, id ASC`).all(post.id);
  return post;
}

function createCommunityPost({ username, authorName, category, title, body }) {
  const cleanTitle = String(title || '').trim();
  const cleanBody = String(body || '').trim();
  if (!cleanTitle || cleanTitle.length < 5 || cleanTitle.length > 120) return { ok: false, msg: 'عنوان الموضوع يجب أن يكون بين 5 و120 حرفًا.' };
  if (!cleanBody || cleanBody.length < 10 || cleanBody.length > 3000) return { ok: false, msg: 'نص الموضوع يجب أن يكون بين 10 و3000 حرف.' };
  if (!COMMUNITY_CATEGORIES.includes(category)) return { ok: false, msg: 'اختاري قسمًا صحيحًا للموضوع.' };
  const result = getDb().prepare(`INSERT INTO community_posts (author_username, author_name, category, title, body)
    VALUES (?, ?, ?, ?, ?)`).run(String(username), String(authorName).trim().slice(0, 100), category, cleanTitle, cleanBody);
  return { ok: true, id: Number(result.lastInsertRowid) };
}

function addCommunityReply({ postId, username, authorName, body }) {
  const cleanBody = String(body || '').trim();
  if (!cleanBody || cleanBody.length < 2 || cleanBody.length > 1500) return { ok: false, msg: 'الرد يجب أن يكون بين حرفين و1500 حرف.' };
  const post = getDb().prepare("SELECT id FROM community_posts WHERE id = ? AND status = 'visible'").get(Number(postId));
  if (!post) return { ok: false, msg: 'الموضوع غير موجود أو مخفي.' };
  const result = getDb().prepare(`INSERT INTO community_replies (post_id, author_username, author_name, body)
    VALUES (?, ?, ?, ?)`).run(Number(postId), String(username), String(authorName).trim().slice(0, 100), cleanBody);
  return { ok: true, id: Number(result.lastInsertRowid) };
}

function toggleCommunityLike(postId, username) {
  const db = getDb();
  const id = Number(postId);
  if (!db.prepare("SELECT id FROM community_posts WHERE id = ? AND status = 'visible'").get(id)) return { ok: false, msg: 'الموضوع غير موجود.' };
  const existing = db.prepare('SELECT 1 FROM community_likes WHERE post_id = ? AND username = ?').get(id, String(username));
  if (existing) db.prepare('DELETE FROM community_likes WHERE post_id = ? AND username = ?').run(id, String(username));
  else db.prepare('INSERT INTO community_likes (post_id, username) VALUES (?, ?)').run(id, String(username));
  return { ok: true, liked: !existing };
}

function deleteCommunityPost(id, username, isAdmin = false) {
  const db = getDb();
  const post = db.prepare('SELECT author_username FROM community_posts WHERE id = ?').get(Number(id));
  if (!post) return { ok: false, msg: 'الموضوع غير موجود.' };
  if (!isAdmin && post.author_username !== String(username)) return { ok: false, msg: 'يمكنك حذف موضوعك أنت فقط.' };
  db.prepare('DELETE FROM community_posts WHERE id = ?').run(Number(id));
  return { ok: true };
}

function deleteCommunityReply(id, username, isAdmin = false) {
  const db = getDb();
  const reply = db.prepare('SELECT author_username FROM community_replies WHERE id = ?').get(Number(id));
  if (!reply) return { ok: false, msg: 'الرد غير موجود.' };
  if (!isAdmin && reply.author_username !== String(username)) return { ok: false, msg: 'يمكنك حذف ردك أنت فقط.' };
  db.prepare('DELETE FROM community_replies WHERE id = ?').run(Number(id));
  return { ok: true };
}

function moderateCommunityPost(id, status) {
  if (!['visible', 'hidden'].includes(status)) return { ok: false, msg: 'حالة الإشراف غير صحيحة.' };
  const result = getDb().prepare('UPDATE community_posts SET status = ?, updated_at = strftime(\'%Y-%m-%d %H:%M\', \'now\') WHERE id = ?')
    .run(status, Number(id));
  return Number(result.changes) === 1 ? { ok: true } : { ok: false, msg: 'الموضوع غير موجود.' };
}

/* ---------------- children + twins ---------------- */

function nextTwinGroupId() {
  const r = getDb().prepare('SELECT MAX(twin_group_id) AS m FROM children').get();
  return (r && r.m ? r.m : 0) + 1;
}

function validateChildInput(input) {
  const name = String(input.name || '').trim();
  if (!name) return 'اسم الطفل مطلوب.';
  const isTwin = input.is_twin === 1 || input.is_twin === true || input.is_twin === '1' ? 1 : 0;
  const twinType = input.twin_type || null;
  if (isTwin && twinType && !TWIN_TYPES.includes(twinType)) {
    return 'نوع التوأم لازم يكون: متماثل أو غير متماثل أو أخرى.';
  }
  return null;
}

function addChild(familyId, input) {
  const db = getDb();
  const err = validateChildInput(input);
  if (err) return { ok: false, msg: err };
  const isTwin = input.is_twin === 1 || input.is_twin === true || input.is_twin === '1' ? 1 : 0;
  let groupId = input.twin_group_id === undefined || input.twin_group_id === null || input.twin_group_id === ''
    ? null
    : Number(input.twin_group_id);
  if (isTwin && !groupId) groupId = nextTwinGroupId(); // first twin opens a new group
  if (!isTwin) groupId = null;
  const twinType = isTwin ? (input.twin_type || 'other') : null;

  const stmt = db.prepare(
    `INSERT INTO children (family_id, name, birth_date, gender, national_id,
      birth_certificate_no, birth_certificate_file, relation,
      is_twin, twin_group_id, twin_type, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const info = stmt.run(
    familyId,
    String(input.name).trim(),
    input.birth_date || '',
    input.gender || '',
    normalizeNid(input.national_id || ''),
    String(input.birth_certificate_no || '').trim(),
    input.birth_certificate_file || '',
    input.relation || 'ابن/ابنة',
    isTwin, groupId, twinType,
    input.notes || ''
  );
  return { ok: true, id: Number(info.lastInsertRowid), twin_group_id: groupId };
}

function getChildren(familyId) {
  return getDb().prepare('SELECT * FROM children WHERE family_id = ? ORDER BY id').all(familyId);
}

/**
 * Twin groups for a family: [{ twin_group_id, twin_type, twin_type_label, members: [...] }].
 * This is how the backend knows "which kind of twins" and their relation.
 */
function getTwinGroups(familyId) {
  const rows = getDb().prepare(
    'SELECT * FROM children WHERE family_id = ? AND is_twin = 1 AND twin_group_id IS NOT NULL ORDER BY twin_group_id, id'
  ).all(familyId);
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.twin_group_id)) {
      groups.set(r.twin_group_id, {
        twin_group_id: r.twin_group_id,
        twin_type: r.twin_type || 'other',
        twin_type_label: TWIN_LABELS[r.twin_type] || TWIN_LABELS.other,
        members: []
      });
    }
    groups.get(r.twin_group_id).members.push(r);
  }
  return [...groups.values()];
}

/* ---------------- documents ---------------- */

function addDocument({ owner_kind, owner_id, doc_type, doc_number = '', file_path = '', uploaded_by = '' }) {
  if (owner_kind !== 'family' && owner_kind !== 'child') {
    return { ok: false, msg: 'نوع المالك غير صحيح.' };
  }
  const db = getDb();
  const info = db.prepare(
    `INSERT INTO documents (owner_kind, owner_id, doc_type, doc_number, file_path, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(owner_kind, owner_id, doc_type, doc_number, file_path, uploaded_by);
  return { ok: true, id: Number(info.lastInsertRowid) };
}

function getDocuments(ownerKind, ownerId) {
  return getDb().prepare(
    'SELECT * FROM documents WHERE owner_kind = ? AND owner_id = ? ORDER BY id'
  ).all(ownerKind, ownerId);
}

/** Health-insurance readiness: the 3 required insurance IDs. */
function insuranceStatus(familyId) {
  const docs = getDocuments('family', familyId);
  const have = new Set(docs.filter(d => INSURANCE_DOCS.includes(d.doc_type)).map(d => d.doc_type));
  const missing = INSURANCE_DOCS.filter(t => !have.has(t));
  const hasIdCard = docs.some(d => d.doc_type === 'national_id_card');
  return {
    count: have.size,
    required: INSURANCE_DOCS.length,
    complete: missing.length === 0,
    missing,
    missing_labels: missing.map(t => DOC_LABELS[t]),
    has_id_card: hasIdCard
  };
}

/* ---------------- pregnancies ---------------- */

function getCurrentPregnancy(familyId) {
  return getDb().prepare(
    'SELECT * FROM pregnancies WHERE family_id = ? AND is_current = 1 ORDER BY id DESC LIMIT 1'
  ).get(familyId) || null;
}

function setPregnancy(familyId, input) {
  const db = getDb();
  const status = input.status || 'pregnant';
  if (!PREGNANCY_STATUS.includes(status)) return { ok: false, msg: 'حالة الحمل غير صحيحة.' };
  const twins = input.twins_expected === 1 || input.twins_expected === true || input.twins_expected === '1' ? 1 : 0;
  const twinType = twins ? (input.twin_type || 'other') : null;
  if (twins && !TWIN_TYPES.includes(twinType)) return { ok: false, msg: 'نوع التوأم غير صحيح.' };

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE pregnancies SET is_current = 0 WHERE family_id = ?').run(familyId);
    const info = db.prepare(
      `INSERT INTO pregnancies (family_id, status, is_current, expected_delivery, last_visit, followup, twins_expected, twin_type, notes, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M', 'now'))`
    ).run(
      familyId, status,
      input.expected_delivery || '',
      input.last_visit || '',
      input.followup || 'لا',
      twins, twinType,
      input.notes || ''
    );
    db.prepare('UPDATE families SET is_pregnant = ? WHERE id = ?')
      .run(status === 'pregnant' ? 'نعم' : 'لا', familyId);
    db.exec('COMMIT');
    return { ok: true, id: Number(info.lastInsertRowid) };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already closed */ }
    return { ok: false, msg: 'تعذّر حفظ بيانات الحمل.' };
  }
}

function getPregnancies(familyId) {
  return getDb().prepare('SELECT * FROM pregnancies WHERE family_id = ? ORDER BY id DESC').all(familyId);
}

/**
 * Link already-created children as one twin group (used when the mother
 * declares existing multiples at registration but birth dates are unknown).
 */
function linkChildrenAsTwins(childIds, twinType = 'other') {
  const ids = (Array.isArray(childIds) ? childIds : []).filter(Number.isInteger);
  if (ids.length < 2) return { ok: false, twin_group_id: null };
  const type = TWIN_TYPES.includes(twinType) ? twinType : 'other';
  const groupId = nextTwinGroupId();
  const db = getDb();
  const stmt = db.prepare('UPDATE children SET is_twin = 1, twin_group_id = ?, twin_type = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const id of ids) stmt.run(groupId, type, id);
    db.exec('COMMIT');
  } catch {
    try { db.exec('ROLLBACK'); } catch { /* already closed */ }
    return { ok: false, twin_group_id: null };
  }
  return { ok: true, twin_group_id: groupId, twin_type: type };
}

/**
 * Twin auto-detection: children of one family sharing a birth_date belong to
 * the same birth event. When 2+ share a date they are linked as twins
 * (shared twin_group_id, is_twin = 1). The kind comes from the current
 * pregnancy record when present, otherwise 'other' (unknown yet).
 */
function detectAndLinkTwins(familyId, birthDate) {
  const db = getDb();
  if (!birthDate) return { twins: false, count: 0, twin_group_id: null };
  const sibs = db.prepare(
    'SELECT * FROM children WHERE family_id = ? AND birth_date = ? ORDER BY id'
  ).all(familyId, birthDate);
  if (sibs.length < 2) return { twins: false, count: sibs.length, twin_group_id: null };

  let groupId = sibs.find(s => s.twin_group_id)?.twin_group_id || null;
  if (!groupId) groupId = nextTwinGroupId();
  const preg = getCurrentPregnancy(familyId);
  const kind = (preg && preg.twins_expected === 1 && preg.twin_type) ? preg.twin_type : 'other';

  db.exec('BEGIN');
  try {
    const stmt = db.prepare('UPDATE children SET is_twin = 1, twin_group_id = ?, twin_type = ? WHERE id = ?');
    for (const s of sibs) stmt.run(groupId, s.twin_type || kind, s.id);
    db.exec('COMMIT');
  } catch {
    try { db.exec('ROLLBACK'); } catch { /* already closed */ }
    return { twins: true, count: sibs.length, twin_group_id: null };
  }
  return { twins: true, count: sibs.length, twin_group_id: groupId, twin_type: kind };
}

/**
 * Everything the backend knows about one customer in a single object.
 * customer_kind is 'pregnant' when she is still pregnant, else 'standard'.
 */
function familySummary(familyId) {
  const family = getFamilyById(familyId);
  if (!family) return null;
  const children = getChildren(familyId);
  const twins = getTwinGroups(familyId);
  const pregnancy = getCurrentPregnancy(familyId);
  const stillPregnant = Boolean(pregnancy && pregnancy.status === 'pregnant')
    || family.is_pregnant === 'نعم';
  const docs = getDocuments('family', familyId);
  const birthCerts = children.filter(c => c.birth_certificate_no).length;
  return {
    family,
    customer_kind: stillPregnant ? 'pregnant' : 'standard',
    customer_kind_label: stillPregnant ? 'حامل (متابعة خاصة)' : 'غير حامل',
    still_pregnant: stillPregnant,
    pregnancy,
    children,
    children_count: children.length,
    birth_certificates_count: birthCerts,
    twins,
    has_twins: twins.length > 0,
    documents: docs,
    insurance: insuranceStatus(familyId)
  };
}

module.exports = {
  TWIN_TYPES,
  TWIN_LABELS,
  PREGNANCY_STATUS,
  INSURANCE_DOCS,
  DOC_LABELS,
  ageFromNid,
  validateFamilyInput,
  createFamily,
  importFamily,
  getFamilyByNid,
  getFamilyById,
  countFamilies,
  nextTwinGroupId,
  validateChildInput,
  addChild,
  getChildren,
  getTwinGroups,
  addDocument,
  getDocuments,
  insuranceStatus,
  getCurrentPregnancy,
  setPregnancy,
  getPregnancies,
  detectAndLinkTwins,
  linkChildrenAsTwins,
  familySummary,
  seedShopProducts,
  listShopProducts,
  getShopCategories,
  createShopOrder,
  listShopOrders,
  updateShopRentalStatus,
  listAllShopProducts,
  saveShopProduct,
  setShopProductActive,
  updateShopProductImage,
  COMMUNITY_CATEGORIES,
  listCommunityPosts,
  getCommunityPost,
  createCommunityPost,
  addCommunityReply,
  toggleCommunityLike,
  deleteCommunityPost,
  deleteCommunityReply,
  moderateCommunityPost
};
