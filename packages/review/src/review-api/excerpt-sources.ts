import type { DatabaseSync } from "node:sqlite";

/** The source lines a `.whiteboard` file carries, kept for a board opened
 * read-only without a checkout: its peeks read them in place of Git. */
export class ExcerptSources {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS excerpt_sources(
      repository_id TEXT NOT NULL,
      commit_id TEXT NOT NULL,
      file TEXT NOT NULL,
      from_line INTEGER NOT NULL,
      lines TEXT NOT NULL,
      PRIMARY KEY(repository_id, commit_id, file, from_line));`);
  }

  put(
    repositoryId: string,
    excerpts: readonly {
      file: string;
      commit: string;
      fromLine: number;
      lines: readonly string[];
    }[],
  ) {
    const insert = this.db.prepare(
      "INSERT OR REPLACE INTO excerpt_sources(repository_id,commit_id,file,from_line,lines) VALUES(?,?,?,?,?)",
    );

    for (const excerpt of excerpts)
      insert.run(
        repositoryId,
        excerpt.commit,
        excerpt.file,
        excerpt.fromLine,
        JSON.stringify(excerpt.lines),
      );
  }

  /** The file as far as its excerpts tell: their lines in place, and empty
   * lines between them. Undefined when no excerpt is of this file. */
  file(repositoryId: string, commit: string, file: string) {
    const rows = this.db
      .prepare(
        "SELECT from_line, lines FROM excerpt_sources WHERE repository_id=? AND commit_id=? AND file=? ORDER BY from_line",
      )
      .all(repositoryId, commit, file);

    if (!rows.length) return undefined;

    const lines: string[] = [];

    for (const row of rows) {
      const from = Number(row.from_line);
      // SAFETY: put() writes a JSON array of strings.
      const excerpt = JSON.parse(String(row.lines)) as string[];

      while (lines.length < from - 1) lines.push("");
      excerpt.forEach((line, index) => {
        lines[from - 1 + index] = line;
      });
    }

    return lines.join("\n");
  }

  /** Whether the repository is one only excerpts stand for. */
  has(repositoryId: string) {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM excerpt_sources WHERE repository_id=? LIMIT 1")
        .get(repositoryId),
    );
  }

  removeRepository(repositoryId: string) {
    this.db
      .prepare("DELETE FROM excerpt_sources WHERE repository_id=?")
      .run(repositoryId);
  }
}
