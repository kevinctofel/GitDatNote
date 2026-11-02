# Editing OpenSpec and companion docs — mechanics

Reliable editing of `tasks.md`, `design.md`, `spec.md`, `proposal.md`, `audit.md`, and session handoff docs.

## Prefer `patch` for markdown edits
- Use the `patch` tool for markdown text edits rather than embedding long strings in Python. Text copied out of a file may contain unbalanced parentheses (a fragment missing its closing paren); an unbalanced string literal makes Python fail at compile time, and the SyntaxError surfaces at the list/array-closing line, not at the offending string. When that happens, no edit was applied at all.
- If you do use `execute_code` for string replacement, verify copied fragments are parenthesis-balanced before running.

## `execute_code` exact-replacement pattern (multi-edit batches)
1. Read the whole file fresh. A previously paginated/truncated read of the same file in this task can make the `write_file` tool refuse the overwrite ("Refusing to overwrite"); a full fresh read avoids that.
2. Build a list of (old, new) pairs.
3. Assert `s.count(old) == 1` for every pair before applying any replacement.
4. Apply all replacements and write once — assert first, write last, so a mismatch leaves the file untouched.
5. When a mismatch fails an assertion: capture the exact current text with `grep -n <keyword> <file>` + `sed -n 'A,Bp' <file>` (add `cat -A` when whitespace is suspect), then retry with the captured text. Never guess at the text.

## Validation warnings
- `openspec validate` requirement-length warnings ("Requirement text is very long (>500 characters)") are non-blocking. Track the pre-existing baseline; a warning your edit introduced is yours to fix before finishing.
- Fix an over-long requirement by splitting it into a standalone requirement with its own scenario (one behavior per requirement), not by compressing wording below the needed precision.
- Re-run `openspec validate <change>` after every artifact edit, including tasks.md-only edits.
