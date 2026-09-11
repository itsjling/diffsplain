# Temporary dependency security overrides

Reviewed on 2026-09-10 after updating direct dependencies. The full audit
reported 27 advisory entries in development dependencies; the production-only
audit was clean. These are package-version findings, not proof of exploitability
in Diffsplain's configured product surfaces.

`pnpm-workspace.yaml` contains version-bounded overrides. They upgrade only the
installed affected major lines, preserving newer patched versions and other
major lines. Keep both js-yaml 3 and 4; do not force all consumers onto one major.

| Package | Override target | Advisories |
| --- | --- | --- |
| brace-expansion | 2.1.4 / 5.0.9 | [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895) |
| dompurify | 3.4.13 | [GHSA-55q2-fjhq-7xh7](https://github.com/advisories/GHSA-55q2-fjhq-7xh7) |
| fast-uri | 3.1.6 | [GHSA-5jgf-p345-68v8](https://github.com/advisories/GHSA-5jgf-p345-68v8), [GHSA-7p8r-x3mc-p8w7](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7), [GHSA-f65p-4m7j-42xc](https://github.com/advisories/GHSA-f65p-4m7j-42xc), [GHSA-fph4-wmhf-6fwf](https://github.com/advisories/GHSA-fph4-wmhf-6fwf), [GHSA-jqff-g426-hqxp](https://github.com/advisories/GHSA-jqff-g426-hqxp) |
| hono | 4.13.5 | [GHSA-54fx-42gc-7vw4](https://github.com/advisories/GHSA-54fx-42gc-7vw4), [GHSA-79qm-7rj5-m7r9](https://github.com/advisories/GHSA-79qm-7rj5-m7r9), [GHSA-8j4g-w8fx-2239](https://github.com/advisories/GHSA-8j4g-w8fx-2239), [GHSA-crvj-82cr-hjcx](https://github.com/advisories/GHSA-crvj-82cr-hjcx), [GHSA-f23p-vx2j-j53r](https://github.com/advisories/GHSA-f23p-vx2j-j53r), [GHSA-g6gw-c38x-mqfc](https://github.com/advisories/GHSA-g6gw-c38x-mqfc), [GHSA-gqvv-2mrq-wpjv](https://github.com/advisories/GHSA-gqvv-2mrq-wpjv) |
| image-size | npm:image-size-next@2.1.1 | [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq), [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) |
| js-yaml | 3.15.2 / 4.3.2 | [GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh), [GHSA-5p4m-2wfm-xmqj](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj) |
| nanoid | 3.3.18 | [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) |
| path-to-regexp | 6.3.0 | [GHSA-9wv6-86v2-598j](https://github.com/advisories/GHSA-9wv6-86v2-598j) |
| qs | 6.16.0 | [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g), [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx) |
| svgo | 4.1.0 | [GHSA-4vpr-x523-8j87](https://github.com/advisories/GHSA-4vpr-x523-8j87), [GHSA-w27v-7q3p-w38r](https://github.com/advisories/GHSA-w27v-7q3p-w38r) |

## Image parser fork

Upstream `image-size` is archived. The audit suggests 2.0.3, but that version
was not published at review time. The alias switches publisher to
[`image-size-next`](https://github.com/lcf2212dev/image-size-next), pinned to
2.1.1. Its [security fix](https://github.com/lcf2212dev/image-size-next/commit/3b4976fc84da6e4adf56cf82fcc6226a81a1eaef)
adds entry-length, bounds, and forward-progress checks to the affected parsers.
The lockfile pins the published tarball integrity.

The published package was tested with malformed ICNS, JXL, and HEIF inputs:
upstream 2.0.2 timed out, while the fork rejected them. Valid ICNS, JXL, HEIF,
PNG, and SVG headers retained their dimensions. Keep the bounded regressions
in `tests/dependency-overrides.test.mjs` when evaluating a replacement.
A clean npm audit alone is insufficient here because aliasing changes the
package identity used for advisory matching.

Re-evaluate the fork's maintenance and security status at the next dependency
update. Prefer a maintained upstream patched release if one becomes available;
otherwise verify any replacement against the same cases and the docs build.

## Compatibility

Most targets satisfy the parent package's dependency range.
`@vercel/routing-utils@6.5.0` pins `path-to-regexp` to 6.1.0, so its override
intentionally replaces that exact pin with 6.3.0. Check route compilation as
well as the static docs build when changing or removing it. Diffsplain currently
deploys static docs to GitHub Pages, without a Vercel server adapter.

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
