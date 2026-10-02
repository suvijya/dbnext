/**
 * Naming helpers: identifier case conversion, English inflection (Rails / ActiveSupport rules,
 * which Rails, Laravel, GORM, Sequelize and Mongoose all approximate) and each ORM's default
 * model → table naming convention.
 */

import type { SourceKind } from './model';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Case conversion
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Splits an identifier into words: `userProfileID` → `['user', 'Profile', 'ID']`,
 * `HTTPServer` → `['HTTP', 'Server']`, `order_items` → `['order', 'items']`, `md5Hash` → `['md5', 'Hash']`.
 */
export function words(id: string): string[] {
  const out: string[] = [];
  for (const part of id.split(/[^A-Za-z0-9]+/)) {
    if (!part) continue;
    const ws = part.match(/[A-Z]+\d*(?![a-z])|[A-Z]?[a-z]+\d*|\d+/g);
    if (ws) out.push(...ws);
  }
  return out;
}

/** `UserProfile` / `userProfile` / `user-profile` → `user_profile`. */
export function snakeCase(id: string): string {
  return words(id)
    .map((w) => w.toLowerCase())
    .join('_');
}

/** `user_profile` → `userProfile`. */
export function camelCase(id: string): string {
  const ws = words(id);
  return ws.map((w, i) => (i === 0 ? w.toLowerCase() : capitalize(w.toLowerCase()))).join('');
}

/** `user_profile` → `UserProfile`. */
export function pascalCase(id: string): string {
  return words(id)
    .map((w) => capitalize(w.toLowerCase()))
    .join('');
}

export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function lcfirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Inflection
// ─────────────────────────────────────────────────────────────────────────────────────────────

type Rule = readonly [RegExp, string];

const UNCOUNTABLE = new Set([
  'equipment',
  'information',
  'rice',
  'money',
  'species',
  'series',
  'fish',
  'sheep',
  'jeans',
  'police',
  'news',
  'deer',
  'moose',
  'aircraft',
  'feedback',
  'software',
  'hardware',
]);

/** Extra words Mongoose never pluralizes when deriving collection names. */
const MONGOOSE_UNCOUNTABLE = new Set([
  'advice',
  'energy',
  'excretion',
  'digestion',
  'cooperation',
  'health',
  'justice',
  'labour',
  'machinery',
  'pollution',
  'sewage',
  'paper',
  'rain',
  'expertise',
  'status',
  'media',
]);

/** [singular, plural]. Matched as a whole word or as the end of a compound (`salesperson`). */
const IRREGULAR: readonly (readonly [string, string])[] = [
  ['person', 'people'],
  ['child', 'children'],
  ['sex', 'sexes'],
  ['move', 'moves'],
  ['zombie', 'zombies'],
];

/** `man` → `men` only for real compounds, so that `human` / `german` stay regular. */
const MAN_COMPOUND = /^(|wo|chair|sales|police|fire|business|spokes|post|work|crafts|gentle|middle|fresh|fisher|sports|door|milk)(man)$/;

// Priority order (first match wins) – ActiveSupport's rules in reverse definition order.
const PLURAL_RULES: readonly Rule[] = [
  [/(quiz)$/, '$1zes'],
  [/^(oxen)$/, '$1'],
  [/^(ox)$/, '$1en'],
  [/^(m|l)ice$/, '$1ice'],
  [/^(m|l)ouse$/, '$1ice'],
  [/(matr|vert|ind)(?:ix|ex)$/, '$1ices'],
  [/(x|ch|ss|sh)$/, '$1es'],
  [/([^aeiouy]|qu)y$/, '$1ies'],
  [/(hive)$/, '$1s'],
  [/(?:([^f])fe|([lr])f)$/, '$1$2ves'],
  [/sis$/, 'ses'],
  [/([ti])a$/, '$1a'],
  [/([ti])um$/, '$1a'],
  [/(buffal|tomat|potat)o$/, '$1oes'],
  [/(bu)s$/, '$1ses'],
  [/(alias|status)$/, '$1es'],
  [/(octop|vir)i$/, '$1i'],
  [/(octop|vir)us$/, '$1i'],
  [/^(ax|test)is$/, '$1es'],
  [/s$/, 's'],
  [/$/, 's'],
];

