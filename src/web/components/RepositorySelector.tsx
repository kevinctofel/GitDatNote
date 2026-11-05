import type { Repository } from "../../shared/types";

interface RepositorySelectorProps {
  repositories: Repository[];
  selected: Repository | null;
  onSelect: (repository: Repository) => void;
  id?: string;
  label?: string;
}

function repoKey(repo: Repository): string {
  return `${repo.owner}/${repo.name}`;
}

/**
 * Accessible repository selector: a labeled `<select>` (keyboard-operable by
 * default) with per-option access indicators.
 */
export function RepositorySelector({
  repositories,
  selected,
  onSelect,
  id = "repository-select",
  label = "Repository",
}: RepositorySelectorProps) {
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={selected ? repoKey(selected) : ""}
        onChange={(event) => {
          const key = event.target.value;
          const match = repositories.find((repo) => repoKey(repo) === key);
          if (match) onSelect(match);
        }}
      >
        <option value="" disabled>
          {repositories.length > 0
            ? "Choose a repository"
            : "No repositories available"}
        </option>
        {repositories.map((repo) => (
          <option key={repoKey(repo)} value={repoKey(repo)}>
            {repo.owner}/{repo.name}
            {repo.canWrite
              ? " · read+write"
              : repo.canRead
                ? " · read-only"
                : " · no access"}
          </option>
        ))}
      </select>
    </div>
  );
}
