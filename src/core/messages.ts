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

  /** Sent once when a ticket has gone unanswered for too long. */
  stillWaiting: bilingual(
    "សុំទោស សំណួររបស់អ្នកកំពុងចំណាយពេលយូរជាងធម្មតា។ បុគ្គលិករបស់យើងនឹងឆ្លើយតបទៅអ្នកវិញឱ្យបានឆាប់។ ប្រសិនបើប្រញាប់ សូមទាក់ទងសាខា ARDB ជិតបំផុត។",
    "Sorry, your question is taking longer than usual. Our staff will reply to you as soon as they can. If it is urgent, please contact your nearest ARDB branch.",
  ),

  /**
   * Asked a few minutes after an answer, with Yes/No buttons.
   *
   * This is how an interaction ends: by asking, rather than by assuming the
   * customer has gone. Phrased so that "no" is a perfectly good answer and
   * not a dismissal -- a customer who is finished should feel finished, not
   * hurried off.
   */
  followUp: bilingual(
    "តើមានអ្វីផ្សេងទៀតដែលយើងអាចជួយអ្នកបានទេ?",
    "Is there anything else that we can help you with?",
  ),

  /** Button labels for the follow-up. */
  followUpYesButton: "បាទ/ចាស មាន · Yes",
  followUpNoButton: "អត់ទេ អរគុណ · No",

  /** Tapped Yes: invite the next question. */
  followUpYes: bilingual(
    "ល្អហើយ! សូមសរសេរសំណួរបន្ទាប់របស់អ្នកមកបាន។",
    "Of course — please type your next question.",
  ),

  /** Tapped No: acknowledge the end of the interaction. */
  followUpNo: bilingual(
    "អរគុណសម្រាប់ការទាក់ទងមក ARDB។ សូមសួរមកវិញបានគ្រប់ពេល។",
    "Thank you for contacting ARDB. You are welcome to write to us again any time.",
  ),

  /**
   * The satisfaction survey, sent once an interaction has ended.
   *
   * One tap, five options, no free text: a customer on a phone in a rice
   * field will answer a tap and will not answer an essay.
   */
  survey: bilingual(
    "សូមជួយវាយតម្លៃសេវាកម្មរបស់យើងថ្ងៃនេះ ដោយចុចលេខមួយខាងក្រោម (១ = មិនពេញចិត្ត, ៥ = ពេញចិត្តខ្លាំង)។",
    "Please rate our service today by tapping a number below (1 = not satisfied, 5 = very satisfied).",
  ),

  /** After a score is recorded. */
  surveyThanks: bilingual(
    "អរគុណសម្រាប់មតិរបស់អ្នក។ វាជួយយើងធ្វើឱ្យសេវាកម្មកាន់តែប្រសើរ។",
    "Thank you for your feedback. It helps us improve our service.",
  ),

  /** A button tapped on a message that no longer applies. */
  staleButton: bilingual(
    "ការជជែកនេះបានបញ្ចប់ហើយ។ សូមសរសេរសំណួរថ្មីមកបាន។",
    "That conversation has already ended. Please just type a new question.",
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
  /**
   * Shown on the card where a suggested answer would be, once the draft has
   * been given up on. Says what happened and what to do, because the
   * moderator reading it has no other way to find out.
   */
  draftTimedOut: (minutes: number) =>
    `No suggested answer arrived within ${minutes} minutes, so there will not be one. ` +
    "This question is yours to answer: tap Edit and write the reply, or Reject to " +
    "send the customer to a branch.",

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
  nudge: (reference: string, waiting: string, nudgeNumber: number, maxNudges: number) =>
    `⏰ ${reference} has been waiting ${waiting} with no answer. (Reminder ${nudgeNumber} of ${maxNudges}.)`,
  customerWarned: (reference: string, waiting: string) =>
    `${reference} has been waiting ${waiting}. The customer has been told it is taking longer than usual.`,
} as const;
