'use strict';

const express = require('express');
const path = require('path');
const storage = require('../storage');
const { def } = require('./registry');
const { q, f, file } = require('../helpers/httpx');
const models = require('../db/models');
const { shopImageUpload } = require('../middlewares/upload');
const { saveShopProductImage } = require('../helpers/uploads');

const router = express.Router();
const STAFF = new Set(['admin', 'employee']);
const STORE_ROLES = new Set(['admin', 'employee', 'user']);

function cartFor(req) {
  if (!req.session.shopCart || typeof req.session.shopCart !== 'object') req.session.shopCart = {};
  return req.session.shopCart;
}

function cartDetails(cart) {
  const products = new Map(models.listShopProducts().map((product) => [String(product.id), product]));
  return Object.entries(cart).map(([key, item]) => {
    const product = products.get(String(item.product_id));
    if (!product) return null;
    const unit = item.item_kind === 'شراء' ? Number(product.sale_price) : Number(product.rental_daily_price) * Number(item.rental_days);
    return { key, product, item_kind: item.item_kind, quantity: Number(item.quantity), rental_days: Number(item.rental_days || 0), unit_price: unit, line_total: unit * Number(item.quantity) };
  }).filter(Boolean);
}

function cartTotal(items) {
  return items.reduce((total, item) => total + item.line_total, 0);
}

function roleAllowed(req, res) {
  if (STORE_ROLES.has(req.user.role)) return true;
  res.flashRedirect('/mental/ppd', 'المتجر متاح للمواطنين والموظفين فقط.', 'warning');
  return false;
}

def(router, {
  name: 'shop_browse', path: '/shop',
  handler: async (req, res) => {
    if (!roleAllowed(req, res)) return;
    const search = String(q(req, 'q')).trim().slice(0, 100);
    const category = String(q(req, 'category')).trim().slice(0, 60);
    return res.view('shop.html', {
      products: models.listShopProducts({ search, category }),
      categories: models.getShopCategories(), search, selected_category: category,
      cart_count: Object.values(cartFor(req)).reduce((n, item) => n + Number(item.quantity || 0), 0)
    });
  }
});

def(router, {
  name: 'shop_add', method: 'post', path: '/shop/cart/add',
  handler: async (req, res) => {
    if (!roleAllowed(req, res)) return;
    const productId = Number(f(req, 'product_id'));
    const quantity = Number(f(req, 'quantity', 1));
    const kind = String(f(req, 'item_kind'));
    const days = kind === 'إيجار' ? Number(f(req, 'rental_days')) : 0;
    const product = models.listShopProducts().find((p) => Number(p.id) === productId);
    if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 20 ||
        !['شراء', 'إيجار'].includes(kind) || (kind === 'إيجار' && (!Number.isInteger(days) || days < 1 || days > 30))) {
      return res.flashRedirect('/shop', 'اختاري منتجًا وكمية ومدة إيجار صالحة.', 'danger');
    }
    if (kind === 'شراء' && Number(product.sale_stock) < quantity) return res.flashRedirect('/shop', 'الكمية المطلوبة غير متاحة للبيع حاليًا.', 'warning');
    if (kind === 'إيجار' && Number(product.rental_stock) < quantity) return res.flashRedirect('/shop', 'الكمية المطلوبة غير متاحة للإيجار حاليًا.', 'warning');
    const cart = cartFor(req);
    const key = `${productId}:${kind}:${days}`;
    const nextQuantity = Number(cart[key]?.quantity || 0) + quantity;
    const stock = kind === 'شراء' ? Number(product.sale_stock) : Number(product.rental_stock);
    if (nextQuantity > stock) return res.flashRedirect('/shop', 'الكمية في السلة تتجاوز المخزون المتاح.', 'warning');
    cart[key] = { product_id: productId, item_kind: kind, quantity: nextQuantity, rental_days: days };
    req.session.shopCart = cart;
    return res.flashRedirect('/shop/cart', 'تمت إضافة اللعبة إلى السلة.', 'success');
  }
});

def(router, {
  name: 'shop_cart', method: ['get', 'post'], path: '/shop/cart',
  handler: async (req, res) => {
    if (!roleAllowed(req, res)) return;
    const cart = cartFor(req);
    if (req.method === 'POST') {
      const action = String(f(req, 'action'));
      const key = String(f(req, 'key'));
      if (action === 'remove') delete cart[key];
      req.session.shopCart = cart;
    }
    const items = cartDetails(cart);
    return res.view('shop_cart.html', { items, total: cartTotal(items), cart_count: items.reduce((n, i) => n + i.quantity, 0) });
  }
});

