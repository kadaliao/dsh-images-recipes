# DSH Images community recipes

English | [简体中文](README.zh-CN.md)

The recipes (玩法) people share for [DSH Images](https://github.com/kadaliao/dsh-images), the image
plugin for DeepSeek Harness. The plugin reads [`index.json`](index.json) once a week: every recipe
merged here shows up in **Images → Recipes → Community** for everyone who follows this source
(the default).

A recipe is a tested prompt template with blanks (`{{name}}`, each with a default), the size or
animation it is drawn with, and who made it. In the plugin you fill in the blanks and start a
conversation with it; the model draws from it with `generate_image`.

## Share a recipe

1. In the Images panel, open one of your recipes (**Recipes → Mine**; any picture becomes one with
   **⋯ → Save as a recipe**) and choose **Share to community**. The panel shows exactly what will be
   public — title, summary, prompt, parameters; never your photos or conversations — and opens a
   new issue here with the recipe filled in.
2. Drag a picture made with the recipe into the issue's **Cover** field, tick the boxes and submit.
   (Without the plugin at hand: [open the form](../../issues/new?template=recipe.yml) and paste a
   recipe code or the recipe's JSON.)
3. The `intake` workflow checks the recipe and opens a pull request with it and its cover. If
   something is wrong it says so in a comment; editing the issue checks it again.
4. Once the pull request is merged, the `index` workflow rebuilds `index.json`, and the issue is
   labelled `published`.

The issue stays open as the recipe's home: **👍 on it is a vote**, and pictures made with it go in
its comments — the plugin's **Post to the works wall** copies your picture and opens this page. Votes
and works are counted into the index once a day, and the plugin sorts community recipes by votes.

## Rules

- Your own work, or credited to its source under a licence that allows it.
- No real public figures, no named copyrighted characters, franchises, brands, studios or living
  artists — describe the style instead. Nothing sexual, gory or hateful.
- No links in the prompt. Recipes are reviewed before they are merged; the plugin also tells the
  conversation model that a community recipe is someone else's text, to be used as a prompt and
  never followed as instructions.

## Run your own source

Any HTTPS URL serving an index in this format works as a source: add it under **Images → Recipes →
Sources**. A team can fork this repository, or serve one file:

```json
{
  "format": 1,
  "title": { "zh": "我们组的玩法", "en": "Our team's recipes" },
  "recipes": [
    {
      "id": "neon-sign",
      "title": { "zh": "霓虹灯牌", "en": "Neon sign" },
      "summary": { "zh": "砖墙上的霓虹灯字", "en": "A neon sign on a brick wall" },
      "category": "illustration",
      "tags": ["neon", "night"],
      "inputs": [],
      "slots": [{ "name": "text", "label": { "zh": "文字", "en": "Text" }, "default": "OPEN" }],
      "prompt": "A glowing neon sign on a brick wall at night that reads \"{{text}}\"",
      "params": { "size": "1536x1024" },
      "cover": "covers/neon-sign.webp"
    }
  ]
}
```

`category` is one of `photo`, `handdrawn`, `editorial`, `infographic`, `3d`, `sticker`,
`illustration`, `product`, `comic`. `inputs` lists the pictures the user must attach, in order.
`params` takes `size` (`1024x1024`, `1536x1024`, `1024x1536`, `auto`), `quality`, and `frames`
(4, 6, 9, 16) with `frameMs` for an animated GIF. A relative `cover` is resolved against the
index's own URL. The format is checked by [`scripts/recipe-format.mjs`](scripts/recipe-format.mjs),
a copy of the plugin's `lib/recipes.mjs`.

## Setting up a copy

After creating the repository: create the labels `recipe`, `needs-fix` and `published`; under
**Settings → Actions → General** give workflows read and write permission and allow GitHub Actions
to create pull requests.

## Licence

Recipes and covers are published under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/);
each names its author (`author`) and, when adapted, its source (`source`). The scripts are MIT.
