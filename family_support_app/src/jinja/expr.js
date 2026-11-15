'use strict';

/**
 * Jinja2 expression -> JavaScript expression translator.
 *
 * The app's templates are written in Jinja2. Instead of hand-rewriting 48
 * templates we translate only the expressions inside {{ }} / {% %} to JS and
 * render them with EJS. This module handles the expression half.
 *
 * Supported Jinja/Python constructs found in this project's templates:
 *   - literals: strings, numbers, True/False/None, lists, dicts
 *   - operators: == != < > <= >= + - * / // %  ~ (concat)  and or not
 *   - membership: `x in y`, `x not in y`   (substring for strings, key for objs)
 *   - tests:      `x is none`, `x is not none`, `x is defined`, ...
 *   - ternary:    `A if COND else B`  (nestable)
 *   - filters:    |length |int |round |format |safe |tojson |list |reverse
 *                 |sort |sort(attribute=..) |max |min |join |urlencode |default
 *                 |selectattr |rejectattr |upper |lower |abs |sum |first |last
 *   - methods:    dict.get/items/keys/values, str.startswith/strip/lower/upper
 *                 /join/split/replace
 *
 * Everything else in a template (HTML, inline <script>) is left untouched.
 */

const PY_METHODS = {
  get: 1, items: 1, keys: 1, values: 1,
  startswith: 1, endswith: 1, strip: 1, lower: 1, upper: 1,
  join: 1, split: 1, replace: 1, count: 1, index: 1, append: 1
};

function tokenize(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }

    // string literal
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let val = '';
      while (j < n) {
        if (src[j] === '\\' && j + 1 < n) { val += src[j] + src[j + 1]; j += 2; continue; }
        if (src[j] === quote) break;
        val += src[j];
        j++;
      }
      out.push({ t: 'str', v: val, raw: src.slice(i, j + 1) });
      i = j + 1;
      continue;
    }

    // number
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9._]/.test(src[j])) j++;
      out.push({ t: 'num', v: src.slice(i, j) });
      i = j;
      continue;
    }

    // identifier / keyword (allow Arabic letters, digits, underscore)
    if (/[A-Za-z_\u0600-\u06FF]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_\u0600-\u06FF]/.test(src[j])) j++;
      out.push({ t: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }

    // operators (longest first)
    const three = src.substr(i, 3);
    const two = src.substr(i, 2);
    if (three === '//=' || three === '**=') { out.push({ t: 'op', v: three }); i += 3; continue; }
    if (two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '//' || two === '**') {
      out.push({ t: 'op', v: two }); i += 2; continue;
    }
    out.push({ t: 'op', v: c });
    i++;
  }
  return out;
}

class Parser {
  constructor(tokens, opts) {
    this.tk = tokens;
    this.i = 0;
    this.opts = opts || {};
  }
  peek() { return this.tk[this.i]; }
  next() { return this.tk[this.i++]; }
  isOp(v) { const t = this.peek(); return t && t.t === 'op' && t.v === v; }
  isName(v) { const t = this.peek(); return t && t.t === 'name' && t.v === v; }
  expectOp(v) {
    const t = this.next();
    if (!t || t.t !== 'op' || t.v !== v) {
      throw new Error(`expected '${v}' but found '${t ? (t.v !== undefined ? t.v : t.t) : 'EOF'}'`);
    }
  }

  parseExpression() { return this.parseTernary(); }

