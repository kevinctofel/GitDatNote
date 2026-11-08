/**
 * Minimal local type declaration for `better-sqlite3` (task 3.1).
 *
 * Only the surface used by the session storage module is declared, so no
 * extra type package has to be added to the dependency tree. The upstream
 * API is CJS `module.exports = Database`; this declaration types the
 * default-import form used by `storage.ts` and the unit tests.
 */
declare module 'better-sqlite3' {
  namespace Database {
    interface RunResult {
      changes: number;
      lastInsertRowid: number | bigint;
    }
    interface Statement {
      run(...params: unknown[]): RunResult;
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    }
  }
  class Database {
    constructor(filename: string, options?: Record<string, unknown>);
    exec(sql: string): this;
    prepare(sql: string): Database.Statement;
    /** Wrap a function in a transaction (all-or-nothing execution). */
    transaction<T>(fn: T): T;
    close(): this;
  }
  export default Database;
}
