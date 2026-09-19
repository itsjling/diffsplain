# Temporary dependency security overrides

Reviewed on 2026-09-19 after updating to Blume 1.7.0. The full audit reported
two advisory entries for `lodash-es` in development dependencies; the
production-only audit was clean. These are package-version findings, not proof
of exploitability in Diffsplain's configured product surfaces.

`pnpm-workspace.yaml` contains version-bounded overrides. They upgrade only the
installed affected major lines, preserving newer patched versions and other
major lines. Keep both js-yaml 3 and 4; do not force all consumers onto one major.

| Package | Override target | Advisories |
| --- | --- | --- |
| brace-expansion | 2.1.4 / 5.0.9 | [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895) |
| dompurify | 3.4.13 | [GHSA-55q2-fjhq-7xh7](https://github.com/advisories/GHSA-55q2-fjhq-7xh7) |
| fast-uri | 3.1.6 | [GHSA-5jgf-p345-68v8](https://github.com/advisories/GHSA-5jgf-p345-68v8), [GHSA-7p8r-x3mc-p8w7](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7), [GHSA-f65p-4m7j-42xc](https://github.com/advisories/GHSA-f65p-4m7j-42xc), [GHSA-fph4-wmhf-6fwf](https://github.com/advisories/GHSA-fph4-wmhf-6fwf), [GHSA-jqff-g426-hqxp](https://github.com/advisories/GHSA-jqff-g426-hqxp) |
| hono | 4.13.5 | [GHSA-54fx-42gc-7vw4](https://github.com/advisories/GHSA-54fx-42gc-7vw4), [GHSA-79qm-7rj5-m7r9](https://github.com/advisories/GHSA-79qm-7rj5-m7r9), [GHSA-8j4g-w8fx-2239](https://github.com/advisories/GHSA-8j4g-w8fx-2239), [GHSA-crvj-82cr-hjcx](https://github.com/advisories/GHSA-crvj-82cr-hjcx), [GHSA-f23p-vx2j-j53r](https://github.com/advisories/GHSA-f23p-vx2j-j53r), [GHSA-g6gw-c38x-mqfc](https://github.com/advisories/GHSA-g6gw-c38x-mqfc), [GHSA-gqvv-2mrq-wpjv](https://github.com/advisories/GHSA-gqvv-2mrq-wpjv) |
| js-yaml | 3.15.2 / 4.3.2 | [GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh), [GHSA-5p4m-2wfm-xmqj](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj) |
| nanoid | 3.3.18 | [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) |
| path-to-regexp | 6.3.0 | [GHSA-9wv6-86v2-598j](https://github.com/advisories/GHSA-9wv6-86v2-598j) |
| qs | 6.16.0 | [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g), [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx) |
| svgo | 4.1.0 | [GHSA-4vpr-x523-8j87](https://github.com/advisories/GHSA-4vpr-x523-8j87), [GHSA-w27v-7q3p-w38r](https://github.com/advisories/GHSA-w27v-7q3p-w38r) |

## Removed overrides

Blume 1.7.0 no longer depends on `image-size`. The 2026-09-19 removal check
found neither `image-size` nor `image-size-next` in the unoverridden dependency
graph, and both audits reported no image parser advisory. The image audit test
still covers malformed ICNS, JXL, and HEIF files and valid PNG and SVG files.

## Compatibility

Most targets satisfy the parent package's dependency range.
`@vercel/routing-utils@6.6.0` still depends on `path-to-regexp` 6.1.0, alongside
a `path-to-regexp-updated` alias at 6.3.0. Removing the override restores the
vulnerable 6.1.0 copy and makes `pnpm audit` report GHSA-9wv6-86v2-598j. Keep
the override until every resolved copy is patched. Check route compilation as
well as the static docs build when changing or removing it. Diffsplain deploys
static docs to GitHub Pages, without a Vercel server adapter.

The release-age exceptions elsewhere in `pnpm-workspace.yaml` are separate from
these security overrides. They allow the explicitly requested latest direct
releases and their associated dependencies through pnpm's release-age policy.

## Re-evaluation and removal

Re-evaluate after each direct dependency update, especially Blume updates, and
at the next dependency maintenance review. For each override:

1. Use `pnpm why <package>` to identify every parent retaining the affected line.
2. Remove that override in a working branch and run `pnpm install`.
3. Check every resolved copy in `pnpm-lock.yaml`, then run `pnpm audit` and
   `pnpm audit --prod`. A clean audit with the override still present does not
   prove the override is unnecessary.
4. If vulnerable versions return, restore the override and update the parent
   dependency when possible. Record any newly required patched minimum here.
5. Before merging removal, run `pnpm run lint`, `pnpm test`,
   `pnpm run docs:check`, and `pnpm run docs:build`.

Do not remove these overrides simply because an advisory was dismissed or
because a newer version exists in the registry. The unoverridden dependency
graph must resolve patched versions for every affected copy.
