# Tasks: foundation modernization

> Execute in order; do not check off items solely because a model generated code. Each task requires review or test evidence. Future roadmap features are deliberately excluded.

## 1. Inspect and preserve existing behavior
- [ ] 1.1 Create working feature branch and record initial test/build behavior; do not modify the live SecondBrain repo.
- [ ] 1.2 Audit current GitDatNote source, `package.json`, env usage, GitHub requests, and hardcoded paths; record observations.
- [ ] 1.3 Write characterization checks for reusable current behavior; document code to retain/replace.

## 2. Establish app foundation
- [ ] 2.1 Propose and document final workspace layout and local start commands; identify current Node support.
- [ ] 2.2 Introduce TypeScript incrementally with stable frontend build, lint, and typecheck commands.
- [ ] 2.3 Add minimal Node backend with documented safe local environment setup and health endpoint.
- [ ] 2.4 Add shared request validation and typed domain error mapping, with unit tests.
- [ ] 2.5 Add CI workflow that runs lint, typecheck, and tests.

## 3. Secure GitHub connection
- [ ] 3.1 Confirm GitHub App auth, installation, and permissions design; document repo-creation limitation.
- [ ] 3.2 Add server-side auth start/callback/session/logout with state verification and secure cookie configuration.
- [ ] 3.3 Add auth/CSRF/authorization tests for denied consent, expired sessions, wrong repository, and callbacks with invalid state.
- [ ] 3.4 Add connect/disconnect UI and repository selection states with clear errors.
- [ ] 3.5 Verify browser bundles and logs do not contain GitHub credentials.

## 4. Repository content service
- [ ] 4.1 Define typed GitHub adapter and path/repository authorization boundaries.
- [ ] 4.2 Implement list and read operations with mocked tests.
- [ ] 4.3 Implement create operation; reject existing files and invalid paths, test both.
- [ ] 4.4 Implement update operation requiring expected SHA; detect and report conflicts without overwrite.
- [ ] 4.5 Implement rate-limit/network/permission failure mapping and safe retry UI states.
- [ ] 4.6 Run opt-in integration tests with throwaway GitHub repository and clean up test content.

## 5. Verify and document
- [ ] 5.1 Complete browser smoke test for sign-in state, selected repository, read, create and update flow.
- [ ] 5.2 Run project checks and record exact commands, results and limitations.
- [ ] 5.3 Update setup/security docs and record unresolved issues for next OpenSpec change.
- [ ] 5.4 Review acceptance scenarios, confirm no SecondBrain writes, and only then archive this change.
