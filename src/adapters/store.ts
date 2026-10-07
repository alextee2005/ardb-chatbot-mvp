/**
 * Persistence over Neon's HTTP driver.
 *
 * The HTTP driver is used rather than a TCP pool because a Worker invocation
 * is short-lived and may run anywhere; each query is an independent request,
 * so there is no connection to keep warm or exhaust.
 */

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

import type { Language } from "../core/language.js";
import type { Ticket, TicketStatus } from "../core/tickets.js";

type Row = Record<string, unknown>;

function toTicket(row: Row): Ticket {
  return {
    id: Number(row.id),
    customerChatId: Number(row.customer_chat_id),
    customerUserId: Number(row.customer_user_id),
    customerName: String(row.customer_name),
    customerUsername: (row.customer_username as string | null) ?? null,
    question: String(row.question),
    questionLanguage: String(row.question_language) as Language,
    draft: (row.draft as string | null) ?? null,
    draftError: (row.draft_error as string | null) ?? null,
    finalAnswer: (row.final_answer as string | null) ?? null,
    status: String(row.status) as TicketStatus,
    claimedBy: row.claimed_by === null ? null : Number(row.claimed_by),
    claimedByName: (row.claimed_by_name as string | null) ?? null,
    cardMessageId: row.card_message_id === null ? null : Number(row.card_message_id),
    promptMessageId:
      row.prompt_message_id === null ? null : Number(row.prompt_message_id),
    nudgeCount: Number(row.nudge_count ?? 0),
    lastNudgedAt: row.last_nudged_at ? new Date(String(row.last_nudged_at)) : null,
    customerWarnedAt: row.customer_warned_at
      ? new Date(String(row.customer_warned_at))
      : null,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

export interface NewTicket {
  customerChatId: number;
  customerUserId: number;
  customerName: string;
  customerUsername: string | null;
  question: string;
  questionLanguage: Language;
  knowledgeVersion: string;
}

export class Store {
  private readonly sql: NeonQueryFunction<false, false>;

  constructor(databaseUrl: string) {
    this.sql = neon(databaseUrl);
  }

  /**
   * Claim an update_id before doing any work with it.
   *
   * Returns false when the ID has been seen, which means this is a Telegram
   * retry of something already handled. The primary key does the work; the
   * ON CONFLICT makes a losing race a quiet no-op rather than an error.
   */
  async claimUpdate(updateId: number): Promise<boolean> {
    const rows = await this.sql`
      INSERT INTO processed_updates (update_id)
      VALUES (${updateId})
      ON CONFLICT (update_id) DO NOTHING
      RETURNING update_id
    `;
    return rows.length > 0;
  }

  /** Keeps the dedupe table from growing without bound. */
  async pruneProcessedUpdates(): Promise<void> {
    await this.sql`
      DELETE FROM processed_updates WHERE processed_at < now() - INTERVAL '2 days'
    `;
  }

  async createTicket(input: NewTicket): Promise<Ticket> {
    const rows = await this.sql`
      INSERT INTO tickets (
        customer_chat_id, customer_user_id, customer_name, customer_username,
        question, question_language, knowledge_version, status
      ) VALUES (
        ${input.customerChatId}, ${input.customerUserId}, ${input.customerName},
        ${input.customerUsername}, ${input.question}, ${input.questionLanguage},
        ${input.knowledgeVersion}, 'drafting'
      )
      RETURNING *
    `;
    return toTicket(rows[0] as Row);
  }

  async getTicket(id: number): Promise<Ticket | null> {
    const rows = await this.sql`SELECT * FROM tickets WHERE id = ${id}`;
    return rows.length > 0 ? toTicket(rows[0] as Row) : null;
  }

  /**
   * Find the ticket a moderator's reply belongs to.
   *
   * Matches either the force-reply prompt or the ticket card itself, so a
   * moderator can reply to whichever message is in front of them.
   */
  async getTicketByReplyTarget(messageId: number): Promise<Ticket | null> {
    const rows = await this.sql`
      SELECT * FROM tickets
      WHERE prompt_message_id = ${messageId} OR card_message_id = ${messageId}
      ORDER BY id DESC
      LIMIT 1
    `;
    return rows.length > 0 ? toTicket(rows[0] as Row) : null;
  }

  async setDraft(
    id: number,
    draft: string | null,
    draftError: string | null,
  ): Promise<Ticket | null> {
    const rows = await this.sql`
      UPDATE tickets
      SET draft = ${draft},
          draft_error = ${draftError},
          -- Only a ticket still drafting advances; a moderator who tapped
          -- Edit before the draft landed keeps their claim.
          status = CASE WHEN status = 'drafting' THEN 'awaiting' ELSE status END,
          updated_at = now()
      WHERE id = ${id}
      RETURNING *
    `;
    return rows.length > 0 ? toTicket(rows[0] as Row) : null;
  }

  async setCardMessageId(id: number, cardMessageId: number): Promise<void> {
    await this.sql`
      UPDATE tickets
      SET card_message_id = ${cardMessageId}, updated_at = now()
      WHERE id = ${id}
    `;
  }

  async setPromptMessageId(id: number, promptMessageId: number): Promise<void> {
    await this.sql`
      UPDATE tickets
      SET prompt_message_id = ${promptMessageId}, updated_at = now()
      WHERE id = ${id}
    `;
  }

  /**
   * Atomically take a ticket for one moderator.
   *
   * This is the race that matters: several moderators see the same card and
   * may tap at the same moment. The guard is in the WHERE clause, so exactly
   * one UPDATE can match and the losers get no row back. Re-claiming a ticket
   * you already hold succeeds, so tapping Edit after Edit is not an error.
   */
  async claimTicket(
    id: number,
    moderatorId: number,
    moderatorName: string,
  ): Promise<Ticket | null> {
    const rows = await this.sql`
      UPDATE tickets
      SET status = 'claimed',
          claimed_by = ${moderatorId},
          claimed_by_name = ${moderatorName},
          updated_at = now()
      WHERE id = ${id}
        AND status IN ('drafting','awaiting','claimed')
        AND (claimed_by IS NULL OR claimed_by = ${moderatorId})
      RETURNING *
    `;
    return rows.length > 0 ? toTicket(rows[0] as Row) : null;
  }

  /**
   * Resolve a ticket, guarding against a double send.
   *
   * Returns null if the ticket was already terminal -- two moderators tapping
   * ✅ at once must not deliver two messages to the customer.
   */
  async resolveTicket(
    id: number,
    status: Extract<TicketStatus, "sent" | "rejected">,
    finalAnswer: string | null,
    moderatorId: number,
    moderatorName: string,
  ): Promise<Ticket | null> {
    const rows = await this.sql`
      UPDATE tickets
      SET status = ${status},
          final_answer = ${finalAnswer},
          claimed_by = ${moderatorId},
          claimed_by_name = ${moderatorName},
          prompt_message_id = NULL,
          updated_at = now()
      WHERE id = ${id}
        AND status NOT IN ('sent','rejected')
      RETURNING *
    `;
    return rows.length > 0 ? toTicket(rows[0] as Row) : null;
  }

  /** Questions from this customer in the last minute, for the rate limit. */
  async countRecentQuestions(customerUserId: number): Promise<number> {
    const rows = await this.sql`
      SELECT count(*)::int AS count FROM tickets
      WHERE customer_user_id = ${customerUserId}
        AND created_at > now() - INTERVAL '1 minute'
    `;
    return Number((rows[0] as Row).count);
  }

  /** Whether this customer already has a question in the queue. */
  async hasOpenTicket(customerUserId: number): Promise<boolean> {
    const rows = await this.sql`
      SELECT 1 FROM tickets
      WHERE customer_user_id = ${customerUserId}
        AND status NOT IN ('sent','rejected')
      LIMIT 1
    `;
    return rows.length > 0;
  }

  /**
   * Open tickets that could be late, oldest first.
   *
   * Deliberately loose -- it returns candidates by age and leaves the policy
   * decision to `decideSlaActions`, so the rules live in one tested place
   * rather than being half in SQL and half in TypeScript. `limit` bounds the
   * work one sweep can do.
   */
  async findOpenTickets(olderThanMinutes: number, limit: number): Promise<Ticket[]> {
    const rows = await this.sql`
      SELECT * FROM tickets
      WHERE status NOT IN ('sent','rejected')
        AND created_at < now() - make_interval(mins => ${olderThanMinutes})
      ORDER BY created_at ASC
      LIMIT ${limit}
    `;
    return (rows as Row[]).map(toTicket);
  }

  /**
   * Record a nudge, refusing if one has already been recorded within the
   * repeat window. The guard is in the WHERE clause so two overlapping sweeps
   * cannot both nudge the same ticket.
   */
  async markNudged(id: number, repeatMinutes: number): Promise<boolean> {
    const rows = await this.sql`
      UPDATE tickets
      SET nudge_count = nudge_count + 1,
          last_nudged_at = now(),
          updated_at = now()
      WHERE id = ${id}
        AND status NOT IN ('sent','rejected')
        AND (
          last_nudged_at IS NULL
          OR last_nudged_at < now() - make_interval(mins => ${repeatMinutes})
        )
      RETURNING id
    `;
    return rows.length > 0;
  }

  /** Record the customer warning, refusing if one was already sent. */
  async markCustomerWarned(id: number): Promise<boolean> {
    const rows = await this.sql`
      UPDATE tickets
      SET customer_warned_at = now(), updated_at = now()
      WHERE id = ${id}
        AND status NOT IN ('sent','rejected')
        AND customer_warned_at IS NULL
      RETURNING id
    `;
    return rows.length > 0;
  }

  async recordEvent(input: {
    ticketId: number;
    event: string;
    actorId?: number | null;
    actorName?: string | null;
    detail?: string | null;
  }): Promise<void> {
    await this.sql`
      INSERT INTO ticket_events (ticket_id, event, actor_id, actor_name, detail)
      VALUES (
        ${input.ticketId}, ${input.event}, ${input.actorId ?? null},
        ${input.actorName ?? null}, ${input.detail ?? null}
      )
    `;
  }
}