  parseTernary() {
    const test = this.parseOr();
    if (this.isName('if')) {
      this.next();
      const cond = this.parseOr();
      if (!this.isName('else')) throw new Error("ternary missing 'else'");
      this.next();
      const other = this.parseTernary();
      return `((${cond}) ? (${test}) : (${other}))`;
    }
    return test;
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.isName('or')) {
      this.next();
      const right = this.parseAnd();
      left = `(${left} || ${right})`;
    }
    return left;
  }

  parseAnd() {
    let left = this.parseNot();
    while (this.isName('and')) {
      this.next();
      const right = this.parseNot();
      left = `(${left} && ${right})`;
    }
    return left;
  }

  parseNot() {
    if (this.isName('not')) {
      this.next();
      return `(!${this.parseNot()})`;
    }
    return this.parseComparison();
  }

  parseComparison() {
    let left = this.parseConcat();
    for (;;) {
      const t = this.peek();
      if (!t) break;
      if (t.t === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(t.v)) {
        this.next();
        const right = this.parseConcat();
        const op = t.v === '==' ? '==' : t.v;
        left = `__cmp(${left}, ${right}, ${JSON.stringify(op)})`;
        continue;
      }
      if (t.t === 'name' && t.v === 'in') {
        this.next();
        const right = this.parseConcat();
        left = `__in(${left}, ${right})`;
        continue;
      }
      if (t.t === 'name' && t.v === 'not' && this.tk[this.i + 1] && this.tk[this.i + 1].t === 'name' && this.tk[this.i + 1].v === 'in') {
        this.next(); this.next();
        const right = this.parseConcat();
        left = `(!__in(${left}, ${right}))`;
        continue;
      }
      if (t.t === 'name' && t.v === 'is') {
        this.next();
        let negate = false;
        if (this.isName('not')) { this.next(); negate = true; }
        const test = this.next();
        const name = test && test.v ? test.v : 'none';
        let call = `__test(${left}, ${JSON.stringify(name)})`;
        if (negate) call = `(!${call})`;
        left = call;
        continue;
      }
      break;
    }
    return left;
  }

  parseConcat() {
    let left = this.parseAdditive();
    while (this.isOp('~')) {
      this.next();
      const right = this.parseAdditive();
      left = `__cat(${left}, ${right})`;
    }
    return left;
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().v;
      const right = this.parseMultiplicative();
      left = `(${left} ${op} ${right})`;
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parseUnary();
    for (;;) {
      if (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
        const op = this.next().v;
        const right = this.parseUnary();
        left = `(${left} ${op} ${right})`;
        continue;
      }
      if (this.isOp('//')) {
        this.next();
        const right = this.parseUnary();
        left = `Math.floor((${left}) / (${right}))`;
        continue;
      }
      if (this.isOp('**')) {
        this.next();
        const right = this.parseUnary();
        left = `Math.pow(${left}, ${right})`;
        continue;
      }
      break;
    }
    return left;
  }

  parseUnary() {
    if (this.isOp('-')) { this.next(); return `(-${this.parseUnary()})`; }
    if (this.isOp('+')) { this.next(); return `(+${this.parseUnary()})`; }
    return this.parsePostfix();
  }

  parsePostfix() {
    let expr = this.parsePrimary();
    for (;;) {
      if (this.isOp('.')) {
        this.next();
        const name = this.next();
        if (!name || name.t !== 'name') throw new Error('expected attribute name after .');
        if (this.isOp('(')) {
          const args = this.parseArgs();
          expr = this.emitMethod(expr, name.v, args);
        } else {
          expr = `__attr(${expr}, ${JSON.stringify(name.v)})`;
        }
        continue;
      }
      if (this.isOp('[')) {
        this.next();
        // slice support: [a:b], [:b], [a:]
        if (this.isOp(':')) {
          this.next();
          const end = this.isOp(']') ? 'null' : this.parseExpression();
          this.expectOp(']');
          expr = `__slice(${expr}, null, ${end})`;
          continue;
        }
        const first = this.parseExpression();
        if (this.isOp(':')) {
          this.next();
          const end = this.isOp(']') ? 'null' : this.parseExpression();
          this.expectOp(']');
          expr = `__slice(${expr}, ${first}, ${end})`;
          continue;
        }
        this.expectOp(']');
        expr = `__index(${expr}, ${first})`;
        continue;
      }
      if (this.isOp('|')) {
        this.next();
        expr = this.parseFilter(expr);
        continue;
      }
      if (this.isOp('(')) {
        const args = this.parseArgs();
        expr = `${expr}(${Parser.buildArgs(args)})`;
        continue;
      }
      break;
    }
    return expr;
  }

  parseArgs() {
    this.expectOp('(');
    const args = [];
    if (!this.isOp(')')) {
      for (;;) {
        const t = this.peek();
        const nt = this.tk[this.i + 1];
        const isNamed = t && t.t === 'name' && nt && nt.t === 'op' && nt.v === '=';
        if (isNamed) {
          this.next(); this.next();
          args.push({ named: t.v, value: this.parseExpression() });
        } else {
          args.push(this.parseExpression());
        }
        if (this.isOp(',')) { this.next(); if (this.isOp(')')) break; continue; }
        break;
      }
    }
    this.expectOp(')');
    return args;
  }

  /** Render a parsed argument list as JS, folding kwargs into a trailing object. */
  static buildArgs(args) {
    const positional = args.filter(a => !(a && a.named));
    const named = args.filter(a => a && a.named);
    const parts = positional.map(a => String(a));
    if (named.length) {
      parts.push('{' + named.map(a => `${JSON.stringify(a.named)}: ${a.value}`).join(', ') + '}');
    }
    return parts.join(', ');
  }

  emitMethod(objExpr, name, args) {
    const argList = Parser.buildArgs(args);
    switch (name) {
      case 'get':      return `__get(${objExpr}${argList ? ', ' + argList : ''})`;
      case 'items':    return `__items(${objExpr})`;
      case 'keys':     return `__keys(${objExpr})`;
      case 'values':   return `__values(${objExpr})`;
      case 'startswith': return `__str(${objExpr}).startsWith(${argList})`;
      case 'endswith':   return `__str(${objExpr}).endsWith(${argList})`;
      case 'strip':      return `__str(${objExpr}).trim()`;
      case 'lower':      return `__str(${objExpr}).toLowerCase()`;
      case 'upper':      return `__str(${objExpr}).toUpperCase()`;
      case 'join':       return `__join(${objExpr}, ${argList})`;
      case 'split':      return `__str(${objExpr}).split(${argList})`;
      case 'replace':    return `__str(${objExpr}).split(${argList.split(',')[0]}).join(${argList.split(',').slice(1).join(',')})`;
      default:
        return `__attr(${objExpr}, ${JSON.stringify(name)})(${argList})`;
    }
  }

  parseFilter(valueExpr) {
    const name = this.next();
    if (!name || name.t !== 'name') throw new Error('expected filter name');
    let args = [];
    if (this.isOp('(')) args = this.parseArgs();
    const positional = args.filter(a => !(a && a.named)).map(a => String(a));
    const named = args.filter(a => a && a.named);
    const fn = FILTERS[name.v];
    if (!fn) {
      const extra = args.length ? ', ' + Parser.buildArgs(args) : '';
      return `__filter(${JSON.stringify(name.v)}, ${valueExpr}${extra})`;
    }
    return fn(valueExpr, positional, named);
  }

  parsePrimary() {
    const t = this.next();
    if (!t) throw new Error('unexpected end of expression');
    if (t.t === 'str') return JSON.stringify(t.v);
    if (t.t === 'num') return t.v;
    if (t.t === 'name') {
      switch (t.v) {
        case 'True': return 'true';
        case 'False': return 'false';
        case 'None': return 'null';
        case 'and': case 'or': case 'not': case 'in': case 'is':
          throw new Error(`unexpected keyword '${t.v}'`);
        default: return t.v;
      }
    }
    if (t.t === 'op') {
      if (t.v === '(') {
        const inner = this.parseExpression();
        if (this.isOp(',')) {
          // Python tuple -> JS array (used for {% for a, b in [...] %} unpacking)
          const items = [inner];
          while (this.isOp(',')) {
            this.next();
            if (this.isOp(')')) break;
            items.push(this.parseExpression());
          }
          this.expectOp(')');
          return `[${items.join(', ')}]`;
        }
        this.expectOp(')');
        return `(${inner})`;
      }
      if (t.v === '[') {
        const items = [];
        if (!this.isOp(']')) {
          for (;;) {
            items.push(this.parseExpression());
            if (this.isOp(',')) { this.next(); if (this.isOp(']')) break; continue; }
            break;
          }
        }
        this.expectOp(']');
        return `[${items.join(', ')}]`;
      }
      if (t.v === '{') {
        const pairs = [];
        if (!this.isOp('}')) {
          for (;;) {
            const k = this.next();
            let key;
            if (k.t === 'str') key = JSON.stringify(k.v);
            else if (k.t === 'num') key = k.v;
            else if (k.t === 'name') key = JSON.stringify(k.v);
            else throw new Error('invalid dict key');
            this.expectOp(':');
            pairs.push(`${key}: ${this.parseExpression()}`);
            if (this.isOp(',')) { this.next(); if (this.isOp('}')) break; continue; }
            break;
          }
        }
        this.expectOp('}');
        return `{${pairs.join(', ')}}`;
      }
    }
    throw new Error(`unexpected token '${t.v}'`);
  }
}

