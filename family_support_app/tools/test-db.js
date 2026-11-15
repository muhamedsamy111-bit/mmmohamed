'use strict';

/**
 * DB layer verification: mandatory fields, twins + relation, pregnancy flag,
 * insurance docs, summary. Uses a scratch database, never touches app data.
 * Run:  node tools/test-db.js
 */

process.env.APP_DB = '/tmp/opencode/test-app.db';

const fs = require('fs');
try { fs.unlinkSync('/tmp/opencode/test-app.db'); } catch { /* fresh */ }

const { open, close, getDb } = require('../src/db/index');
const m = require('../src/db/models');

let pass = 0;
let fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}

open();
const db = getDb();

// 1. mandatory validation
check('reject empty name', m.validateFamilyInput({ name: '', national_id: '29801011234567', age: 28, address: 'x' }) !== null);
check('reject bad nid', m.validateFamilyInput({ name: 'أم', national_id: '123', age: 28, address: 'x' }) !== null);
check('reject missing age', m.validateFamilyInput({ name: 'أم', national_id: '29801011234567', address: 'x' }) !== null);
check('reject missing address', m.validateFamilyInput({ name: 'أم', national_id: '29801011234567', age: 28, address: '' }) !== null);
check('reject age/nid mismatch', m.validateFamilyInput({ name: 'أم', national_id: '29801011234567', age: 5, address: 'x' }) !== null);
check('accept valid mother', m.validateFamilyInput({ name: 'أم أحمد', national_id: '29801011234567', age: 28, address: 'أسيوط' }) === null);

// 2. create mother + children incl. twins
const mom = m.createFamily({ name: 'أم أحمد', national_id: '29801011234567', age: 28, address: 'أسيوط - مركز الفتح', governorate: 'أسيوط', phone: '01001234567' });
check('create mother', mom.ok);
const fid = mom.id;

const c1 = m.addChild(fid, { name: 'أحمد', birth_date: '2020-05-01', gender: 'ذكر', birth_certificate_no: 'BC-1001' });
check('add singleton child', c1.ok && c1.twin_group_id === null);

const t1 = m.addChild(fid, { name: 'حسن', birth_date: '2024-02-10', gender: 'ذكر', is_twin: 1, twin_type: 'identical', birth_certificate_no: 'BC-2001' });
check('add first twin opens group', t1.ok && t1.twin_group_id > 0);
const t2 = m.addChild(fid, { name: 'حسين', birth_date: '2024-02-10', gender: 'ذكر', is_twin: 1, twin_type: 'identical', twin_group_id: t1.twin_group_id, birth_certificate_no: 'BC-2002' });
check('add second twin joins group', t2.ok && t2.twin_group_id === t1.twin_group_id);

const bad = m.addChild(fid, { name: '', is_twin: 1 });
check('reject nameless child', !bad.ok);

const groups = m.getTwinGroups(fid);
check('one twin group', groups.length === 1);
check('group has 2 members', groups[0] && groups[0].members.length === 2);
check('twin kind is identical/متماثل', groups[0] && groups[0].twin_type === 'identical' && groups[0].twin_type_label === 'متماثل');

// 3. documents: id card + 3 insurance ids + child birth certs
m.addDocument({ owner_kind: 'family', owner_id: fid, doc_type: 'national_id_card', doc_number: '29801011234567', uploaded_by: 'admin' });
m.addDocument({ owner_kind: 'family', owner_id: fid, doc_type: 'insurance_1', doc_number: 'INS-1' });
m.addDocument({ owner_kind: 'family', owner_id: fid, doc_type: 'insurance_2', doc_number: 'INS-2' });
m.addDocument({ owner_kind: 'child', owner_id: c1.id, doc_type: 'birth_certificate', doc_number: 'BC-1001' });
let ins = m.insuranceStatus(fid);
check('insurance incomplete (2/3)', ins.count === 2 && !ins.complete);
m.addDocument({ owner_kind: 'family', owner_id: fid, doc_type: 'insurance_3', doc_number: 'INS-3' });
ins = m.insuranceStatus(fid);
check('insurance complete (3/3)', ins.count === 3 && ins.complete && ins.has_id_card);

// 4. pregnancy -> customer kind flips
let s0 = m.familySummary(fid);
check('not pregnant -> standard', s0.customer_kind === 'standard' && !s0.has_twins === false);
const preg = m.setPregnancy(fid, { status: 'pregnant', expected_delivery: '2026-08-01', followup: 'نعم', twins_expected: 1, twin_type: 'fraternal' });
check('set pregnancy with fraternal twins', preg.ok);
const s1 = m.familySummary(fid);
check('still pregnant -> pregnant kind', s1.customer_kind === 'pregnant' && s1.still_pregnant);
check('summary counts (3 children, 3 birth certs)', s1.children_count === 3 && s1.birth_certificates_count === 3);

