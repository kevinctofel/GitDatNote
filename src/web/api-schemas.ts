import { z } from "zod";

/**
 * Runtime validation schemas for successful (2xx) JSON responses from the
 * backend.
 *
 * The backend endpoints (`GET /api/session`, `GET /api/repositories`,
 * `POST /api/auth/logout`, …) are implemented, but these schemas still guard
 * the frontend against malformed responses and turn them into safe,
 * understandable errors instead of rendering crashes. They mirror the shared
 * domain shapes in `src/shared/types.ts` (the web `SessionState`, the shared
 * `Repository`, and the shared `ContentResult`).
 */

const sessionUserSchema = z.object({
  login: z.string(),
  name: z.string().optional(),
  avatarUrl: z.string().optional(),
});

/** `GET /api/session` body. */
// A connected session MUST carry a valid user identity; a disconnected
// session MUST NOT. Inconsistent combinations are rejected at the boundary.
export const sessionStateSchema = z.discriminatedUnion("connected", [
  z.object({
    connected: z.literal(true),
    user: sessionUserSchema,
    csrfToken: z.string().optional(),
  }),
  z.object({
    connected: z.literal(false),
    user: z.null().optional(),
  }),
]);

/** A single repository entry as the frontend consumes it (shared `Repository`). */
export const repositorySchema = z.object({
  owner: z.string(),
  name: z.string(),
  contentRoot: z.string(),
  canRead: z.boolean(),
  canWrite: z.boolean(),
  private: z.boolean(),
});

/** `GET /api/repositories` body. */
export const repositoryListSchema = z.array(repositorySchema);

const fileContentSchema = z.object({
  type: z.literal("file"),
  path: z.string(),
  content: z.string(),
  sha: z.string(),
  size: z.number(),
});

const directoryChildSchema = z.object({
  name: z.string(),
  type: z.enum(["file", "dir"]),
  sha: z.string(),
  size: z.number(),
});

const directoryListingSchema = z.object({
  type: z.literal("directory"),
  path: z.string(),
  children: z.array(directoryChildSchema),
});

/** `GET /api/repos/:owner/:repo/content` body (shared `ContentResult`). */
export const contentResultSchema = z.discriminatedUnion("type", [
  fileContentSchema,
  directoryListingSchema,
]);