/** Filter name -> emitter. Note Jinja applies `x|f(a)` as `f(x, a)`. */
const FILTERS = {
  length:  (v) => `__len(${v})`,
  count:   (v) => `__len(${v})`,
  int:     (v) => `__int(${v})`,
  float:   (v) => `__float(${v})`,
  string:  (v) => `__str(${v})`,
  abs:     (v) => `Math.abs(${v})`,
  round:   (v, a) => `__round(${v}, ${a.length ? a[0] : 0})`,
  // "%.1f"|format(x) -> the piped value is the format string
  format:  (v, a) => `__format(${v}, [${a.join(', ')}])`,
  safe:    (v) => `__safe(${v})`,
  tojson:  (v) => `__tojson(${v})`,
  list:    (v) => `__list(${v})`,
  reverse: (v) => `__reverse(${v})`,
  sort:    (v, a, named) => {
    const attr = (named || []).find(x => x && x.named === 'attribute');
    return attr ? `__sortBy(${v}, ${attr.value})` : `__sort(${v})`;
  },
  max:     (v) => `__max(${v})`,
  min:     (v) => `__min(${v})`,
  sum:     (v) => `__sum(${v})`,
  first:   (v) => `__first(${v})`,
  last:    (v) => `__last(${v})`,
  join:    (v, a) => `__join(${v}, ${a.length ? a[0] : '""'})`,
  upper:   (v) => `__str(${v}).toUpperCase()`,
  lower:   (v) => `__str(${v}).toLowerCase()`,
  trim:    (v) => `__str(${v}).trim()`,
  urlencode: (v) => `encodeURIComponent(__str(${v}))`,
  default: (v, a) => `__default(${v}, ${a.length ? a[0] : '""'})`,
  selectattr: (v, a) => `__selectAttr(${v}, ${a.join(', ')})`,
  rejectattr: (v, a) => `__rejectAttr(${v}, ${a.join(', ')})`,
  replace: (v, a) => `__str(${v}).split(${a[0]}).join(${a[1]})`,
  truncate: (v, a) => `__truncate(${v}, ${a.length ? a[0] : 255})`
};

function translateExpression(src) {
  const tokens = tokenize(src);
  if (tokens.length === 0) return '""';
  const parser = new Parser(tokens);
  const code = parser.parseExpression();
  if (parser.i !== tokens.length) {
    throw new Error(`unparsed input at token ${parser.i}: '${tokens[parser.i].v}' in: ${src}`);
  }
  return code;
}

/** Look ahead for a top-level `|safe` so we can pick <%- %> (unescaped). */
function isSafe(src) {
  return /\|\s*safe\s*$/.test(src.trim());
}

module.exports = { translateExpression, isSafe, tokenize };
