'use strict';

/**
 * Runtime helpers referenced by translated Jinja expressions.
 * Names match the emitters in ./expr.js (__get, __attr, __in, ...).
 */

function __isNull(v) { return v === null || v === undefined; }

function __attr(obj, key) {
  if (__isNull(obj)) return null;
  const v = obj[key];
  return v === undefined ? null : v;
}

function __index(obj, key) {
  if (__isNull(obj)) return null;
  const v = obj[key];
  return v === undefined ? null : v;
}

function __get(obj, key, def) {
  const fallback = def === undefined ? null : def;
  if (__isNull(obj)) return fallback;
  const v = obj[key];
  return v === undefined ? fallback : v;
}

function __items(obj) {
  if (__isNull(obj)) return [];
  if (Array.isArray(obj)) return obj.map((v, i) => [i, v]);
  return Object.keys(obj).map(k => [k, obj[k]]);
}

function __keys(obj) { return __isNull(obj) ? [] : Object.keys(obj); }
function __values(obj) { return __isNull(obj) ? [] : Object.values(obj); }

function __str(v) {
  if (__isNull(v)) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return __render(v);
  return String(v);
}

/** Jinja-like string rendering of a value. */
function __render(v) {
  if (__isNull(v)) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return '[' + v.map(x => (typeof x === 'string' ? `'${x}'` : __render(x))).join(', ') + ']';
  if (typeof v === 'object') {
    return '{' + Object.keys(v).map(k => `'${k}': ${typeof v[k] === 'string' ? `'${v[k]}'` : __render(v[k])}`).join(', ') + '}';
  }
  return String(v);
}

/** Output escape-hatch used by the compiler. */
function __s(v) { return __render(v); }

function __len(v) {
  if (__isNull(v)) return 0;
  if (typeof v === 'string' || Array.isArray(v)) return v.length;
  if (typeof v === 'object') return Object.keys(v).length;
  return 0;
}

function __num(v) {
  if (__isNull(v) || v === '') return NaN;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).trim());
  return isNaN(n) ? NaN : n;
}

function __int(v) {
  const n = __num(v);
  return isNaN(n) ? 0 : Math.trunc(n);
}

function __float(v) {
  const n = __num(v);
  return isNaN(n) ? 0 : n;
}

function __round(v, digits) {
  const n = __num(v);
  if (isNaN(n)) return 0;
  const d = __int(digits === undefined ? 0 : digits);
  const f = Math.pow(10, d);
  const r = Math.round(n * f) / f;
  return d === 0 ? Math.round(n) : r;
}

/** printf-style formatting: __format('%.1f', [3.14159]) */
function __format(fmt, args) {
  const f = __str(fmt);
  const list = Array.isArray(args) ? args : [args];
  let i = 0;
  return f.replace(/%(%|\.\d+[fds]|[dsfgyx])/g, (m, spec) => {
    if (spec === '%') return '%';
    const value = list[i++];
    if (spec.endsWith('f')) {
      const digits = spec.length > 2 ? parseInt(spec.slice(1, -1), 10) : 6;
      const n = __num(value);
      return (isNaN(n) ? 0 : n).toFixed(digits);
    }
    if (spec === 'd' || spec === 'g' || spec === 'y' || spec === 'x') return String(__int(value));
    return __str(value);
  });
}

function __in(needle, haystack) {
  if (__isNull(haystack)) return false;
  if (typeof haystack === 'string') return haystack.includes(__str(needle));
  if (Array.isArray(haystack)) return haystack.some(x => x == needle);
  if (typeof haystack === 'object') return Object.prototype.hasOwnProperty.call(haystack, needle);
  return false;
}

function __cat(a, b) { return __str(a) + __str(b); }

function __cmp(a, b, op) {
  switch (op) {
    case '==': return a == b; // eslint-disable-line eqeqeq
    case '!=': return a != b; // eslint-disable-line eqeqeq
    default: break;
  }
  const na = __num(a);
  const nb = __num(b);
  const numeric = !isNaN(na) && !isNaN(nb) && String(a).trim() !== '' && String(b).trim() !== '';
  const x = numeric ? na : __str(a);
  const y = numeric ? nb : __str(b);
  switch (op) {
    case '<': return x < y;
    case '>': return x > y;
    case '<=': return x <= y;
    case '>=': return x >= y;
    default: return false;
  }
}

function __test(v, name) {
  switch (name) {
    case 'none': case 'null': return __isNull(v);
    case 'defined': return v !== undefined;
    case 'undefined': return v === undefined;
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number';
    case 'boolean': return typeof v === 'boolean';
    case 'true': return v === true;
    case 'false': return v === false;
    case 'mapping': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'iterable': return Array.isArray(v) || (v !== null && typeof v === 'object');
    case 'empty': return __len(v) === 0;
    case 'odd': return Math.abs(__int(v)) % 2 === 1;
    case 'even': return Math.abs(__int(v)) % 2 === 0;
    default: return false;
  }
}