// 5. duplicate nid blocked
const dup = m.createFamily({ name: 'تكرار', national_id: '29801011234567', age: 28, address: 'x' });
check('duplicate nid rejected', !dup.ok);

// 6. toy store: purchase, rental, stock and return workflow
const catalog = m.listShopProducts();
check('toy shop seeds a catalog', catalog.length >= 5);
const toy = catalog[0];
const beforeSaleStock = Number(toy.sale_stock);
const beforeRentalStock = Number(toy.rental_stock);
const shopOrder = m.createShopOrder({
  customer_username: 'citizen', customer_name: 'أم أحمد', phone: '01000000000', address: 'أسيوط',
  items: [
    { product_id: toy.id, item_kind: 'شراء', quantity: 1 },
    { product_id: toy.id, item_kind: 'إيجار', quantity: 1, rental_days: 3 }
  ]
});
check('create combined purchase and rental order', shopOrder.ok);
const shopItems = db.prepare('SELECT * FROM shop_order_items WHERE order_id = ? ORDER BY id').all(shopOrder.id);
check('shop order has purchase and rental lines', shopItems.length === 2 && shopItems[0].item_kind === 'شراء' && shopItems[1].item_kind === 'إيجار');
check('purchase/rental prices calculated', shopOrder.total === Number(toy.sale_price) + (Number(toy.rental_daily_price) * 3));
check('sale and rental stocks decremented',
  Number(db.prepare('SELECT sale_stock FROM shop_products WHERE id = ?').get(toy.id).sale_stock) === beforeSaleStock - 1 &&
  Number(db.prepare('SELECT rental_stock FROM shop_products WHERE id = ?').get(toy.id).rental_stock) === beforeRentalStock - 1);
check('mark returned replenishes rental stock', m.updateShopRentalStatus(shopItems[1].id, 'تم الإرجاع').ok &&
  Number(db.prepare('SELECT rental_stock FROM shop_products WHERE id = ?').get(toy.id).rental_stock) === beforeRentalStock);
check('customer order history is scoped to username', m.listShopOrders('citizen').some((o) => o.id === shopOrder.id) && !m.listShopOrders('other').some((o) => o.id === shopOrder.id));
const insufficient = m.createShopOrder({
  customer_username: 'citizen', customer_name: 'أم أحمد', phone: '01000000000', address: 'أسيوط',
  items: [{ product_id: toy.id, item_kind: 'شراء', quantity: 999 }]
});
check('insufficient stock rolls back order', !insufficient.ok && !m.listShopOrders('citizen').some((o) => o.id === insufficient.id));

// 7. parent community: topics, replies, reactions and moderation
const topic = m.createCommunityPost({
  username: 'citizen', authorName: 'أم أحمد', category: 'تربية الأطفال',
  title: 'كيف أنظم وقتي مع أطفالي؟', body: 'أبحث عن نصائح عملية لتنظيم اليوم ومشاركة الخبرات.'
});
check('create community topic', topic.ok);
const reply = m.addCommunityReply({ postId: topic.id, username: 'helper', authorName: 'مشاركة داعمة', body: 'جربي وضع روتين بسيط ومرن يناسب أسرتك.' });
check('add a reply to topic', reply.ok);
check('react to a topic and toggle reaction off', m.toggleCommunityLike(topic.id, 'helper').liked && !m.toggleCommunityLike(topic.id, 'helper').liked);
check('topic shows reply and correct reply count', m.getCommunityPost(topic.id).replies.length === 1 && m.getCommunityPost(topic.id).reply_count === 1);
check('reject deletion of another member reply', !m.deleteCommunityReply(reply.id, 'citizen').ok);
check('reply author may delete own reply', m.deleteCommunityReply(reply.id, 'helper').ok);
check('reject invalid community moderation status', !m.moderateCommunityPost(topic.id, 'deleted').ok);
check('moderator can hide topic from public list', m.moderateCommunityPost(topic.id, 'hidden').ok && !m.listCommunityPosts().some((p) => p.id === topic.id));
check('moderator list can include hidden topics', m.listCommunityPosts({ includeHidden: true }).some((p) => p.id === topic.id));
check('moderators can restore hidden topic', m.moderateCommunityPost(topic.id, 'visible').ok && m.listCommunityPosts().some((p) => p.id === topic.id));
check('topic author can delete own topic', m.deleteCommunityPost(topic.id, 'citizen').ok);

console.log(`\n${pass} passed, ${fail} failed`);
close();
process.exit(fail ? 1 : 0);
