# GitDatNote 2.0 — OpenSpec starter package

This package contains **planning and specification files only**, not a working CMS. Copy the `openspec/` and `docs/` directories into the root of the existing [GitDatNote](https://github.com/kevinctofel/GitDatNote) repository. **Do not replace** the existing app's README, package.json, or source files with this package.

## Quick start (Fedora / Linux)

```bash
cd GitDatNote
git switch -c feat/openspec-foundation
npm install -g @fission-ai/openspec@latest
# First run `openspec init` if the repo has never been initialized.
# Select an assistant if offered, then copy these supplied files into the repo.
openspec list
openspec validate modernize-gitdatnote-foundation
openspec show modernize-gitdatnote-foundation
```

If `openspec init` produces `openspec/config.yaml`, preserve the supplied package version or merge it deliberately. Do not run init *after* copying without checking whether it will modify files. If the CLI command names differ in your installed version, run `openspec --help`.

## Working sequence

1. Read `docs/PRODUCT-BRIEF.md`, `docs/ROADMAP.md`, and the active change's `proposal.md`.
2. Have the agent **inspect actual repository code** and revise assumptions in `design.md` and `tasks.md`; the old source code may have changed.
3. Review security/authentication decisions and repository-creation permission constraints before implementation.
4. Implement the foundation change in small commits, with tests, following `tasks.md`.
5. Validate behavior and archive the change only after completion. Create later changes for editor, blog creation, publishing, and domains.

## Note about Hermes Agent

OpenSpec does not automatically guarantee Hermes slash-command integration. If Hermes does not discover an OpenSpec workflow, ask it to read these markdown files explicitly and follow the task checklist. The OpenSpec CLI can still validate and manage change artifacts independently.

## Package contents

- `openspec/config.yaml`: project context and artifact rules.
- `openspec/changes/modernize-gitdatnote-foundation/`: first proposed change with proposal, design, tasks, and three delta specs.
- `docs/PRODUCT-BRIEF.md`: product scope and principles.
- `docs/ROADMAP.md`: follow-on feature slices and acceptance gates.
- `docs/DECISIONS.md`: pending technical decisions and recommended defaults.

**The root `openspec/specs/` stays empty until a completed change is archived.** A proposed feature must not be represented as already implemented.
