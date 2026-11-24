# Proposal: Modernize GitDatNote foundation

## Why
GitDatNote began as a limited browser UI to write Markdown to a specific SecondBrain GitHub path, with a privileged token in the browser bundle. To become a dependable, general-purpose Eleventy publishing product it first needs a maintainable application base and secure, repository-agnostic GitHub integration.

## What Changes
- Audit existing source; document reusable concepts, obsolete code, and security issues (`audit.md`).
- Delete obsolete Node-specific scripts (`updatePost.js`, `addImage.js`) and the browser-side Octokit code.
- Establish a single-package TypeScript architecture: `src/web` (React/Vite), `src/server` (Node backend), `src/shared` (platform-agnostic types and validation).
- Implement GitHub App-based authorization with a server-side web flow, SQLite session storage, encrypted credential storage, and CSRF protection.
- Introduce a typed repository content service with explicit API contracts, per-repository content roots, path validation, SHA-based conflict detection, UTF-8 encoding, size limits, and typed error mapping.
- Provide a connected-account and repository-selection shell, not the finished article editor.
- Add repeatable local setup, lint/typecheck/build/test scripts (Vitest, Playwright), and a CI workflow.
- Replace obsolete and inconsistent dependencies; standardize on React, TypeScript, Vite, and Node.js 24 LTS.

## Capabilities
### New Capabilities
- `application-foundation`: repeatable, testable CMS baseline with a single-package TypeScript structure.
- `github-connection`: secure user-authorized GitHub connectivity via a GitHub App, with session and CSRF management.
- `repository-content`: safe GitHub Markdown file operations with explicit contracts, path validation, and SHA conflict detection.

### Modified Capabilities
- None claimed yet. The brownfield code is audited in `audit.md`; no existing behavior is formally described as a modification until equivalent generic operations are covered by tests.

## Impact
Source, build, and tooling changes plus a small local/self-hostable Node backend (Node.js 24 LTS). The existing SecondBrain flow is superseded by the generic content service (content root `Journal`); no real content is modified by any migration or automated test.

## Out of scope
- Full article editor, Eleventy template generation, repository provisioning.
- GitHub Pages deployment, domain configuration, hosted SaaS, billing.
- File deletion (deferred to the article editor change).
- Binary content (images) — size limit defined for future use.
- Batch operations — each API operation produces one commit.
- Webhooks for repository synchronization.
- AI writing, team collaboration, multi-tenant hosting.

## Rollback
Work proceeds on a dedicated feature branch (`feat/gitdatnote-2`) preserving original Git history. If the modernization cannot run reliably, the branch is reverted without touching external content.
