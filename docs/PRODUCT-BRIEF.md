# GitDatNote 2.0 product brief

## One-line promise
Create and publish an independent Eleventy blog through a friendly web CMS, with all content stored as Markdown in a GitHub repository owned by the user.

## Target users
Primary: individual bloggers with little Git/Eleventy experience. Secondary: technical writers who want a convenient Git-backed editor. Future: freelancers and agencies.

## Product principles
- The user's repository is the canonical source for content and build files.
- Generated sites remain buildable without GitDatNote.
- Basic editing never requires paying for AI or cloud inference.
- Every user retains ownership of their domain; domain purchase is optional.
- Avoid a database for content; store secrets/sessions securely off-client.
- Design for self-hosting now, optional hosted service later.

## MVP end-to-end outcome
A user connects GitHub, creates an Eleventy blog using a starter template, writes and previews a post, saves a draft, publishes it through an eligible GitHub Pages deployment, sees deployment status, and later edits the existing post. Images, tags, RSS, sitemap, responsive layout, and guided optional domain setup round out the initial public MVP.

## Out of scope for MVP
SaaS subscriptions, hosted gitdatnote.com subdomains, custom domain resale, comments, scheduled publishing, AI authoring, multi-tenant billing, complex team permissions, supporting non-Eleventy generators.

## Measurable MVP acceptance gates
- Site generation builds on documented Node versions without GitDatNote running.
- No repository authorization secret is shipped to client code.
- Draft never appears on generated public site.
- Existing posts update in place, using GitHub SHA/version conflict checks.
- Saving a post and deploying a site are tracked as separate states.
- A tester with an eligible GitHub account can publish without using Git CLI.
- Critical create/update/publish failure paths have automated tests.

## Historical starting point
Original GitDatNote is a small Vite/React utility described as saving Markdown notes to GitHub and configured for SecondBrain. Treat the current repository as source of truth; any earlier code review is a starting hypothesis, not proof that a file or behavior remains unchanged.
