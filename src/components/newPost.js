import { Octokit } from "octokit";
import "dotenv/config";

const octokit = new Octokit({
  auth: process.env.GITHUB_AUTH_KEY,
});

let post = "";

post += `---
title: A test post with an image.
date: 2023-11-04
---\n\n`;

post += "I'm writing this post in Markdown directly in Visual Studio Code.\n\n";

post += `![Norm, a Bichon dog](/img/test1.jpg "Norm the bichon")`;

post += "This is a sample post with an image of Norm.\n\n";

console.log(post);

await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
  owner: "kevinctofel",
  repo: "MyConsciousStream",
  path: "content/blog/testpost2.md",
  message: "new blog post",
  committer: {
    name: "Kevin C. Tofel",
    email: "kevin@kctofel.com",
  },
  content: btoa(post),
  headers: {
    "X-GitHub-Api-Version": "2022-11-28",
  },
});
