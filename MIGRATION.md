# Migrating from Mikrofuzz 0.x to Krino 1.0

v1.0 renames the package from `@mmmike/mikrofuzz` to `Krino` and redesigns the API primitive-first — a smaller surface and new result shapes.
Here's everything that breaks.
`normalizeText` is unchanged.

## Update the dependency and imports

```diff
- pnpm add @mmmike/mikrofuzz
+ pnpm add krino

- import { fuzzyMatch } from "@mmmike/mikrofuzz";
+ import { fuzzyMatch } from "krino";
```

## `fuzzyMatch` result

Returns `{ score, tier, ranges }` (or `null`) — no `item`/`matches`/`scores`
wrapper. `ranges` is the highlight ranges directly (was `matches[0]`), plus a new
categorical `tier`.

```diff
- const { item, score, matches } = fuzzyMatch(text, query);
- const ranges = matches[0];   // [[6, 8]]
+ const { score, tier, ranges } = fuzzyMatch(text, query);
+ // ranges === [[6, 8]], tier === "boundary"
```

## `createFuzzySearch` — extracting text

The options bag is gone. The second argument is a `getText` function or an array
of field specs.

```diff
  // array of strings — unchanged
  createFuzzySearch(list);

  // objects: `key` is removed — pass a function
- createFuzzySearch(users, { key: "name" });
+ createFuzzySearch(users, (u) => u.name);

  // multiple fields: a getText array becomes field specs
- createFuzzySearch(users, { getText: (u) => [u.name, u.email] });
+ createFuzzySearch(users, [
+   { text: (u) => u.name },
+   { text: (u) => u.email },
+ ]);
```

`strategy` (and the new `acronym`/`penalty`) move onto the field spec:

```diff
- createFuzzySearch(list, { strategy: "off" });
+ createFuzzySearch(list, [{ text: (x) => x, strategy: "off" }]);
```


## Result shape

The parallel `matches` and `scores` arrays are replaced by one `fields` array of
`{ score, tier, ranges }`. `result.item` and `result.score` are unchanged.

```diff
- result.matches[i];          // HighlightRanges | null
+ result.fields[i];           // { score, tier, ranges } | null
+ result.fields[i]?.ranges;
```

## New in 1.0 (non-breaking)

- `tier` on every match — a categorical name (`"exact"` … `"fuzzy"`) beside the score.
- Per-field `penalty` (demote a field) and `acronym` (opt-in word-initials tier).
- `fuzzyMatch(text, query, { strategy, acronym })` options.
- New exports: `SCORES` (tier constants), `splitWords`, `matchDensity`.
- `getText` / `FieldSpec<T>` infer the item type — no cast needed.