def(router, {
  name: 'shop_checkout', method: 'post', path: '/shop/checkout',
  handler: async (req, res) => {
    if (!roleAllowed(req, res)) return;
    const items = cartDetails(cartFor(req));
    if (!items.length) return res.flashRedirect('/shop/cart', 'السلة فارغة.', 'warning');
    const checked = models.createShopOrder({
      customer_username: req.user.username,
      customer_name: f(req, 'customer_name'),
      phone: f(req, 'phone'),
      address: f(req, 'address'),
      items: items.map((item) => ({ product_id: item.product.id, item_kind: item.item_kind, quantity: item.quantity, rental_days: item.rental_days }))
    });
    if (!checked.ok) return res.flashRedirect('/shop/cart', checked.msg, 'danger');
    req.session.shopCart = {};
    return res.flashRedirect('/shop/orders', `تم تسجيل الطلب رقم ${checked.id} بنجاح. الدفع نقدًا عند الاستلام.`, 'success');
  }
});

def(router, {
  name: 'shop_orders', path: '/shop/orders',
  handler: async (req, res) => {
    if (!roleAllowed(req, res)) return;
    const isStaff = STAFF.has(req.user.role);
    return res.view('shop_orders.html', { orders: models.listShopOrders(req.user.username, isStaff), is_admin: isStaff });
  }
});

def(router, {
  name: 'shop_product_admin', method: ['get', 'post'], path: '/admin/shop/products',
  middleware: [shopImageUpload.single('product_image')],
  handler: async (req, res) => {
    if (req.user.role !== 'admin') return res.flashRedirect('/shop', 'إدارة المتجر للمدير فقط.', 'danger');
    let message = '';
    if (req.method === 'POST') {
      const uploadedFile = file(req, 'product_image');
      const image = await saveShopProductImage(uploadedFile);
      if (!image.ok) {
        message = image.msg;
      } else {
        const result = models.saveShopProduct({ ...(req.body || {}), image_url: image.imageUrl });
        message = result.ok ? 'تمت إضافة اللعبة وصورتها للمخزون.' : result.msg;
        if (!result.ok) storage.remove(path.posix.join('uploads', 'shop', path.posix.basename(image.imageUrl)));
      }
    }
    return res.view('shop_admin.html', { products: models.listAllShopProducts(), message });
  }
});

def(router, {
  name: 'shop_product_image', method: 'get', path: '/shop/images/:filename',
  handler: async (req, res) => {
    if (!roleAllowed(req, res)) return;
    const filename = String(req.params.filename || '');
    if (!/^[a-f0-9]{36}\.jpg$/.test(filename)) return res.status(404).end();
    const key = path.posix.join('uploads', 'shop', filename);
    try {
      const image = await storage.readFile(key);
      return res.type('image/jpeg').set('Cache-Control', 'private, max-age=3600').send(image);
    } catch {
      return res.status(404).end();
    }
  }
});

def(router, {
  name: 'shop_product_toggle', method: 'post', path: '/admin/shop/products/:id/toggle',
  handler: async (req, res) => {
    if (req.user.role !== 'admin') return res.flashRedirect('/shop', 'إدارة المتجر للمدير فقط.', 'danger');
    const active = f(req, 'active') === '1';
    const updated = models.setShopProductActive(req.params.id, active);
    return res.flashRedirect('/admin/shop/products', updated ? 'تم تحديث ظهور المنتج.' : 'المنتج غير موجود.', updated ? 'success' : 'danger');
  }
});

def(router, {
  name: 'shop_product_image_update', method: 'post', path: '/admin/shop/products/:id/image',
  middleware: [shopImageUpload.single('product_image')],
  handler: async (req, res) => {
    if (req.user.role !== 'admin') return res.flashRedirect('/shop', 'إدارة المتجر للمدير فقط.', 'danger');
    const uploadedFile = file(req, 'product_image');
    const image = await saveShopProductImage(uploadedFile);
    if (!image.ok) return res.flashRedirect('/admin/shop/products', image.msg, 'danger');
    const updated = models.updateShopProductImage(req.params.id, image.imageUrl);
    if (!updated) {
      storage.remove(path.posix.join('uploads', 'shop', path.posix.basename(image.imageUrl)));
      return res.flashRedirect('/admin/shop/products', 'المنتج غير موجود.', 'danger');
    }
    return res.flashRedirect('/admin/shop/products', 'تم تحديث صورة اللعبة.', 'success');
  }
});

def(router, {
  name: 'shop_rental_update', method: 'post', path: '/admin/shop/rentals/:itemId/status',
  handler: async (req, res) => {
    if (!STAFF.has(req.user.role)) return res.flashRedirect('/shop/orders', 'إدارة الإيجارات للموظفين والمدير فقط.', 'danger');
    const result = models.updateShopRentalStatus(Number(req.params.itemId), String(f(req, 'status')));
    return res.flashRedirect('/shop/orders', result.ok ? 'تم تحديث حالة الإيجار.' : result.msg, result.ok ? 'success' : 'danger');
  }
});

module.exports = router;