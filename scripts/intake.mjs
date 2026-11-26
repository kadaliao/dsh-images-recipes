// Check one recipe submitted through the issue form and open (or update) a pull
// request that adds it. Runs in the `intake` workflow on an issue labelled
// `recipe`; reads the event from GITHUB_EVENT_PATH and never runs anything the
// issue says. A submission that does not pass gets a comment saying why.
//
// The parts that need no network are exported for the tests.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseRecipeText, slugify } from './recipe-format.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_COVER_BYTES = 8 * 1024 * 1024;
const COVER_WIDTH = 768;

/** The sections of an issue-form body, by their heading: `### Label\n\nvalue`. */
export function formSections(body) {
  const out = {};
  const parts = String(body ?? '').replace(/\r\n?/g, '\n').split(/^### /m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const heading = (nl < 0 ? part : part.slice(0, nl)).trim();
    const value = nl < 0 ? '' : part.slice(nl + 1).trim();
    out[heading] = value === '_No response_' ? '' : value;
  }
  return out;
}

/** The section whose heading starts with one of `names`. */
function section(sections, ...names) {
  const key = Object.keys(sections).find((k) => names.some((n) => k.startsWith(n)));
  return key ? sections[key] : '';
}

/** The first image a section links (markdown or <img>), on GitHub's own hosts only. */
export function firstImageUrl(text) {
  const found = [...String(text ?? '').matchAll(/!\[[^\]]*\]\((https:\/\/[^)\s]+)\)|<img[^>]+src="(https:\/\/[^"]+)"/g)].map((m) => m[1] ?? m[2]);
  return found.find((u) => /^https:\/\/(github\.com\/user-attachments\/|user-images\.githubusercontent\.com\/|private-user-images\.githubusercontent\.com\/)/.test(u)) ?? null;
}

/**
 * What a submission adds: the recipe as it will be stored, or the reason it cannot be.
 * @param {{number: number, user: {login: string}, body: string}} issue
 * @param {string[]} taken - ids already in recipes/, each with the issue it came from
 */
export function readSubmission(issue, taken = new Map()) {
  const sections = formSections(issue.body);
  const text = section(sections, '配方', 'Recipe');
  if (text === '') return { ok: false, reason: 'the Recipe field is empty / 配方栏是空的' };
  let recipe;
  try {
    recipe = parseRecipeText(text);
  } catch (error) {
    return { ok: false, reason: `${error.message} / 配方读不出来` };
  }
  if (recipe.prompt.length < 20) return { ok: false, reason: 'the prompt is too short to be a recipe / 提示词太短' };
  if (/https?:\/\//i.test(recipe.prompt)) return { ok: false, reason: 'the prompt may not contain links / 提示词里不能有链接' };
  let id = recipe.id || slugify(recipe.title.en ?? '') || `r-${issue.number}`;
  // An id another issue already holds gets this issue's number.
  if (taken.has(id) && taken.get(id) !== issue.number) id = `${id.slice(0, 40)}-${issue.number}`;
  const stored = { ...recipe, id, author: `github:${issue.user.login}`, issue: issue.number };
  delete stored.cover;
  delete stored.stats;
  return { ok: true, recipe: stored, coverUrl: firstImageUrl(section(sections, '封面', 'Cover')), notes: section(sections, '说明', 'Notes') };
}

/** The ids in recipes/, with the issue each came from. */
export function takenIds(dir = join(ROOT, 'recipes')) {
  const taken = new Map();
  if (!existsSync(dir)) return taken;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      taken.set(r.id, r.issue);
    } catch {
      // A broken file is the index build's to report.
    }
  }
  return taken;
}

async function api(path, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', ...init.headers },
  });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}
const comment = (number, body) => api(`/issues/${number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
const label = (number, labels) => api(`/issues/${number}/labels`, { method: 'POST', body: JSON.stringify({ labels }) });
const unlabel = (number, name) => api(`/issues/${number}/labels/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => null);

/** The cover as a WebP of at most COVER_WIDTH wide, or null. */
async function fetchCover(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`the cover could not be downloaded (${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_COVER_BYTES) throw new Error('the cover is larger than 8 MB');
  const { default: sharp } = await import('sharp');
  const meta = await sharp(bytes).metadata();
  if (!['png', 'jpeg', 'webp', 'gif'].includes(meta.format)) throw new Error('the cover must be a PNG, JPEG or WebP picture');
  return sharp(bytes, { animated: meta.format === 'gif' }).resize({ width: COVER_WIDTH, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const issue = event.issue;
  if (!issue || !(issue.labels ?? []).some((l) => l.name === 'recipe')) return;
  const got = readSubmission(issue, takenIds());
  if (!got.ok) {
    await label(issue.number, ['needs-fix']);
    await comment(issue.number, `这个投稿还不能收录：${got.reason}\n\nThis submission cannot be taken yet: ${got.reason}\n\n编辑这个 issue 改好后会自动重新检查。Edit the issue to fix it; it is checked again on every edit.`);
    return;
  }
  const { recipe } = got;
  let cover = null;
  let coverNote = '';
  if (got.coverUrl) {
    try {
      cover = await fetchCover(got.coverUrl);
    } catch (error) {
      coverNote = `\n\n封面没能处理（${error.message}），先不带封面收录。The cover could not be used (${error.message}); the recipe goes in without one.`;
    }
  } else coverNote = '\n\n没有封面：加一张会更容易被看到。No cover: one makes it much easier to find.';

  const branch = `recipe/issue-${issue.number}`;
  git('config', 'user.name', 'github-actions[bot]');
  git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
  git('checkout', '-B', branch);
  mkdirSync(join(ROOT, 'recipes'), { recursive: true });
  if (cover) {
    mkdirSync(join(ROOT, 'covers'), { recursive: true });
    writeFileSync(join(ROOT, 'covers', `${recipe.id}.webp`), cover);
    recipe.cover = `covers/${recipe.id}.webp`;
  }
  recipe.createdAt = recipe.createdAt ?? Date.parse(issue.created_at);
  writeFileSync(join(ROOT, 'recipes', `${recipe.id}.json`), `${JSON.stringify(recipe, null, 2)}\n`);
  git('add', 'recipes', 'covers');
  if (git('status', '--porcelain') === '') return;
  git('commit', '-m', `Add the recipe "${recipe.title.zh ?? recipe.title.en}" from #${issue.number}`);
  git('push', '--force', 'origin', branch);

  const open = await api(`/pulls?state=open&head=${process.env.GITHUB_REPOSITORY.split('/')[0]}:${encodeURIComponent(branch)}`);
  let pr = open[0];
  if (!pr) {
    pr = await api('/pulls', {
      method: 'POST',
      body: JSON.stringify({
        title: `配方 · Recipe: ${recipe.title.zh ?? recipe.title.en}`,
        head: branch,
        base: 'main',
        body: `From #${issue.number} by @${issue.user.login}.\n\n${got.notes ? `> ${got.notes.replace(/\n/g, '\n> ')}\n\n` : ''}\`\`\`text\n${recipe.prompt}\n\`\`\``,
      }),
    });
  }
  await unlabel(issue.number, 'needs-fix');
  await comment(issue.number, `收到，配方检查通过，等待审核：#${pr.number}${coverNote}\n\nReceived and checked; waiting for review in #${pr.number}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
