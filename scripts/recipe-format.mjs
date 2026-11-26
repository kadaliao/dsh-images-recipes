// A copy of lib/recipes.mjs from kadaliao/dsh-images, the recipe format the Images plugin reads.
// Edit it there and copy it here (`cp ../dsh-images/lib/recipes.mjs scripts/recipe-format.mjs`, then re-add this line).

/**
 * Recipes: a tested prompt template with blanks, the parameters it is drawn
 * with, and who made it. Built-in recipes, the user's own and community ones
 * share this one format, and so do the recipe codes people paste to each other
 * and the text chunk a downloaded PNG carries.
 *
 * Dependency-free (node:zlib only), so the community repository's scripts can
 * carry a copy of it. This file is the canonical copy.
 *
 * @module @kadaliao/dsh-images/lib/recipes
 */

import { crc32, deflateRawSync, inflateRawSync, inflateSync } from 'node:zlib';

export const RECIPE_FORMAT = 1;
export const CATEGORIES = ['photo', 'handdrawn', 'editorial', 'infographic', '3d', 'sticker', 'illustration', 'product', 'comic'];
/** What a recipe code starts with; the version is part of it. */
export const CODE_PREFIX = 'dshimg1.';
/** The PNG text chunk a picture's recipe travels in. */
export const PNG_KEYWORD = 'dsh-images-recipe';

const SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'];
const FRAMES = [4, 6, 9, 16];
const QUALITIES = ['low', 'medium', 'high'];
const LIMITS = { id: 48, title: 60, summary: 240, prompt: 8000, label: 60, value: 400, tag: 24, tags: 6, slots: 8, inputs: 6, url: 600, author: 80, license: 40, repo: 120 };

/** A `{{name}}` blank in a template. */
const SLOT_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,31})\s*\}\}/g;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const CJK_RE = /[぀-ヿ㐀-鿿가-힯]/;

const str = (v, max) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v).slice(0, max) : '');

/**
 * A short text in one or two languages, as `{zh?, en?}`. A plain string is
 * filed under the language it is written in.
 */
export function localized(v, max) {
  if (typeof v === 'string') {
    const s = str(v, max);
    return s === '' ? {} : CJK_RE.test(s) ? { zh: s } : { en: s };
  }
  const out = {};
  if (v && typeof v === 'object') {
    for (const lang of ['zh', 'en']) {
      const s = str(v[lang], max);
      if (s !== '') out[lang] = s;
    }
  }
  return out;
}

/** The text for `lang` (`zh`, `en`, `zh-CN`…), else the other language, else ''. */
export function pick(text, lang = 'en') {
  if (typeof text === 'string') return text;
  if (!text || typeof text !== 'object') return '';
  const want = String(lang).toLowerCase().startsWith('zh') ? 'zh' : 'en';
  return text[want] ?? text[want === 'zh' ? 'en' : 'zh'] ?? '';
}

/** The blanks a template names, in order of first use. */
export function slotsOf(prompt) {
  const names = [];
  for (const m of String(prompt ?? '').matchAll(SLOT_RE)) if (!names.includes(m[1])) names.push(m[1]);
  return names;
}

