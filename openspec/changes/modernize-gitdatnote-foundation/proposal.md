# Proposal: Modernize GitDatNote foundation

## Why
GitDatNote began as a limited browser UI to write Markdown to a specific SecondBrain GitHub path. To become a dependable, general-purpose Eleventy publishing product it first needs a maintainable application base and secure, repository-agnostic GitHub integration.

## What Changes
- Audit existing source and document what can be retained.
- Establish TypeScript-based React/Vite app conventions and a minimal Node backend.
- Implement secure GitHub account connection and session management without exposing privileged tokens in browser bundles.
- Introduce a testable GitHub repository content service with read/create/update, repository/path validation, SHA conflicts, and error mapping.
- Provide a modest connected-account and repository selection shell, not the finished article editor.
- Add repeatable local setup, lint/typecheck/test scripts and CI checks.

## Capabilities
### New Capabilities
- `application-foundation`: repeatable, testable CMS baseline.
- `github-connection`: secure user-authorized GitHub connectivity.
- `repository-content`: safe GitHub Markdown file operations.

### Modified Capabilities
- None claimed yet. Audit the brownfield code before formally describing behavior as a modification.

## Impact
Source/build/tooling changes and a small local/self-hostable backend. The existing SecondBrain flow may need an adapter; no real content should be modified by migration tests.

## Out of scope
Full article editor, Eleventy template generation, repository provisioning, Pages deployment, domains, hosted SaaS, billing, AI writing, and team collaboration.

## Rollback
Use a dedicated feature branch, preserve original Git history, and keep migrations small. If the modernization cannot run reliably, revert the branch without touching external content.
