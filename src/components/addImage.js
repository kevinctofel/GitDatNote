import { Octokit } from "octokit";
import "dotenv/config";
import pkg from "node-base64-img";
import * as fs from "node:fs/promises";
const { base64Img } = pkg;
const octokit = new Octokit({
  auth: process.env.GITHUB_AUTH_KEY,
});

// let image = "";

// (async () => {
//   try {
//     const response = await pkg.toBase64("./images/IMG_0076.jpeg");
//     image = response;
//     console.log(image);
//   } catch (error) {
//     console.log(error);
//     //=> 'Internal server error ...'
//   }
// })();

const imagePath = "./images/IMG_0076.jpeg";
const bytes = await fs.readFile(imagePath);
const buffer = Buffer.from(bytes, "binary");
const content = buffer.toString("base64");

await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
  owner: "kevinctofel",
  repo: "MyConsciousStream",
  path: "public/img/test1.jpg",
  message: "new image",
  committer: {
    name: "Kevin C. Tofel",
    email: "kevin@kctofel.com",
  },
  content: content,
  headers: {
    "X-GitHub-Api-Version": "2022-11-28",
  },
});