/** A kebab-case id from any text, or '' when nothing usable is left. */
export function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/** An https URL, or ''. */
function httpsUrl(v) {
  const s = str(v, LIMITS.url);
  if (!/^https:\/\//i.test(s)) return '';
  try {
    return new URL(s).href;
  } catch {
    return '';
  }
}

/** A cover reference: an https URL, or a plain relative path inside the source. */
function coverRef(v) {
  const s = str(v, LIMITS.url);
  if (s === '') return '';
  if (/^https:\/\//i.test(s)) return httpsUrl(s);
  if (/^[A-Za-z0-9._/-]+$/.test(s) && !s.split('/').includes('..') && !s.startsWith('/')) return s;
  return '';
}

/**
 * Check one recipe and bring it to the stored shape. Throws an Error whose
 * message says what is wrong. Unknown fields are dropped.
 * @param {unknown} raw
 */
export function normalizeRecipe(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('a recipe must be an object');
  const prompt = str(raw.prompt, LIMITS.prompt);
  if (prompt === '') throw new Error('the recipe has no prompt');
  const title = localized(raw.title, LIMITS.title);
  if (!title.zh && !title.en) throw new Error('the recipe has no title');
  const givenId = str(raw.id, LIMITS.id).toLowerCase();
  const id = ID_RE.test(givenId) ? givenId : slugify(givenId) || slugify(title.en) || '';

  // The blanks are the ones the template uses; `slots` only labels them.
  const meta = new Map();
  for (const s of Array.isArray(raw.slots) ? raw.slots : []) {
    const name = str(s?.name, 32);
    if (/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name) && !meta.has(name)) meta.set(name, s);
  }
  const names = slotsOf(prompt);
  if (names.length > LIMITS.slots) throw new Error(`a recipe may have at most ${LIMITS.slots} blanks; this one has ${names.length}`);
  const slots = names.map((name) => {
    const s = meta.get(name) ?? {};
    const label = localized(s.label, LIMITS.label);
    return { name, label: label.zh || label.en ? label : { en: name.replace(/_/g, ' ') }, default: str(s.default, LIMITS.value) };
  });

  const inputs = (Array.isArray(raw.inputs) ? raw.inputs : []).slice(0, LIMITS.inputs).map((input, i) => {
    const label = localized(typeof input === 'string' ? input : input?.label, LIMITS.label);
    const name = str(input?.name, 32);
    return { name: /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name) ? name : `image${i + 1}`, label: label.zh || label.en ? label : { en: `Image ${i + 1}`, zh: `图 ${i + 1}` } };
  });

  const p = raw.params && typeof raw.params === 'object' ? raw.params : {};
  const params = {};
  if (SIZES.includes(str(p.size, 16))) params.size = str(p.size, 16);
  if (FRAMES.includes(Number(p.frames))) params.frames = Number(p.frames);
  if (params.frames && Number.isFinite(Number(p.frameMs))) params.frameMs = Math.min(1000, Math.max(40, Math.round(Number(p.frameMs))));
  if (QUALITIES.includes(str(p.quality, 8))) params.quality = str(p.quality, 8);

  const category = CATEGORIES.includes(str(raw.category, 16)) ? str(raw.category, 16) : params.frames ? 'sticker' : inputs.length > 0 ? 'photo' : 'illustration';
  const tags = [...new Set((Array.isArray(raw.tags) ? raw.tags : []).map((t) => str(t, LIMITS.tag).toLowerCase()).filter(Boolean))].slice(0, LIMITS.tags);

  const out = { id, title, summary: localized(raw.summary, LIMITS.summary), category, tags, inputs, slots, prompt, params };

  const src = raw.source && typeof raw.source === 'object' ? raw.source : undefined;
  if (src) {
    const source = {};
    const repo = str(src.repo, LIMITS.repo);
    const url = httpsUrl(src.url);
    const license = str(src.license, LIMITS.license);
    const author = str(src.author, LIMITS.author);
    if (repo) source.repo = repo;
    if (url) source.url = url;
    if (license) source.license = license;
    if (author) source.author = author;
    if (Object.keys(source).length > 0) out.source = source;
  }
  const author = str(raw.author, LIMITS.author);
  if (author) out.author = author;
  const cover = coverRef(raw.cover);
  if (cover) out.cover = cover;
  if (Array.isArray(raw.tested)) {
    const tested = raw.tested.map((t) => str(t, 60)).filter(Boolean).slice(0, 6);
    if (tested.length > 0) out.tested = tested;
  }
  if (Number.isInteger(raw.issue) && raw.issue > 0) out.issue = raw.issue;
  if (raw.stats && typeof raw.stats === 'object') {
    const votes = Math.max(0, Math.floor(Number(raw.stats.votes) || 0));
    const works = Math.max(0, Math.floor(Number(raw.stats.works) || 0));
    if (votes || works) out.stats = { votes, works };
  }
  for (const key of ['createdAt', 'updatedAt']) if (Number.isFinite(raw[key]) && raw[key] > 0) out[key] = raw[key];
  return out;
}

/**
 * The prompt a recipe draws with: every blank filled with the value given, its
 * default, or its own name in words; then any extra direction.
 * @param {{prompt: string, slots: {name: string, default: string}[]}} recipe
 * @param {Record<string, unknown>} [values]
 * @param {string} [extra]
 */
export function renderPrompt(recipe, values = {}, extra = '') {
  const given = values && typeof values === 'object' ? values : {};
  const byName = new Map((recipe.slots ?? []).map((s) => [s.name, s]));
  const filled = String(recipe.prompt).replace(SLOT_RE, (_, name) => str(given[name], LIMITS.value) || byName.get(name)?.default || name.replace(/_/g, ' '));
  const more = str(extra, LIMITS.prompt);
  return more === '' ? filled : `${filled}\n\nAdditional direction: ${more}`;
}

