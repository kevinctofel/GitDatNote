import { Octokit } from "octokit";

async function getPostTitles() {
  const octokit = new Octokit({
    auth: import.meta.env.VITE_GITHUB_TOKEN,
  });

  let listOfPosts = await octokit.request(
    "GET /repos/{owner}/{repo}/contents/Journal/2024/December/",
    {
      owner: "kevinctofel",
      repo: "SecondBrain",
    }
  );

  let postInfo = async (title) => {
    let data = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/Journal/2024/December/{file}",
      {
        owner: "kevinctofel",
        repo: "SecondBrain",
        file: title,
      }
    );

    console.log(atob(data.data));
  };
  let posts = [];

  listOfPosts.data.map((post) => {
    if (post.name.slice(-3) === ".md")
      posts.push({ title: post.name.slice(0, -3) , url: post.html_url, sha: post.sha});
  });
  console.log(posts);

  return posts;
}

export default getPostTitles;
