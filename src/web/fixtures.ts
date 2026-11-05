import type { Repository } from "../shared/types";

/**
 * PREVIEW-ONLY sample data. Used solely to exercise the connected-state
 * layout in development and in tests. It is NEVER presented as a live GitHub
 * connection — the UI shows an explicit "PREVIEW — sample data" banner
 * whenever this fixture is in use.
 */
export const FIXTURE_REPOSITORIES: Repository[] = [
  {
    owner: "sample-org",
    name: "sample-journal",
    contentRoot: "Journal",
    canRead: true,
    canWrite: false,
    private: false,
  },
  {
    owner: "sample-org",
    name: "sample-blog",
    contentRoot: "Articles",
    canRead: true,
    canWrite: true,
    private: false,
  },
  {
    owner: "sample-user",
    name: "private-notes",
    contentRoot: "",
    canRead: true,
    canWrite: true,
    private: true,
  },
];

/** Sample Markdown rendered through the safe pipeline in preview mode. */
export const FIXTURE_SAMPLE_MARKDOWN: string = [
  "# Sample preview",
  "",
  "This text renders through the safe Markdown pipeline (`marked` + `DOMPurify`).",
  "",
  "- list item one",
  "- list item two",
  "",
  "> A blockquote.",
].join("\n");
