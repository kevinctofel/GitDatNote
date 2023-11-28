function buildFrontMatter(postTitle) {
  console.log("Now I am running.");
  let pubDate = new Date();
  const dashes = "---";
  let title = `title: ${postTitle}`;
  let date = `date: ${pubDate.toISOString()}`;
  console.log("running");
  console.log(`${dashes}\n${title}\n${date}\n${dashes}`);

  return `${dashes}\n${title}\n${date}\n${dashes}\n`;
}

export default buildFrontMatter;
