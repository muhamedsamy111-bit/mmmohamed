'use strict';

/**
 * Health-news feed helper (port of app.py `fetch_health_news`).
 *
 * Pulls the latest "وزارة الصحة والسكان مصر" headlines from Google News RSS:
 * same search terms/URL, same {title, link, date, desc} item shape, the same
 * static fallback announcements and a short (6s) timeout.
 *
 * The Python version parsed the feed with ElementTree; there is no XML parser
 * dependency here, so items are extracted with a small, dependency-free parser.
 * This function must never throw.
 */

const NEWS_TIMEOUT_MS = 6000;

// Same query/URL as app.py: quote("وزارة الصحة والسكان مصر") + hl/gl/ceid.
const NEWS_URL =
  'https://news.google.com/rss/search?q=' +
  encodeURIComponent('وزارة الصحة والسكان مصر') +
  '&hl=ar&gl=EG&ceid=EG:ar';

// app.py fallback list, verbatim.
const FALLBACK_NEWS = [
  {
    title: 'حملة التطعيم الموسمية ضد الإنفلونزا',
    date: '2026-07-20',
    link: '#',
    desc: 'تعلن وزارة الصحة عن انطلاق حملة التطعيم المجاني ضد الإنفلونزا الموسمية بجميع الوحدات الصحية، مع الأولوية لكبار السن وذوي الأمراض المزمنة.'
  },
  {
    title: "توسيع مظلة 'دعم صحي' للأسر الأولى بالرعاية",
    date: '2026-07-10',
    link: '#',
    desc: 'استمرار العمل على ربط قواعد بيانات الدعم الاجتماعي بالوحدات الصحية لتسهيل حصول الأسر المستحقة على الخدمات الطبية والدوائية.'
  },
  {
    title: 'قوافل طبية مجانية بالمحافظات',
    date: '2026-06-28',
    link: '#',
    desc: 'تنظيم قوافل طبية مجانية بعدد من المحافظات لتقديم الكشف والعلاج للأسر الأولى بالرعاية بالتنسيق مع الجمعيات الأهلية.'
  }
];

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
};

function safeCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** Decode XML/HTML entities and CDATA the way ElementTree.text exposes them. */
function decodeXmlEntities(value) {
  if (value === undefined || value === null) return '';
  let out = String(value);
  out = out.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (m, h) => safeCodePoint(parseInt(h, 16)));
  out = out.replace(/&#(\d+);/g, (m, d) => safeCodePoint(parseInt(d, 10)));
  out = out
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
  out = out.replace(/&amp;/g, '&');
  return out;
}

/** First <tag>...</tag> content inside an <item> block (equivalent to findtext). */
function firstTag(block, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i');
  const m = block.match(re);
  return m ? m[1] : '';
}

/**
 * Mirrors Python's:
 *   try: datetime.strptime(pub_date, "%a, %d %b %Y %H:%M:%S %Z").strftime("%Y-%m-%d")
 *   except: pub_date[:16] if pub_date else ""
 *
 * The clock fields are used as written (Python's %Z yields a naive datetime),
 * so no timezone conversion is applied.
 */
function rssDateToYmd(pubDate) {
  if (!pubDate) return '';
  const m = String(pubDate).match(
    /^[A-Za-z]{3},\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+\d{2}:\d{2}:\d{2}\s+[A-Za-z]{2,5}/
  );
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    if (month) return `${m[3]}-${month}-${String(m[1]).padStart(2, '0')}`;
  }
  return String(pubDate).slice(0, 16);
}

/** Parse the first `limit` <item> blocks exactly like Python's `[:limit]`. */
function parseItems(xml, limit) {
  const items = [];
  const blockRe = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let match;
  let examined = 0;
  while ((match = blockRe.exec(xml)) !== null) {
    examined += 1;
    if (examined > limit) break;

    const block = match[1];
    const title = decodeXmlEntities(firstTag(block, 'title')).trim();
    if (!title) continue;

    const link = decodeXmlEntities(firstTag(block, 'link')).trim() || '#';
    const pubDate = decodeXmlEntities(firstTag(block, 'pubDate'));
    const descRaw = decodeXmlEntities(firstTag(block, 'description'));
    const desc = descRaw.replace(/<[^<]+?>/g, '').trim();

    items.push({ title, link, date: rssDateToYmd(pubDate), desc });
  }
  return items;
}

/** Google News occasionally repeats a story; keep first occurrence only. */
function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = `${item.link}\u0000${item.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Fetch the latest health-news items.
 * @param {number} [limit=6]
 * @returns {Promise<Array<{title:string,link:string,date:string,desc:string}>>}
 */
async function fetchHealthNews(limit = 6) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 6;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NEWS_TIMEOUT_MS);

    let xml;
    try {
      const response = await fetch(NEWS_URL, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: controller.signal
      });
      xml = await response.text();
    } finally {
      clearTimeout(timer);
    }

    const items = dedupe(parseItems(xml, max));
    if (items.length) return items;

    // Feed reachable but empty -> same static fallback app.py shows.
    return FALLBACK_NEWS;
  } catch {
    // No network / feed unavailable -> never throw (task contract: [] on failure).
    return [];
  }
}

module.exports = { fetchHealthNews, FALLBACK_NEWS, NEWS_URL };
