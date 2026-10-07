/**
 * Every string the customer ever sees, in Khmer and English.
 *
 * Khmer leads throughout: ARDB's customer base is predominantly Khmer-speaking
 * farmers, cooperatives and rural MSMEs. Keeping all customer-facing copy in
 * one file means it can be reviewed and corrected by a Khmer speaker without
 * reading any code.
 */

const DIVIDER = "\n\n— — —\n\n";

/** Join the Khmer and English variants into the single message we send. */
export function bilingual(km: string, en: string): string {
  return `${km}${DIVIDER}${en}`;
}

export const CUSTOMER_MESSAGES = {
  /** Reply to /start. */
  greeting: bilingual(
    "សួស្តី! ខ្ញុំឈ្មោះ ARDB Bot។ តើខ្ញុំអាចជួយអ្វីអ្នកបាននៅថ្ងៃនេះ?",
    "Hi, my name is ARDB Bot. How can I help you today?",
  ),

  /** Immediate acknowledgement when a question arrives. */
  acknowledgement: bilingual(
    "សូមរង់ចាំបន្តិច ខ្ញុំនឹងឆ្លើយតបទៅអ្នកវិញ។",
    "Please give me some time to respond to you.",
  ),

  /** A second question arrived while one was still in the queue. */
  alreadyPending: bilingual(
    "សូមរង់ចាំបន្តិច ខ្ញុំនៅកំពុងរៀបចំចម្លើយសម្រាប់សំណួរមុនរបស់អ្នក។ ខ្ញុំនឹងឆ្លើយតបសំណួរទាំងអស់។",
    "Please hold on — I am still preparing an answer to your earlier question. I will respond to all of them.",
  ),

  /** Anything that is not a text message. */
  unsupportedMessage: bilingual(
    "សុំទោស ខ្ញុំអាចអានបានតែសារជាអក្សរប៉ុណ្ណោះ។ សូមសរសេរសំណួររបស់អ្នកជាអក្សរ។",
    "Sorry, I can only read text messages. Please type your question as text.",
  ),

  /** Too many questions too quickly. */
  rateLimited: bilingual(
    "អ្នកបានផ្ញើសំណួរច្រើនពេកក្នុងរយៈពេលខ្លី។ សូមរង់ចាំមួយភ្លែត រួចសាកល្បងម្តងទៀត។",
    "You have sent several questions in a short time. Please wait a moment and try again.",
  ),

  /** The moderator declined to answer through the bot. */
  rejected: bilingual(
    "សុំទោស សំណួរនេះត្រូវការជំនួយពីបុគ្គលិករបស់យើងដោយផ្ទាល់។ សូមទាក់ទងសាខា ARDB ជិតបំផុត ឬទូរស័ព្ទមកយើង។",
    "Sorry, this question needs direct help from our staff. Please contact your nearest ARDB branch or call us.",
  ),

  /** Something broke on our side. */
  internalError: bilingual(
    "សុំទោស មានបញ្ហាបច្ចេកទេសបណ្ដោះអាសន្ន។ សូមសាកល្បងផ្ញើសំណួររបស់អ្នកម្តងទៀត។",
    "Sorry, there was a temporary technical problem. Please try sending your question again.",
  ),
} as const;

export const MODERATOR_MESSAGES = {
  claimedByOther: "Already being handled by another moderator.",
  notFound: "That ticket no longer exists.",
  alreadyResolved: "That ticket has already been answered.",
  editPrompt: (reference: string) =>
    `Reply to this message with the final answer for ${reference}.`,
  sent: (reference: string) => `${reference} sent to the customer.`,
  rejected: (reference: string) =>
    `${reference} rejected. The customer was asked to contact a branch.`,
  draftFailed:
    "Claude could not produce a draft for this question. Use ✏️ Edit to write the answer manually.",
} as const;
