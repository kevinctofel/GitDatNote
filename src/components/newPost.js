import { Octokit } from "octokit";
import App from "../App.jsx";
import buildFrontMatter from "./buildFrontMatter.js";
async function newPost(postTitle, postContent) {
  const octokit = new Octokit({
    auth: import.meta.env.VITE_GITHUB_TOKEN,
  });

  postContent = buildFrontMatter(postTitle) + postContent;

  await octokit.request(
    "PUT /repos/{owner}/{repo}/contents/content/blog/{path}",
    {
      owner: "kevinctofel",
      repo: "MyConsciousStream",
      path: `${postTitle}.md`,
      message: "new blog post",
      committer: {
        name: "Kevin C. Tofel",
        email: "kevin@kctofel.com",
      },
      content: btoa(postContent),
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );
}
export default newPost;