const SINGULAR_RULES: readonly Rule[] = [
  [/(database)s$/, '$1'],
  [/(quiz)zes$/, '$1'],
  [/(matr)ices$/, '$1ix'],
  [/(vert|ind)ices$/, '$1ex'],
  [/^(ox)en/, '$1'],
  [/(alias|status)(es)?$/, '$1'],
  [/(octop|vir)(us|i)$/, '$1us'],
  [/^(a)x[ie]s$/, '$1xis'],
  [/(cris|test)(is|es)$/, '$1is'],
  [/(shoe)s$/, '$1'],
  [/(buffal|tomat|potat|her|ech|vet)oes$/, '$1o'],
  [/(bus)(es)?$/, '$1'],
  [/^(m|l)ice$/, '$1ouse'],
  [/(cache|niche|avalanche|ache|douche)s$/, '$1'],
  [/(x|ch|ss|sh|zz)es$/, '$1'],
  [/(m)ovies$/, '$1ovie'],
  [/(s)eries$/, '$1eries'],
  [/^(t|p|l|d)ies$/, '$1ie'],
  [/(cook|zomb|calor|goal|self|rook|hood|freeb|smooth|brown|cutie|hipp)ies$/, '$1ie'],
  [/([^aeiouy]|qu)ies$/, '$1y'],
  [/([lr])ves$/, '$1f'],
  [/(tive)s$/, '$1'],
  [/(hive)s$/, '$1'],
  [/([^f])ves$/, '$1fe'],
  [/(^analy)(sis|ses)$/, '$1sis'],
  [/((a)naly|(b)a|(d)iagno|(p)arenthe|(p)rogno|(s)ynop|(t)he)(sis|ses)$/, '$1sis'],
  [/([ti])a$/, '$1um'],
  [/(n)ews$/, '$1ews'],
  // Already singular: -ss (class), -sis (analysis). Plurals like `emojis`, `apis`, `menus`, `skus`
  // must still lose their `s`; genuinely singular `-us` words are listed in SINGULAR_US.
  [/(ss|sis)$/, '$1'],
  [/s$/, ''],
];

/** Singular nouns ending in `-us` (otherwise `menus` → `menu` would turn `campus` into `campu`). */
const SINGULAR_US = new Set([
  'abacus', 'apparatus', 'bonus', 'bus', 'cactus', 'campus', 'census', 'chorus', 'circus', 'citrus',
  'consensus', 'corpus', 'exodus', 'focus', 'fungus', 'genus', 'hiatus', 'impetus', 'lotus', 'minus',
  'nexus', 'octopus', 'onus', 'plus', 'prospectus', 'radius', 'sinus', 'status', 'stimulus', 'surplus',
  'syllabus', 'thesaurus', 'torus', 'virus', 'walrus',
]);

function restoreCase(original: string, inflected: string): string {
  if (original.length > 1 && original === original.toUpperCase() && /[A-Z]/.test(original)) {
    return inflected.toUpperCase();
  }
  if (original[0] && original[0] !== original[0].toLowerCase()) return capitalize(inflected);
  return inflected;
}

/** Splits off the last word so only it is inflected: `UserProfile` → [`User`, `Profile`], `order_item` → [`order_`, `item`]. */
function splitLastWord(word: string): [string, string, string] {
  const m = /([A-Za-z]+)([^A-Za-z]*)$/.exec(word);
  if (!m) return [word, '', ''];
  const run = m[1];
  const humps = run.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? [run];
  const last = humps[humps.length - 1];
  const prefix = word.slice(0, m.index + run.length - last.length);
  return [prefix, last, m[2]];
}

function inflectWord(lower: string, plural: boolean, flavor: 'rails' | 'mongoose'): string {
  if (UNCOUNTABLE.has(lower) || (flavor === 'mongoose' && MONGOOSE_UNCOUNTABLE.has(lower))) return lower;
  const man = MAN_COMPOUND.exec(lower);
  if (plural && man) return `${man[1]}men`;
  if (!plural && /^(|wo|chair|sales|police|fire|business|spokes|post|work|crafts|gentle|middle|fresh|fisher|sports|door|milk)men$/.test(lower)) {
    return lower.slice(0, -3) + 'man';
  }
  for (const [s, p] of IRREGULAR) {
    const from = plural ? s : p;
    const to = plural ? p : s;
    if (lower === from || lower === to) return to;
    if (lower.endsWith(from) && lower.length > from.length + 2) return lower.slice(0, -from.length) + to;
  }
  if (!plural && SINGULAR_US.has(lower)) return lower;
  if (!plural && lower.endsWith('es') && SINGULAR_US.has(lower.slice(0, -2))) return lower.slice(0, -2);
  for (const [re, rep] of plural ? PLURAL_RULES : SINGULAR_RULES) {
    if (re.test(lower)) return lower.replace(re, rep);
  }
  return lower;
}

