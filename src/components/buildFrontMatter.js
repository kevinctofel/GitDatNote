function buildFrontMatter(postTitle) {
  let pubDate = new Date();
  const dashes = "---";
  let title = `title: ${postTitle}`;
  let date = `date: ${pubDate.toISOString()}`;

  return `${dashes}\n${title}\n${date}\n${dashes}\n`;
}

export default buildFrontMatter;
