# Repository security operations

## Dependency updates

The dependency graph, Dependabot alerts, and Dependabot security updates are
repository settings. Check them under Settings > Advanced Security. The public
repository's dependency graph includes the pnpm lockfile.

`.github/dependabot.yml` requests npm updates for the pnpm package graph and
GitHub Actions updates every Monday at 09:00 UTC. Each ecosystem allows five
open version-update PRs. Security updates remain enabled independently of that
limit. Updates require review through the normal PR process; automatic merging
is not enabled.

Verify the live settings with:

```sh
gh api repos/itsjling/diffsplain/vulnerability-alerts --include
gh api repos/itsjling/diffsplain/automated-security-fixes
gh api repos/itsjling/diffsplain/dependency-graph/sbom --jq '.sbom.packages | length'
```

Expect HTTP 204 for alerts, `enabled: true` and `paused: false` for security
fixes, and a populated SBOM. After the config reaches main, check
[Dependabot runs](https://github.com/itsjling/diffsplain/network/updates) for
both ecosystems. A config on a feature branch does not activate version updates.

## Main branch rules

The JSON files in `.github/rulesets/` describe the intended active rules.
GitHub does not automatically apply these files. Check the actual state at
[repository rules](https://github.com/itsjling/diffsplain/rules).

- `main-history` blocks deletion and force pushes. Only repository admins can
  bypass it for emergency recovery. The release key cannot bypass this rule.
- `main-review` requires a PR, resolved review threads, an up-to-date branch,
  and the five checks below. It requires zero approving reviews, as agreed in
  [issue #129](https://github.com/itsjling/diffsplain/issues/129). A maintainer
  can merge their own work after CI passes.

| Required check | PR trigger |
| --- | --- |
| Automation trust review | `pull_request_target` |
| Product gate (Node 24.20.0) | `pull_request` |
| unit | `pull_request` |
| integration | `pull_request` |
| browser | `pull_request` |

Checks are bound to the GitHub Actions app, ID 15368. Keep the exact names in
sync when workflows change. Platform jobs, site deployment, live-provider
canaries, and scheduled or manual-only checks are not required. The Fallow
audit remains advisory. Dependabot PRs run the required jobs without secrets.
Changes to the release workflow require the existing `automation-reviewed`
label after a maintainer reviews the automation diff.

## Release identity

Only the publish job in `.github/workflows/release.yml` receives
`RELEASE_PUSH_KEY`, an environment secret in `npm-publish`. That environment
allows the `main` branch only. The preparation job has no push key or npm
publication credential. Both workflow tokens have read-only contents access.
The publish job still uses npm trusted publishing through OIDC.

The key is the repository's sole write deploy key, titled
`npm-publish release push`. It bypasses only `main-review`, so the finalizer can
atomically push its verified release commit and tag before npm publication.
The workflow fails if the key is missing instead of using its default token.
The commit author `github-actions[bot]` is metadata, not the bypass identity.

GitHub's [ruleset API](https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset)
uses `DeployKey` with a null actor ID. This grants the exception to all write
deploy keys on the repository. Keep this as the only write deploy key; adding
another one expands release authority. Do not store it as a repository secret
or give it to PR jobs. Admins can change the environment and rules and are
trusted recovery actors.

To rotate the key, pause release dispatches, generate a new Ed25519 key, add
its public half as a write deploy key, and replace the environment secret:

```sh
gh secret set RELEASE_PUSH_KEY --env npm-publish < /secure/path/release-key
```

Remove the old deploy key in Settings > Deploy keys, verify the remaining
key, then remove local private-key copies. Never put keys in Git or issue logs.

## Rollout and recovery

Issue #129 activates `main-history` immediately and stages `main-review` as
disabled. Activate the latter only after the release credential change has
merged into main and `RELEASE_PUSH_KEY` is installed. Activating it against the
old workflow would prevent releases because its default token cannot bypass.

From a checkout of the merged main revision, apply the reviewed rule:

```sh
gh api --method PUT repos/itsjling/diffsplain/rulesets/22360425 \
  --input .github/rulesets/main-review.json
gh api repos/itsjling/diffsplain/rulesets/22360425 --jq '{name, enforcement, bypass_actors, rules}'
```

Before closing #129, confirm the active rule, both Dependabot ecosystem runs,
and the initial OpenSSF Scorecard result when available. Monitoring is tracked
in [issue #127](https://github.com/itsjling/diffsplain/issues/127). No Scorecard
workflow was present during rollout, and the public results API returned 404.
Record unavailable or stale results explicitly.
The zero-review policy and admin/release bypasses may lower Branch-Protection
scoring; do not add mandatory reviews or remove release access to improve a score.

For an emergency, an administrator can bypass the rule for the necessary push
or use Settings > Rules > Rulesets to repair a mistaken check or bypass entry.
Record every emergency use and its reason, actor, affected refs and commits,
and any settings changed in the affected issue or PR. Restore the intended
rules from the reviewed JSON and confirm enforcement after recovery. Normal
work, including an admin's normal changes, should use PRs.

To verify enforcement without publishing, create a disposable branch with
copies of both rules targeting only that branch. Remove the admin bypass from
the copies so an admin token can test an ordinary actor. Confirm an ordinary
ref update is rejected for missing PR/checks, a fast-forward release-key push
succeeds, and release-key force pushes and deletion fail. Delete the temporary
rules before deleting the branch. Never use main as the rejection-test target
or dispatch a production release just to test branch protection.
