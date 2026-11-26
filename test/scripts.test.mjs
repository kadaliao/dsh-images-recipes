import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { composeIndex, countWorks, readRecipes } from '../scripts/build-index.mjs';
import { firstImageUrl, formSections, readSubmission } from '../scripts/intake.mjs';
import { encodeRecipe, normalizeRecipe } from '../scripts/recipe-format.mjs';

const RECIPE = normalizeRecipe({
  id: 'neon-sign',
  title: { zh: '霓虹灯牌', en: 'Neon sign' },
  prompt: 'A glowing neon sign on a brick wall at night that reads "{{text}}", reflections on wet pavement',
  slots: [{ name: 'text', default: 'OPEN' }],
  params: { size: '1536x1024' },
});

/** An issue body as GitHub writes it from the form. */
const body = (recipe, cover = '_No response_', notes = '_No response_') =>
  `### 配方 · Recipe\n\n${recipe}\n\n### 封面 · Cover\n\n${cover}\n\n### 说明 · Notes\n\n${notes}\n\n### 确认 · Agreement\n\n- [X] ok`;

test('a submission is read from the issue form: the recipe, its cover, its author', () => {
  const issue = {
    number: 12,
    user: { login: 'ana' },
    body: body(`看看这个\n【DSH Images 玩法】霓虹灯牌\n${encodeRecipe(RECIPE)}`, '<img width="512" alt="x" src="https://github.com/user-attachments/assets/abc-123" />', 'tried on gpt-image-2'),
  };
  assert.deepEqual(Object.keys(formSections(issue.body)), ['配方 · Recipe', '封面 · Cover', '说明 · Notes', '确认 · Agreement']);
  const got = readSubmission(issue);
  assert.equal(got.ok, true);
  assert.equal(got.recipe.id, 'neon-sign');
  assert.equal(got.recipe.author, 'github:ana');
  assert.equal(got.recipe.issue, 12);
  assert.equal(got.coverUrl, 'https://github.com/user-attachments/assets/abc-123');
  assert.equal(got.notes, 'tried on gpt-image-2');

  // The same id from another issue is told apart; from the same issue it is kept.
  assert.equal(readSubmission(issue, new Map([['neon-sign', 3]])).recipe.id, 'neon-sign-12');
  assert.equal(readSubmission(issue, new Map([['neon-sign', 12]])).recipe.id, 'neon-sign');
});

test('a submission that cannot be taken says why', () => {
  const issue = (recipe) => ({ number: 1, user: { login: 'x' }, body: body(recipe) });
  assert.match(readSubmission(issue('_No response_')).reason, /empty/);
  assert.match(readSubmission(issue('hello')).reason, /no recipe code/);
  assert.match(readSubmission(issue(encodeRecipe({ ...RECIPE, prompt: 'short' }))).reason, /too short/);
  assert.match(readSubmission(issue(encodeRecipe({ ...RECIPE, prompt: `${RECIPE.prompt} see https://evil.example.com` }))).reason, /links/);
  // A picture from anywhere but GitHub is not fetched.
  assert.equal(firstImageUrl('![x](https://evil.example.com/a.png)'), null);
  assert.equal(firstImageUrl('![x](https://github.com/user-attachments/assets/1)'), 'https://github.com/user-attachments/assets/1');
});

test('the index puts the best voted first and counts works', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recipes-'));
  writeFileSync(join(dir, 'neon-sign.json'), JSON.stringify({ ...RECIPE, issue: 4, createdAt: 1 }));
  writeFileSync(join(dir, 'other.json'), JSON.stringify({ ...RECIPE, id: 'other', issue: 5, createdAt: 2 }));
  writeFileSync(join(dir, 'wrong-name.json'), JSON.stringify({ ...RECIPE, id: 'different' }));
  writeFileSync(join(dir, 'broken.json'), '{');
  const { recipes, problems } = readRecipes(dir);
  assert.deepEqual(recipes.map((r) => r.id), ['neon-sign', 'other']);
  assert.equal(problems.length, 2);
  assert.equal(countWorks([{ user: { type: 'User' }, body: 'mine ![a](https://x/y.png)' }, { user: { type: 'Bot' }, body: '<img src="x">' }, { user: { type: 'User' }, body: 'nice!' }]), 1);
  const index = composeIndex(recipes, new Map([[5, { votes: 3, works: 1 }]]), new Date(0));
  assert.deepEqual(index.recipes.map((r) => [r.id, r.stats]), [['other', { votes: 3, works: 1 }], ['neon-sign', undefined]]);
  assert.equal(index.format, 1);
  assert.equal(index.updatedAt, '1970-01-01T00:00:00.000Z');
});
