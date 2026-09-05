---
target: $impeccable critique
total_score: 27
max_score: 32
na_heuristics: 7,10
p0_count: 0
p1_count: 3
timestamp: 2026-09-04T08-26-12Z
slug: site-index-html
---
# Diffsplain landing page critique

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Strong file, copy, and search feedback; the demo is not announced as interactive before engagement. |
| 2 | Match System / Real World | 4 | PR, diff, file-path, change-count, agent-note, and CLI language match developer expectations. |
| 3 | User Control and Freedom | 3 | Navigation, Escape/backdrop close, cyclic movement, and focus return are strong; filtered state has no explicit clear action. |
| 4 | Consistency and Standards | 4 | Typography, semantic color, borders, and controls form a coherent system. |
| 5 | Error Prevention | 3 | The surface is low-risk and copy failure has a fallback; trust expectations are absent beside the first command. |
| 6 | Recognition Rather Than Recall | 3 | Visible paths, counts, arrows, and shortcut hints help; the interactive nature and keyboard behavior remain understated. |
| 7 | Flexibility and Efficiency | n/a | Persuade surface; expert efficiency is demonstrated in the preview rather than being the landing-page task. |
| 8 | Aesthetic and Minimalist Design | 4 | Exceptionally disciplined composition; almost every element supports the story. |
| 9 | Error Recovery | 3 | Copy failure is actionable; few other error-producing actions apply. |
| 10 | Help and Documentation | n/a | Persuade surface; linked product documentation is sufficient supporting navigation. |
| **Total** | | **27/32** | **Good (84%)** |

## Design Specificity Verdict

Strongly product-specific. The warm review-desk world, carbon toolbar, semantic diff colors, mono evidence typography, and paired diff/agent-note layout could not be transferred unchanged to generic SaaS. The actual interaction provides proof instead of a feature-card abstraction. Conversion specificity is weaker: GitHub, the command, and the interactive demo are all present, but none owns the “do this now” moment.

The deterministic scan returned zero findings for `site/index.html`. It did not contradict the design review; instead, it confirms that the main opportunities are hierarchy, trust sequencing, invitation, and responsive persuasion rather than mechanical anti-patterns. Mutable browser injection succeeded, but preview visibility and readback timed out, so no reliable user-visible overlay or console result is claimed.

## Overall Impression

This is a rare developer-tool landing page with an authored, credible visual world. Its largest opportunity is to turn excellent product proof into a decisive, trustworthy next action.

## What's Working

- **The product is the hero.** A real ten-file diff-and-note experience establishes credibility immediately.
- **The visual system fits the work.** Paper neutrals support calm reading; semantic colors remain reserved for change and review meaning.
- **The interaction craft is deep.** Search, keyboard traversal, Escape/backdrop close, focus return, swipe support, reduced motion, live announcements, and copy feedback make the demo functional proof.

## Priority Issues

### [P1] The primary conversion action is visually underpowered

**Why it matters:** “View on GitHub” is a quiet text link beside an equally quiet secondary action, while the command and demo dominate. Visitors can understand the product without feeling a decisive next step.

**Fix:** Give GitHub one unmistakable primary treatment, or make the command block the primary runnable action with an inline copy control. Keep “Run it locally” clearly secondary.

**Suggested command:** `$impeccable bolder`

### [P1] Trust arrives after the commitment request

**Why it matters:** Running an unfamiliar `npx` package against a repository is a high-trust moment. The local/read-only model appears after the hero has already asked the visitor to run it.

**Fix:** Put a compact reassurance directly beneath the hero command: local review, read-only checkout, and use of existing authenticated CLIs. Link the detailed explanation there.

**Suggested command:** `$impeccable clarify`

### [P1] The displayed command conflicts with the surface brief

**Why it matters:** The brief names `npx diffsplain --pr 198`; the page uses `npx diffsplain@latest react/react --pr 37127`. Conflicting maintained guidance erodes confidence.

**Fix:** Resolve the canonical example and apply it consistently to the hero, run section, copy payload, metadata, and documentation context.

**Suggested command:** `$impeccable clarify`

### [P2] The demo does not explicitly invite interaction

**Why it matters:** Miniature arrows, `⌘K`, and “← → to move” can read as screenshot chrome, so the strongest proof may go untouched.

**Fix:** Add a restrained “Interactive demo · choose a file” cue and make the selector affordance clearer without introducing another CTA.

**Suggested command:** `$impeccable delight`

### [P2] The mobile proof surface is dense and scroll-heavy

**Why it matters:** At small widths, the fixed-height demo stacks two independently scrollable panes inside a long page, making the proof a substantial interaction commitment.

**Fix:** Show a concise note and bounded diff excerpt on mobile, with an explicit expansion into the full demo. Preserve full fidelity on larger screens.

**Suggested command:** `$impeccable adapt`

## Persona Red Flags

- **Jordan, first-time visitor:** The value proposition lands, but the reader may look like a static screenshot. Jordan meets a CLI command, two text links, and a dense review surface before learning that the workflow is local and read-only.
- **Priya, security-conscious staff engineer:** The first command appears before credential, checkout-mutation, and external-service expectations. The later reassurance is useful but too far from the risk moment.
- **Alex, power user:** The keyboard path is strong, but a command that differs from the maintained surface brief immediately raises doubt about whether the page reflects the current CLI.

## Minor Observations

- “Open source” in the masthead is static text rather than navigation or evidence.
- The hero command has no copy button, although the repeated lower command does.
- “Written by GPT 5.6 Sol (Codex)” may age faster than the otherwise timeless page.
- The copy toast is accessible but visually disconnected from the copied command.
- The closing GitHub action repeats the hero without adding new proof or urgency.

## Questions to Consider

- Is the primary conversion “inspect the repository” or “run Diffsplain now”?
- What reassurance belongs beside the first command before a developer allows it to inspect a work repository?
- Could one line of interface copy teach the demo without relying on miniature arrows and a keyboard hint?
- On mobile, is a full miniature workspace more persuasive than one perfectly legible change-and-reason pair?
