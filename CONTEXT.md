# Diffsplain

Diffsplain turns a Git comparison into a local, file-by-file review with optional
coding agent notes.

## Language

**Review**:
A file-by-file inspection of one Git comparison.
_Avoid_: Presentation, session

**Review target**:
The Git state selected for comparison, such as a checkout, pull request, branch,
worktree, or exact range.
_Avoid_: Repository, source

**Snapshot**:
The complete state for one running review, including its target, patches,
summaries, and note status.
_Avoid_: Diff data, output file

**Agent note**:
A short coding-agent explanation attached to one changed file.
_Avoid_: Summary, review comment

**Change summary**:
A short explanation of the whole change rather than one file.
_Avoid_: Agent note, file summary

**Support record**:
An opt-in, safe account of a failed run that excludes patches, notes, and other
review content.
_Avoid_: Snapshot, debug dump
