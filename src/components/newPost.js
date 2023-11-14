import { Octokit } from "octokit";
import App from "../App.jsx"
async function newPost(postContent) {
const octokit = new Octokit({
    auth: import.meta.env.VITE_GITHUB_TOKEN,
});

await octokit.request("PUT /repos/{owner}/{repo}/contents/content/blog/CMSPost.md", {
  owner: "kevinctofel",
  repo: "MyConsciousStream",
  path: "CMSPost.md",
  message: "new blog post",
  committer: {
    name: "Kevin C. Tofel",
    email: "kevin@kctofel.com",
  },
  content: btoa(postContent),
  headers: {
    "X-GitHub-Api-Version": "2022-11-28",
  },
});
}
export default newPost;