/**
 * Pluralizes the last word of an identifier, preserving case and separators:
 * `category` → `categories`, `UserProfile` → `UserProfiles`, `order_item` → `order_items`, `Person` → `People`.
 */
export function pluralize(word: string, flavor: 'rails' | 'mongoose' = 'rails'): string {
  const [prefix, last, suffix] = splitLastWord(word);
  if (!last) return word;
  return prefix + restoreCase(last, inflectWord(last.toLowerCase(), true, flavor)) + suffix;
}

/** Singularizes the last word of an identifier: `categories` → `category`, `user_profiles` → `user_profile`. */
export function singularize(word: string): string {
  const [prefix, last, suffix] = splitLastWord(word);
  if (!last) return word;
  return prefix + restoreCase(last, inflectWord(last.toLowerCase(), false, 'rails')) + suffix;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ORM conventions
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Last segment of a qualified model / class name:
 * `App\Models\User`, `auth.User`, `Admin::User`, `com.acme.User`, `MyApp.Accounts.User` → `User`.
 */
export function shortName(qualified: string): string {
  const cleaned = qualified.trim().replace(/^["'`]|["'`]$/g, '').replace(/<.*>$/, '');
  const parts = cleaned.split(/::|\\|\.|\//).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : cleaned;
}

/**
 * Table / collection name an ORM derives from a model class name when none is configured.
 *
 * | kind                                   | `UserProfile` →            |
 * |----------------------------------------|----------------------------|
 * | rails, laravel, gorm, ent, bun         | `user_profiles`            |
 * | sequelize                              | `UserProfiles`             |
 * | mongoose                               | `userprofiles`             |
 * | typeorm, mikroorm, jpa, doctrine       | `user_profile`             |
 * | django (`appLabel` = `blog`)           | `blog_userprofile`         |
 * | sqlmodel, peewee, tortoise             | `userprofile`              |
 * | prisma, efcore and everything else     | `UserProfile`              |
 */
export function defaultTableName(kind: SourceKind, model: string, opts: { appLabel?: string } = {}): string {
  const name = shortName(model);
  switch (kind) {
    case 'rails':
    case 'laravel':
    case 'gorm':
    case 'ent':
    case 'bun':
      return pluralize(snakeCase(name));
    case 'sequelize':
      return pluralize(name);
    case 'mongoose':
      return pluralize(name.toLowerCase(), 'mongoose');
    case 'typeorm':
    case 'mikroorm':
    case 'jpa':
    case 'doctrine':
      return snakeCase(name);
    case 'django':
      return opts.appLabel ? `${opts.appLabel.toLowerCase()}_${name.toLowerCase()}` : name.toLowerCase();
    case 'sqlmodel':
    case 'peewee':
    case 'tortoise':
      return name.toLowerCase();
    default:
      return name;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Misc
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Natural ordering (`V2__x` < `V10__x`), used to replay migrations chronologically. */
export function naturalCompare(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const ta = a.match(re) ?? [];
  const tb = b.match(re) ?? [];
  const n = Math.min(ta.length, tb.length);
  for (let i = 0; i < n; i++) {
    const x = ta[i];
    const y = tb[i];
    if (x === y) continue;
    const dx = /^\d/.test(x);
    const dy = /^\d/.test(y);
    if (dx && dy) {
      const nx = x.replace(/^0+(?=\d)/, '');
      const ny = y.replace(/^0+(?=\d)/, '');
      if (nx.length !== ny.length) return nx.length - ny.length;
      if (nx !== ny) return nx < ny ? -1 : 1;
      if (x.length !== y.length) return y.length - x.length;
      continue;
    }
    return x < y ? -1 : 1;
  }
  return ta.length - tb.length;
}