/** A recipe without what only this machine knows, as it travels to someone else. */
export function portable(recipe) {
  const { id, title, summary, category, tags, inputs, slots, prompt, params, source, author, tested } = recipe;
  const out = { id, title, summary, category, tags, inputs, slots, prompt, params };
  if (source) out.source = source;
  if (author) out.author = author;
  if (tested) out.tested = tested;
  if (typeof recipe.cover === 'string' && /^https:\/\//i.test(recipe.cover)) out.cover = recipe.cover;
  return out;
}

/** The recipe as one pasteable token: `dshimg1.` and its compressed JSON. */
export function encodeRecipe(recipe) {
  const json = JSON.stringify({ f: RECIPE_FORMAT, r: portable(recipe) });
  return CODE_PREFIX + deflateRawSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64url');
}

/** The first recipe code in a text, or null. */
export function findCode(text) {
  const m = /dshimg1\.[A-Za-z0-9_-]{8,}/.exec(String(text ?? ''));
  return m ? m[0] : null;
}

/** The recipe a code (or a text holding one) carries. Throws a readable Error. */
export function decodeRecipe(text) {
  const code = findCode(text);
  if (code === null) throw new Error('no recipe code (dshimg1.…) in the text');
  let json;
  try {
    const bytes = inflateRawSync(Buffer.from(code.slice(CODE_PREFIX.length), 'base64url'), { maxOutputLength: 256 * 1024 });
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('the recipe code is damaged or cut off; copy the whole of it');
  }
  if (!json || typeof json !== 'object' || json.f !== RECIPE_FORMAT) throw new Error('the recipe code comes from a newer version of Images; update the plugin');
  return normalizeRecipe(json.r);
}

/**
 * A recipe from whatever someone pasted: a text holding a recipe code, or the
 * recipe's JSON (alone, or as `{recipe}`). Throws a readable Error.
 */
export function parseRecipeText(text) {
  const s = String(text ?? '').trim();
  if (findCode(s) !== null) return decodeRecipe(s);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  const body = fenced ? fenced[1] : s;
  if (/^[{[]/.test(body.trim())) {
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error('the text looks like JSON but does not parse');
    }
    return normalizeRecipe(json && typeof json === 'object' && json.recipe ? json.recipe : json);
  }
  throw new Error('no recipe code (dshimg1.…) in the text');
}

/** The message that carries a recipe to another person: who it is, and the code. */
export function shareText(recipe, lang = 'en', code = encodeRecipe(recipe)) {
  const zh = String(lang).toLowerCase().startsWith('zh');
  const title = pick(recipe.title, lang);
  const summary = pick(recipe.summary, lang);
  return [
    zh ? `【DSH Images 玩法】${title}` : `[DSH Images recipe] ${title}`,
    ...(summary ? [summary] : []),
    zh
      ? '复制这一整段，在 Images 面板「玩法 → 导入」里粘贴即可使用，也可以直接发给对话里的模型：'
      : 'Copy all of this and paste it into Images → Recipes → Import, or send it to the model in a conversation:',
    code,
  ].join('\n');
}

/** A short title from the start of a prompt. */
export function titleFrom(prompt) {
  const s = String(prompt ?? '').replace(/\s+/g, ' ').trim();
  const clause = s.split(/[，。,.:：;；!?！？\n]/)[0] || s;
  // Chinese or Japanese by how the clause starts; an English prompt naming a Chinese city is still English.
  if (CJK_RE.test(clause.replace(/^[\s"'“‘(（【\[]+/, '').charAt(0))) return clause.slice(0, 16);
  const words = clause.split(' ').slice(0, 6).join(' ');
  return words.length > 40 ? `${words.slice(0, 39)}…` : words;
}

/**
 * The recipe a gallery picture stands for: its prompt word for word, the size
 * and animation it was drawn with, and as many input images as it was given.
 * @param {object} item - a gallery item.
 */
export function recipeFromImage(item) {
  const prompt = String(item?.prompt ?? '').replace(SLOT_RE, (m) => m.replace(/\{\{|\}\}/g, (b) => (b === '{{' ? '{ {' : '} }')));
  const frames = item?.animation?.frames;
  const inputs = Math.min(LIMITS.inputs, Math.max(0, Number(item?.inputs) || 0));
  return normalizeRecipe({
    id: `image-${String(item?.id ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '')}`.slice(0, LIMITS.id),
    title: titleFrom(prompt) || 'Image',
    category: frames ? 'sticker' : inputs > 0 ? 'photo' : 'illustration',
    prompt,
    inputs: Array.from({ length: inputs }, (_, i) => ({ name: `image${i + 1}`, label: { zh: `参考图 ${i + 1}`, en: `Input image ${i + 1}` } })),
    params: {
      ...(SIZES.includes(item?.size) ? { size: item.size } : {}),
      ...(frames ? { frames, frameMs: item.animation.delayMs } : {}),
      ...(item?.quality ? { quality: item.quality } : {}),
    },
  });
}

/**
 * Recipes matching a query, best first. Every term must appear somewhere; a hit
 * in the title counts most, then tags and category, then the summary, then the
 * prompt.
 * @param {object[]} recipes
 * @param {string} query
 */
export function searchRecipes(recipes, query) {
  const terms = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return recipes.slice();
  const scored = [];
  for (const r of recipes) {
    const fields = [
      [`${r.title?.zh ?? ''} ${r.title?.en ?? ''}`.toLowerCase(), 6],
      [`${(r.tags ?? []).join(' ')} ${r.category}`.toLowerCase(), 4],
      [`${r.summary?.zh ?? ''} ${r.summary?.en ?? ''}`.toLowerCase(), 2],
      [String(r.prompt ?? '').toLowerCase(), 1],
    ];
    let score = 0;
    let all = true;
    for (const term of terms) {
      const best = fields.reduce((acc, [text, weight]) => (text.includes(term) ? Math.max(acc, weight) : acc), 0);
      if (best === 0) {
        all = false;
        break;
      }
      score += best;
    }
    if (all) scored.push({ r, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.r);
}

// --- PNG text chunks ----------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The chunks of a PNG as `{type, start, end, data}`, or null for anything else. */
function chunksOf(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const out = [];
  let at = 8;
  while (at + 12 <= buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const end = at + 12 + len;
    if (end > buf.length) break;
    out.push({ type, start: at, end, data: buf.subarray(at + 8, at + 8 + len) });
    at = end;
    if (type === 'IEND') break;
  }
  return out;
}

/** The text chunks of a PNG (`tEXt`, `zTXt`, `iTXt`) as a keyword → text map. */
export function pngText(bytes) {
  const found = new Map();
  for (const c of chunksOf(bytes) ?? []) {
    if (c.type !== 'tEXt' && c.type !== 'zTXt' && c.type !== 'iTXt') continue;
    const nul = c.data.indexOf(0);
    if (nul <= 0) continue;
    const keyword = c.data.toString('latin1', 0, nul);
    try {
      if (c.type === 'tEXt') found.set(keyword, c.data.toString('latin1', nul + 1));
      else if (c.type === 'zTXt') found.set(keyword, inflateSync(c.data.subarray(nul + 2)).toString('latin1'));
      else {
        const compressed = c.data[nul + 1] === 1;
        let at = c.data.indexOf(0, nul + 3);
        at = c.data.indexOf(0, at + 1);
        const body = c.data.subarray(at + 1);
        found.set(keyword, (compressed ? inflateSync(body) : body).toString('utf8'));
      }
    } catch {
      // A damaged chunk is skipped.
    }
  }
  return found;
}

/**
 * The PNG with one `iTXt` chunk set (UTF-8, uncompressed), placed before the
 * image data; a chunk with the same keyword is replaced. Not a PNG: unchanged.
 */
export function withPngText(bytes, keyword, text) {
  const chunks = chunksOf(bytes);
  if (chunks === null || chunks.length === 0 || chunks[0].type !== 'IHDR') return bytes;
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const body = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0, 0, 0, 0, 0]), Buffer.from(String(text), 'utf8')]);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write('iTXt', 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0);
  const chunk = Buffer.concat([head, body, crc]);
  const parts = [PNG_SIGNATURE];
  let placed = false;
  for (const c of chunks) {
    if (c.type === 'iTXt' || c.type === 'tEXt' || c.type === 'zTXt') {
      const nul = c.data.indexOf(0);
      if (nul > 0 && c.data.toString('latin1', 0, nul) === keyword) continue;
    }
    if (!placed && (c.type === 'IDAT' || c.type === 'IEND')) {
      parts.push(chunk);
      placed = true;
    }
    parts.push(buf.subarray(c.start, c.end));
  }
  if (!placed) parts.push(chunk);
  return new Uint8Array(Buffer.concat(parts));
}

/** The recipe a PNG carries, or null. */
export function recipeInPng(bytes) {
  const text = pngText(bytes).get(PNG_KEYWORD);
  return text ? decodeRecipe(text) : null;
}