function __safe(v) { return v; }
function __tojson(v) { return __isNull(v) ? 'null' : JSON.stringify(v); }

function __list(v) {
  if (__isNull(v)) return [];
  if (Array.isArray(v)) return v.slice();
  if (typeof v === 'string') return v.split('');
  if (typeof v === 'object') return Object.keys(v);
  return [v];
}

function __reverse(v) {
  if (__isNull(v)) return [];
  return __list(v).slice().reverse();
}

function __defaultCmp(a, b) {
  const na = __num(a);
  const nb = __num(b);
  if (!isNaN(na) && !isNaN(nb) && typeof a !== 'string') return na - nb;
  return String(a).localeCompare(String(b));
}

function __sort(v) { return __list(v).slice().sort(__defaultCmp); }
function __sortBy(v, attr) {
  return __list(v).slice().sort((a, b) => __defaultCmp(__attr(a, attr), __attr(b, attr)));
}

function __max(v) {
  const list = __list(v).filter(x => x !== null && x !== undefined && x !== '');
  if (!list.length) return 0;
  return list.reduce((m, x) => (__defaultCmp(x, m) > 0 ? x : m), list[0]);
}

function __min(v) {
  const list = __list(v).filter(x => x !== null && x !== undefined && x !== '');
  if (!list.length) return 0;
  return list.reduce((m, x) => (__defaultCmp(x, m) < 0 ? x : m), list[0]);
}

function __sum(v) { return __list(v).reduce((s, x) => s + (__num(x) || 0), 0); }
function __first(v) { const l = __list(v); return l.length ? l[0] : null; }
function __last(v) { const l = __list(v); return l.length ? l[l.length - 1] : null; }
function __abs(v) { return Math.abs(__num(v) || 0); }
function __truncate(v, len) {
  const s = __str(v);
  const n = __int(len) || 255;
  return s.length > n ? s.slice(0, Math.max(0, n - 3)) + '...' : s;
}

function __join(v, sep) {
  const s = sep === undefined ? '' : __str(sep);
  return __list(v).map(__str).join(s);
}

/** Python slice: __slice(x, start, end), nulls mean "open". */
function __slice(v, start, end) {
  const isStr = typeof v === 'string';
  const list = isStr ? v : __list(v);
  const n = list.length;
  let s = start === null || start === undefined ? 0 : __int(start);
  let e = end === null || end === undefined ? n : __int(end);
  if (s < 0) s = Math.max(0, n + s);
  if (e < 0) e = Math.max(0, n + e);
  s = Math.min(s, n);
  e = Math.min(e, n);
  if (e < s) e = s;
  return isStr ? v.slice(s, e) : list.slice(s, e);
}

function __attrTest(item, attr, testName, arg) {
  const value = __attr(item, attr);
  if (!testName) return Boolean(value);
  switch (testName) {
    case 'equalto': return value == arg; // eslint-disable-line eqeqeq
    case 'ne': return value != arg; // eslint-disable-line eqeqeq
    case 'defined': return value !== null && value !== undefined;
    case 'none': return __isNull(value);
    case 'in': return __in(value, arg);
    default: return __test(value, testName);
  }
}

function __selectAttr(v, attr, testName, arg) {
  return __list(v).filter(item => __attrTest(item, attr, testName, arg));
}

function __rejectAttr(v, attr, testName, arg) {
  return __list(v).filter(item => !__attrTest(item, attr, testName, arg));
}

function __filter(name, v, ...args) {
  const map = {
    length: __len, int: __int, float: __float, string: __str, list: __list,
    reverse: __reverse, sort: __sort, max: __max, min: __min, sum: __sum,
    first: __first, last: __last, abs: __abs, safe: __safe, tojson: __tojson,
    upper: (x) => __str(x).toUpperCase(), lower: (x) => __str(x).toLowerCase(),
    trim: (x) => __str(x).trim(), capitalize: (x) => __str(x).charAt(0).toUpperCase() + __str(x).slice(1)
  };
  const fn = map[name];
  if (!fn) throw new Error(`unsupported Jinja filter '|${name}'`);
  return fn(v, ...args);
}

const helpers = {
  __s, __attr, __index, __get, __items, __keys, __values, __str, __render,
  __len, __int, __float, __round, __format, __in, __cat, __cmp, __test,
  __safe, __tojson, __list, __reverse, __sort, __sortBy, __max, __min,
  __sum, __first, __last, __abs, __truncate, __join, __slice, __selectAttr, __rejectAttr,
  __filter, __isNull
};

module.exports = helpers;
