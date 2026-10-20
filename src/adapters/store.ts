/**
 * Persistence over Neon's HTTP driver.
 *
 * The HTTP driver is used rather than a TCP pool because a Worker invocation
 * is short-lived and may run anywhere; each query is an independent request,
 * so there is no connection to keep warm or exhaust.
 */

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

import type {
  Conversation,
  ConversationEndReason,
  ConversationStatus,
  ConversationTurn,
} from "../core/conversations.js";
import type { Language } from "../core/language.js";
import type { Ticket, TicketStatus } from "../core/tickets.js";

type Row = Record<string, unknown>;

function toTicket(row: Row): Ticket {
  return {
    id: Number(row.id),
    conversationId:
      row.conversation_id === null || row.conversation_id === undefined
        ? null
        : Number(row.conversation_id),
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

function toConversation(row: Row): Conversation {
  return {
    id: Number(row.id),
    customerChatId: Number(row.customer_chat_id),
    customerUserId: Number(row.customer_user_id),
    status: String(row.status) as ConversationStatus,
    endedReason: (row.ended_reason as ConversationEndReason | null) ?? null,
    questionCount: Number(row.question_count ?? 0),
    startedAt: new Date(String(row.started_at)),
    lastActivityAt: new Date(String(row.last_activity_at)),
    endedAt: row.ended_at ? new Date(String(row.ended_at)) : null,
    followupSentAt: row.followup_sent_at ? new Date(String(row.followup_sent_at)) : null,
    followupMessageId:
      row.followup_message_id === null || row.followup_message_id === undefined
        ? null
        : Number(row.followup_message_id),
    surveySentAt: row.survey_sent_at ? new Date(String(row.survey_sent_at)) : null,
    surveyMessageId:
      row.survey_message_id === null || row.survey_message_id === undefined
        ? null
        : Number(row.survey_message_id),
  };
}

export interface NewTicket {
  conversationId: number;
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

  /**
   * Which expected tables and columns the database actually has.
   *
   * Exists because a missing migration is invisible until the feature that
   * needs it runs. A broken migration runner applied almost nothing here for
   * weeks and nothing reported it: the bot kept answering questions, because
   * the tables it needed for *that* happened to exist. /health now says so
   * directly, so "is the schema up to date?" is one request rather than a
   * guess.
   *
   * Checked by name against the catalog rather than by querying each table,
   * so it costs one round trip and cannot itself fail on the thing it is
   * reporting.
   */
  async schemaStatus(): Promise<{ missing: string[]; ok: boolean }> {
    const expected: Array<[string, string | null]> = [
      ["tickets", null],
      ["ticket_events", null],
      ["processed_updates", null],
      ["tickets", "nudge_count"],
      ["conversations", null],
      ["tickets", "conversation_id"],
      ["conversations", "followup_sent_at"],
      ["conversations", "survey_sent_at"],
      ["conversation_surveys", null],
      ["conversations_history", null],
      ["tickets_history", null],
      ["ticket_events_history", null],
    ];

    const rows = await this.sql`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
    `;

    const tables = new Set<string>();
    const columns = new Set<string>();
    for (const row of rows) {
      const r = row as Row;
      tables.add(String(r.table_name));
      columns.add(`${String(r.table_name)}.${String(r.column_name)}`);
    }

    const missing = expected
      .filter(([table, column]) =>
        column === null ? !tables.has(table) : !columns.has(`${table}.${column}`),
      )
      .map(([table, column]) => (column === null ? table : `${table}.${column}`));

    return { missing, ok: missing.length === 0 };
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
        conversation_id, customer_chat_id, customer_user_id, customer_name,
        customer_username, question, question_language, knowledge_version, status
      ) VALUES (
        ${input.conversationId}, ${input.customerChatId}, ${input.customerUserId},
        ${input.customerName}, ${input.customerUsername}, ${input.question},
        ${input.questionLanguage}, ${input.knowledgeVersion}, 'drafting'
      )
      RETURNING *
    `;
    return toTicket(rows[0] as Row);
  }

  // ---------------------------------------------------------------------
  // Conversations
  // ---------------------------------------------------------------------

  /**
   * The open conversation for this chat, starting one if there is none.
   *
   * One statement, not a SELECT followed by an INSERT. Two questions arriving
   * in the same second would both find no conversation and both create one,
   * and the thread would be split in half with no error to show for it. The
   * partial unique index makes the second one conflict, and the conflict path
   * is also the "another question in the same conversation" path -- so the
   * common case and the race resolve through the same branch.
   *
   * `question_count` is incremented here rather than when the ticket is
   * written, because this is the statement that is atomic.
   */
  async openConversation(input: {
    customerChatId: number;
    customerUserId: number;
  }): Promise<Conversation> {
    const rows = await this.sql`
      INSERT INTO conversations (customer_chat_id, customer_user_id, question_count)
      VALUES (${input.customerChatId}, ${input.customerUserId}, 1)
      ON CONFLICT (customer_chat_id) WHERE status = 'open'
      DO UPDATE SET
        last_activity_at = now(),
        question_count = conversations.question_count + 1
      RETURNING *
    `;
    return toConversation(rows[0] as Row);
  }

  /** The open conversation for a chat, or null. Does not create or touch one. */
  async getOpenConversation(customerChatId: number): Promise<Conversation | null> {
    const rows = await this.sql`
      SELECT * FROM conversations
      WHERE customer_chat_id = ${customerChatId} AND status = 'open'
    `;
    return rows.length > 0 ? toConversation(rows[0] as Row) : null;
  }

  /**
   * End the open conversation for a chat, if there is one.
   *
   * Returns the conversation that was closed, or null when there was nothing
   * open -- so a caller can tell "ended an interaction" from "there was none",
   * which is the difference between a returning customer and a new one.
   */
  async closeConversation(
    customerChatId: number,
    reason: ConversationEndReason,
  ): Promise<Conversation | null> {
    const rows = await this.sql`
      UPDATE conversations
      SET status = 'closed', ended_at = now(), ended_reason = ${reason}
      WHERE customer_chat_id = ${customerChatId} AND status = 'open'
      RETURNING *
    `;
    return rows.length > 0 ? toConversation(rows[0] as Row) : null;
  }

  /**
   * Close every conversation whose ending sequence has run out.
   *
   * This is `isConversationOver` in SQL, and the two must agree: the handler
   * uses the TypeScript version to decide whether an arriving question joins
   * the old thread or starts a new one, and this decides when the thread is
   * recorded as finished. If they disagreed, a question could be threaded onto
   * a conversation this sweep had already closed. A test asserts the two give
   * the same answer across the boundaries.
   *
   * Two branches:
   *   follow-up sent     -> `idleMinutes` from when it was sent. The customer
   *                         was asked directly and did not answer.
   *   follow-up not sent -> `followupMinutes + idleMinutes` from the last
   *                         activity. The backstop: a conversation whose last
   *                         question is still unanswered in the queue never
   *                         becomes eligible for a follow-up, and without the
   *                         sum would stay open for ever and never be surveyed.
   *
   * Without any of this, a conversation the customer simply abandoned stays
   * open and `ended_at` is never written -- so "the end of the interaction" is
   * missing from exactly the interactions that ended quietest.
   */
  async closeExpiredConversations(
    policy: { followupMinutes: number; idleMinutes: number },
    limit: number,
  ): Promise<Conversation[]> {
    const rows = await this.sql`
      UPDATE conversations
      SET status = 'closed', ended_at = now(), ended_reason = 'idle'
      WHERE id IN (
        SELECT id FROM conversations
        WHERE status = 'open'
          AND (
            CASE WHEN followup_sent_at IS NOT NULL
              THEN followup_sent_at < now() - make_interval(mins => ${policy.idleMinutes})
              ELSE last_activity_at
                   < now() - make_interval(mins => ${policy.followupMinutes + policy.idleMinutes})
            END
          )
        ORDER BY last_activity_at
        LIMIT ${limit}
      )
      RETURNING *
    `;
    return rows.map((row) => toConversation(row as Row));
  }

  /**
   * Conversations due the "is there anything else?" question.
   *
   * The NOT EXISTS is the important half: a conversation with a question still
   * in the queue is excluded, because asking whether anything else is needed
   * while the customer is waiting for an answer reads as though the bot has
   * forgotten them. At a three-minute threshold an unanswered ticket is the
   * normal case, not an edge one.
   */
  async findConversationsDueFollowup(
    followupMinutes: number,
    limit: number,
  ): Promise<Conversation[]> {
    const rows = await this.sql`
      SELECT c.* FROM conversations c
      WHERE c.status = 'open'
        AND c.followup_sent_at IS NULL
        AND c.question_count > 0
        AND c.last_activity_at < now() - make_interval(mins => ${followupMinutes})
        AND NOT EXISTS (
          SELECT 1 FROM tickets t
          WHERE t.conversation_id = c.id
            AND t.status NOT IN ('sent','rejected')
        )
      ORDER BY c.last_activity_at
      LIMIT ${limit}
    `;
    return rows.map((row) => toConversation(row as Row));
  }

  /**
   * Claim the follow-up for a conversation before sending it.
   *
   * Returns false when another sweep got there first, so a conversation can
   * never be asked twice. Claim-then-send, not send-then-record: a duplicate
   * question to a customer is visible and annoying, whereas a claim that is
   * followed by a failed send just means the conversation times out instead,
   * which is the behaviour it had before this feature existed.
   */
  async claimFollowup(conversationId: number): Promise<boolean> {
    const rows = await this.sql`
      UPDATE conversations
      SET followup_sent_at = now()
      WHERE id = ${conversationId}
        AND status = 'open'
        AND followup_sent_at IS NULL
      RETURNING id
    `;
    return rows.length > 0;
  }

  async setFollowupMessageId(conversationId: number, messageId: number): Promise<void> {
    await this.sql`
      UPDATE conversations SET followup_message_id = ${messageId} WHERE id = ${conversationId}
    `;
  }

  /** The conversation behind a customer's button tap, whatever its status. */
  async getConversation(id: number): Promise<Conversation | null> {
    const rows = await this.sql`SELECT * FROM conversations WHERE id = ${id}`;
    return rows.length > 0 ? toConversation(rows[0] as Row) : null;
  }

  /**
   * Clear the follow-up so the customer is asked again after the next answer.
   *
   * Called when a new question arrives and when the customer taps Yes. Also
   * bumps last_activity_at: the customer has just interacted, so the idle
   * clock restarts from here.
   */
  async reopenForMoreQuestions(conversationId: number): Promise<Conversation | null> {
    const rows = await this.sql`
      UPDATE conversations
      SET followup_sent_at = NULL,
          followup_message_id = NULL,
          last_activity_at = now()
      WHERE id = ${conversationId} AND status = 'open'
      RETURNING *
    `;
    return rows.length > 0 ? toConversation(rows[0] as Row) : null;
  }

  /** End one conversation by id, rather than by chat. */
  async closeConversationById(
    conversationId: number,
    reason: ConversationEndReason,
  ): Promise<Conversation | null> {
    const rows = await this.sql`
      UPDATE conversations
      SET status = 'closed', ended_at = now(), ended_reason = ${reason}
      WHERE id = ${conversationId} AND status = 'open'
      RETURNING *
    `;
    return rows.length > 0 ? toConversation(rows[0] as Row) : null;
  }

  // ---------------------------------------------------------------------
  // Satisfaction survey
  // ---------------------------------------------------------------------

  /** Closed conversations that have ended but not yet been surveyed. */
  async findConversationsDueSurvey(limit: number): Promise<Conversation[]> {
    const rows = await this.sql`
      SELECT * FROM conversations
      WHERE status = 'closed'
        AND survey_sent_at IS NULL
        AND question_count > 0
      ORDER BY ended_at
      LIMIT ${limit}
    `;
    return rows.map((row) => toConversation(row as Row));
  }

  /** Claim the survey before sending it, so it cannot be sent twice. */
  async claimSurvey(conversationId: number): Promise<boolean> {
    const rows = await this.sql`
      UPDATE conversations
      SET survey_sent_at = now()
      WHERE id = ${conversationId} AND survey_sent_at IS NULL
      RETURNING id
    `;
    return rows.length > 0;
  }

  async setSurveyMessageId(conversationId: number, messageId: number): Promise<void> {
    await this.sql`
      UPDATE conversations SET survey_message_id = ${messageId} WHERE id = ${conversationId}
    `;
  }

  /**
   * Store a satisfaction score.
   *
   * The conversation's own facts are copied in rather than referenced, so the
   * result stays interpretable after the weekly archive has removed the
   * conversation row -- "4 out of 5, after 3 questions, on an interaction the
   * customer ended themselves" reads the same in a year.
   *
   * Returns false when a score already exists: a customer tapping twice is
   * expressing one opinion, and a second row would quietly double-count them.
   */
  async recordSurveyResponse(input: {
    conversationId: number;
    customerChatId: number;
    customerUserId: number;
    score: number;
  }): Promise<boolean> {
    const rows = await this.sql`
      INSERT INTO conversation_surveys (
        conversation_id, customer_chat_id, customer_user_id, score,
        question_count, ended_reason, conversation_started_at
      )
      SELECT ${input.conversationId}, ${input.customerChatId}, ${input.customerUserId},
             ${input.score}, c.question_count, c.ended_reason, c.started_at
      FROM conversations c WHERE c.id = ${input.conversationId}
      ON CONFLICT (conversation_id) WHERE conversation_id IS NOT NULL
      DO NOTHING
      RETURNING id
    `;
    return rows.length > 0;
  }

  /**
   * The earlier turns of a conversation, oldest first.
   *
   * `final_answer` only: the answer the customer actually received. A draft
   * nobody approved was never part of the conversation, and a rejected one may
   * have been rejected precisely because it was wrong -- feeding it back would
   * have the model build on an answer ARDB declined to give.
   *
   * Excludes the ticket being drafted, which is already in the prompt as the
   * question.
   */
  async getConversationHistory(
    conversationId: number,
    excludeTicketId: number,
    limit: number,
  ): Promise<ConversationTurn[]> {
    const rows = await this.sql`
      SELECT id, question, question_language, final_answer, created_at
      FROM tickets
      WHERE conversation_id = ${conversationId}
        AND id <> ${excludeTicketId}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `;
    // Fetched newest-first so the LIMIT keeps the most recent turns, then
    // reversed because the prompt reads oldest-first.
    return rows
      .map((row) => {
        const r = row as Row;
        return {
          ticketId: Number(r.id),
          question: String(r.question),
          questionLanguage: String(r.question_language) as Language,
          answer: (r.final_answer as string | null) ?? null,
          askedAt: new Date(String(r.created_at)),
        };
      })
      .reverse();
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
    if (rows.length === 0) return null;

    const ticket = toTicket(rows[0] as Row);

    // The interaction is alive until the customer stops writing, not until
    // ARDB answers. Without this the idle window would run from the question,
    // so a slow answer could land on a conversation already closed as idle --
    // and the customer's follow-up would then start a thread of its own,
    // losing the exchange it was following up on.
    //
    // A separate statement because the HTTP driver has no transaction: a
    // failure here leaves the answer sent and the timestamp stale, which the
    // idle sweep corrects on its own. The reverse order would risk the
    // opposite, and an unsent answer is the worse of the two.
    if (ticket.conversationId !== null) {
      await this.sql`
        UPDATE conversations
        SET last_activity_at = now()
        WHERE id = ${ticket.conversationId} AND status = 'open'
      `;
    }

    return ticket;
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

  // ---------------------------------------------------------------------
  // Weekly archive
  // ---------------------------------------------------------------------

  /**
   * Move closed conversations older than `olderThanDays` into the history
   * tables.
   *
   * Copy first, then delete only what is provably copied. The HTTP driver has
   * no transaction spanning statements, so the two halves can be interrupted
   * between -- and the asymmetry of the failure modes decides the order:
   *
   *   copy fails            → nothing deleted, next run retries. No loss.
   *   copy ok, delete fails → rows in both places. The next run's copy is a
   *                           no-op (ON CONFLICT DO NOTHING) and the delete
   *                           retries. No loss.
   *
   * Deleting first, or deleting without the `IN (history)` guard, would make
   * a mid-run interruption destroy customer records with nothing to restore
   * from. For a bank that is the one outcome worth contorting the code to
   * make impossible.
   *
   * Events before tickets and tickets before conversations, because that is
   * the order the foreign keys allow: ticket_events cascades from tickets, so
   * events must be copied while their tickets still exist.
   *
   * Batched, so one weekly run on a long backlog cannot exceed the CPU limit.
   */
  async archiveClosedConversations(
    olderThanDays: number,
    limit: number,
  ): Promise<{ conversations: number; tickets: number; events: number }> {
    // The batch is chosen once and reused by every statement below. Letting
    // each statement re-evaluate "closed and old enough" would let a
    // conversation closed between two of them be half-archived.
    const chosen = await this.sql`
      SELECT id FROM conversations
      WHERE status = 'closed'
        AND ended_at IS NOT NULL
        AND ended_at < now() - make_interval(days => ${olderThanDays})
      ORDER BY ended_at
      LIMIT ${limit}
    `;
    const ids = chosen.map((row) => Number((row as Row).id));
    if (ids.length === 0) return { conversations: 0, tickets: 0, events: 0 };

    // Every `ANY(...)` below casts to bigint[] explicitly. Postgres can
    // sometimes infer an array parameter's type and sometimes cannot,
    // depending on how the driver declares it, and the failure would be a
    // runtime error in a weekly job -- the kind nobody sees until the live
    // tables have grown for a month. The cast costs nothing and removes the
    // question.

    // --- copy ---

    const events = await this.sql`
      INSERT INTO ticket_events_history
      SELECT e.*, now() FROM ticket_events e
      JOIN tickets t ON t.id = e.ticket_id
      WHERE t.conversation_id = ANY(${ids}::bigint[])
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `;

    const tickets = await this.sql`
      INSERT INTO tickets_history
      SELECT t.*, now() FROM tickets t
      WHERE t.conversation_id = ANY(${ids}::bigint[])
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `;

    const conversations = await this.sql`
      INSERT INTO conversations_history
      SELECT c.*, now() FROM conversations c
      WHERE c.id = ANY(${ids}::bigint[])
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `;

    // --- delete, guarded ---
    //
    // Every DELETE requires the row to exist in history. This is what makes
    // the operation safe to interrupt at any point: a row that was not copied
    // cannot be removed, whatever went wrong above.

    await this.sql`
      DELETE FROM tickets t
      WHERE t.conversation_id = ANY(${ids}::bigint[])
        AND EXISTS (SELECT 1 FROM tickets_history h WHERE h.id = t.id)
    `;

    await this.sql`
      DELETE FROM conversations c
      WHERE c.id = ANY(${ids}::bigint[])
        AND EXISTS (SELECT 1 FROM conversations_history h WHERE h.id = c.id)
        AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.conversation_id = c.id)
    `;

    return {
      conversations: conversations.length,
      tickets: tickets.length,
      events: events.length,
    };
  }

  /**
   * Delete archived interactions past the retention period.
   *
   * The archive keeps correspondence readable; this is what stops it being
   * kept for ever. Driven off `conversations_history.ended_at` -- the date of
   * the interaction itself, not `archived_at` -- because the retention clock a
   * compliance policy means is the one that starts when the conversation
   * happened, not when a cron job happened to move it a week later.
   *
   * Children first, and selected by their parent rather than by their own age,
   * so an interaction is never half-deleted: a ticket created days before the
   * conversation ended must not outlive it, and nor must it be removed while
   * its conversation remains.
   *
   * The history tables carry no foreign keys, so nothing enforces that for
   * us -- which is exactly why the order is explicit here.
   */
  async purgeHistory(
    retentionYears: number,
    limit: number,
  ): Promise<{ conversations: number; tickets: number; events: number; surveys: number }> {
    const chosen = await this.sql`
      SELECT id FROM conversations_history
      WHERE ended_at IS NOT NULL
        AND ended_at < now() - make_interval(years => ${retentionYears})
      ORDER BY ended_at
      LIMIT ${limit}
    `;
    const ids = chosen.map((row) => Number((row as Row).id));

    let events = 0;
    let tickets = 0;
    let conversations = 0;

    if (ids.length > 0) {
      const purgedEvents = await this.sql`
        DELETE FROM ticket_events_history
        WHERE ticket_id IN (
          SELECT id FROM tickets_history WHERE conversation_id = ANY(${ids}::bigint[])
        )
        RETURNING id
      `;
      const purgedTickets = await this.sql`
        DELETE FROM tickets_history
        WHERE conversation_id = ANY(${ids}::bigint[])
        RETURNING id
      `;
      const purgedConversations = await this.sql`
        DELETE FROM conversations_history WHERE id = ANY(${ids}::bigint[])
        RETURNING id
      `;
      events = purgedEvents.length;
      tickets = purgedTickets.length;
      conversations = purgedConversations.length;
    }

    // Surveys are on the same clock. They are aggregate feedback rather than
    // correspondence, but they carry the customer's chat and user id, so
    // keeping them indefinitely would keep identifying data indefinitely --
    // and a satisfaction score from eleven years ago informs nothing.
    //
    // Deleted by their own date because a survey deliberately outlives the
    // conversation it rates: by the time it is this old its conversation_id
    // has long been NULL, so there is no parent to drive from.
    const purgedSurveys = await this.sql`
      DELETE FROM conversation_surveys
      WHERE responded_at < now() - make_interval(years => ${retentionYears})
      RETURNING id
    `;

    return { conversations, tickets, events, surveys: purgedSurveys.length };
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
