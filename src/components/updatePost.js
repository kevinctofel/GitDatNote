import { Octokit } from "octokit";
import "dotenv/config";

const octokit = new Octokit({
  auth: process.env.GITHUB_AUTH_KEY,
});

let data = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
  owner: "kevinctofel",
  repo: "MyConsciousStream",
  path: "content/blog/testpost.md",
});

console.log(data); // atob() decodes base64

let updatedPost =
  atob(data.data.content) + `\n\nThis is new text added from the GitHub API`;

console.log(updatedPost);

await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
  owner: "kevinctofel",
  repo: "MyConsciousStream",
  path: "content/blog/testpost.md",
  message: "updated blog post",
  sha: data.data.sha,
  committer: {
    name: "Kevin C. Tofel",
    email: "kevin@kctofel.com",
  },
  content: btoa(updatedPost),
  headers: {
    "X-GitHub-Api-Version": "2022-11-28",
  },
});
