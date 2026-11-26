// Build index.json from recipes/*.json: every recipe checked again, with its
// votes (👍 on its issue) and works (comments on its issue that carry a picture).
// Runs in the `index` workflow on every merge and once a day.
//
// node scripts/build-index.mjs [--offline]

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeRecipe } from './recipe-format.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = process.env.GITHUB_REPOSITORY || 'kadaliao/dsh-images-recipes';

/** The recipes in a folder, checked; broken ones are reported and left out. */
export function readRecipes(dir = join(ROOT, 'recipes')) {
  const out = [];
  const problems = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const recipe = normalizeRecipe(raw);
      if (`${recipe.id}.json` !== name) throw new Error(`its id "${recipe.id}" does not match the file name`);
      out.push(recipe);
    } catch (error) {
      problems.push(`${name}: ${error.message}`);
    }
  }
  return { recipes: out, problems };
}

/** Comments that carry a picture, not from a bot: the works made with the recipe. */
export function countWorks(comments) {
  return comments.filter((c) => c.user?.type !== 'Bot' && /!\[[^\]]*\]\(https:|<img\s/i.test(String(c.body ?? ''))).length;
}

/** The index the plugin reads: best voted first, then newest. */
export function composeIndex(recipes, stats = new Map(), now = new Date()) {
  const rows = recipes.map((r) => {
    const s = r.issue ? stats.get(r.issue) : undefined;
    return { ...r, ...(s && (s.votes || s.works) ? { stats: { votes: s.votes, works: s.works } } : {}) };
  });
  rows.sort((a, b) => (b.stats?.votes ?? 0) - (a.stats?.votes ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.id.localeCompare(b.id));
  return {
    format: 1,
    title: { zh: 'DSH Images 社区', en: 'DSH Images community' },
    repo: REPO,
    updatedAt: now.toISOString(),
    recipes: rows,
  };
}

async function api(path) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    headers: { accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

/** Votes and works per issue number. */
async function fetchStats(issues) {
  const stats = new Map();
  for (const number of issues) {
    try {
      const issue = await api(`/issues/${number}`);
      let works = 0;
      for (let page = 1; page <= 10; page += 1) {
        const comments = await api(`/issues/${number}/comments?per_page=100&page=${page}`);
        works += countWorks(comments);
        if (comments.length < 100) break;
      }
      stats.set(number, { votes: issue.reactions?.['+1'] ?? 0, works });
    } catch (error) {
      console.warn(`#${number}: ${error.message}`);
    }
  }
  return stats;
}

async function main() {
  const { recipes, problems } = readRecipes();
  for (const p of problems) console.warn(`skipped ${p}`);
  const offline = process.argv.includes('--offline');
  const stats = offline ? new Map() : await fetchStats([...new Set(recipes.map((r) => r.issue).filter(Boolean))]);
  const index = composeIndex(recipes, stats);
  const file = join(ROOT, 'index.json');
  let before = null;
  try {
    before = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    before = null;
  }
  // Only a change in the recipes or their numbers rewrites the file.
  if (before && JSON.stringify(before.recipes) === JSON.stringify(index.recipes)) {
    console.log('index.json unchanged');
    return;
  }
  writeFileSync(file, `${JSON.stringify(index, null, 2)}\n`);
  console.log(`index.json: ${index.recipes.length} recipes`);
  if (problems.length > 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
