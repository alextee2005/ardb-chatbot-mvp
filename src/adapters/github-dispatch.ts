/**
 * Hand a ticket to GitHub Actions for drafting.
 *
 * The Worker posts the moderator card and then fires a `repository_dispatch`;
 * a workflow wakes, drafts with Claude, writes the draft to the ticket and
 * refreshes the same card. The customer has already been told to wait and the
 * moderator has already seen the question, so the minute or two GitHub takes
 * to start a runner costs nothing a person would notice.
 *
 * **The payload carries a ticket ID and nothing else.** The question text
 * stays in Postgres and the Actions job reads it from there. A
 * `repository_dispatch` payload is visible in the workflow run's event, and
 * Actions logs are readable by anyone with repository access and retained for
 * weeks -- so sending a bank customer's enquiry through it would put customer
 * data somewhere this project deliberately keeps clear of (see
 * knowledge/README.md: "No customer data, ever. This file is in git."). An
 * integer is not customer data.
 */

export type DispatchResult = { ok: true } | { ok: false; error: string };

export interface GitHubDispatchConfig {
  /** A fine-grained token with Contents: write on this repository only. */
  token: string;
  /** "owner/repo". */
  repository: string;
  /** Matched by the workflow's `types:` filter. */
  eventType: string;
}

export async function dispatchDraft(
  config: GitHubDispatchConfig,
  ticketId: number,
): Promise<DispatchResult> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${config.repository}/dispatches`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
          // GitHub rejects requests with no User-Agent.
          "user-agent": "ardb-chatbot",
        },
        body: JSON.stringify({
          event_type: config.eventType,
          client_payload: { ticket_id: ticketId },
        }),
      },
    );

    // 204 No Content is success here. Anything else needs saying out loud,
    // because the visible symptom is a card that simply never fills in.
    if (response.status === 204) return { ok: true };

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        error:
          "GitHub rejected the dispatch token. It needs Contents: write on " +
          `${config.repository}. Check the GITHUB_DISPATCH_TOKEN secret.`,
      };
    }
    if (response.status === 404) {
      return {
        ok: false,
        error:
          `GitHub returned 404 for ${config.repository}. Either the ` +
          "repository name is wrong or the token cannot see it -- a " +
          "fine-grained token returns 404, not 403, for a repository outside " +
          "its scope.",
      };
    }

    return {
      ok: false,
      error: `GitHub returned HTTP ${response.status} to the dispatch.`,
    };
  } catch (error) {
    return {
      ok: false,
      error: `Could not reach GitHub to dispatch the draft: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
