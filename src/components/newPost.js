import { Octokit } from "octokit";
import App from "../App.jsx";
import buildFrontMatter from "./buildFrontMatter.js";
import slugify from "slugify";
async function newPost(postTitle, postContent) {
  const octokit = new Octokit({
    auth: import.meta.env.VITE_GITHUB_TOKEN,
  });

  postContent = buildFrontMatter(postTitle) + postContent;
  let postURL = slugify(postTitle);

  await octokit.request(
    "PUT /repos/{owner}/{repo}/contents/content/blog/{path}",
    {
      owner: "kevinctofel",
      repo: "MyConsciousStream",
      path: `${postURL}.md`,
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
