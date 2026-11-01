# Delivery roadmap (one OpenSpec change at a time)

The initial active change deliberately establishes **foundation only**. Following capabilities are **planned, not yet implemented or approved**. Write separate OpenSpec proposals and deltas for each after finishing the preceding slice.

| Order | Suggested change id | Target | Exit gate |
|---|---|---|---|
| 1 | modernize-gitdatnote-foundation | TypeScript app baseline, minimal secure backend, GitHub connection, repo content adapter, tests | Authorized file read/write against controlled test repo, secure session and conflict handling |
| 2 | implement-article-editor | Dashboard, Markdown-backed editor, front matter, draft/publish intent, images | Create/edit existing article, preserve metadata, no unsaved data loss |
| 3 | generate-eleventy-blog | Starter template, theme, blog wizard, user-owned repo provisioning | New repo independently builds sample site |
| 4 | publish-blog | GitHub Actions/Pages deployment, job status, retry guidance | Publish from UI to accessible URL, failures visible |
| 5 | connect-custom-domains | Guided DNS verification, HTTPS readiness, optional domain | Default URL works without domain purchase, misconfiguration explained |
| 6 | stabilize-mvp | accessibility, mobile, E2E, docs, security review | Nontechnical first-publish usability test |
| Later | gitdatnote-cloud | Tenant management, hosted subdomains, billing, alternate host | Only after proof of demand and infrastructure review |

## Iteration contract
Each change must include `proposal.md`, `design.md` (if cross-cutting), `tasks.md`, and delta specs with Given/When/Then scenarios. Never insert unimplemented future requirements into baseline `openspec/specs/`.

## Publishing strategy
For the Community MVP, start with GitHub Pages for eligible personal blog sites. Do not assume it is appropriate for GitDatNote's hosted SaaS infrastructure. Keep deployment behind an interface so a commercial hosted service can choose a different static host.
