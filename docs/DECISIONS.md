# Architecture decisions requiring validation

| ID | Proposed default | Must verify before implementing |
|---|---|---|
| D-01 | React + TypeScript + Vite frontend | Existing dependencies, upgrade path, migration cost |
| D-02 | Small Node/TypeScript backend + server-managed secure sessions | Self-hosting environment, session storage, CSRF strategy |
| D-03 | GitHub App for least-privilege repository access | GitHub App installation/auth workflow; repository creation permissions are distinct from accessing selected repositories |
| D-04 | Octokit behind an interface | GitHub API rate limits, commit/write behavior, test mocking |
| D-05 | GitHub-owned Markdown files remain authoritative | Conflict detection via SHA, path validation, metadata preservation |
| D-06 | Eleventy starter in separate versioned package/folder | Compatibility and independent `npm run build` |
| D-07 | GitHub Pages is initial eligible community destination | GitHub usage policy, Pages/Actions permissions and deployment configuration |
| D-08 | Hosted edition uses other deployment infrastructure | Vendor pricing, wildcard routing, tenancy and custom domain verification |

## Security baseline
- Never accept arbitrary repository paths without canonical validation.
- Never commit or log tokens; never put privileged credentials into Vite `VITE_*` variables.
- Use state/PKCE or applicable GitHub App flow defenses, CSRF protection, secure cookies, least privilege.
- Validate content type/size for media; sanitize rendered untrusted HTML.
- Restrict authorized repo operations to installed/permitted repositories and approved content directories.
- Handle webhook signatures and replay if webhooks are added later.

## Migration strategy
Create a working branch; inspect current tree; preserve Git history. First isolate existing app behavior behind tests; then migrate incrementally. Do not delete original SecondBrain-specific code until equivalent generic operations are covered. No write to a real SecondBrain repository in automated tests.
