import type { Question } from '../blueprint/schema'
import type { QuestionAnswer } from '../state/types'

/**
 * Clarifying questions are expensive for the person answering, so the client answers the obvious ones itself:
 *  - an option that the request already names is chosen (the request says it, so it is not a question)
 *  - a currency is read from the request, else from the browser's region
 *  - a question that comes with a safe default takes that default
 *  - a multiple-choice question with no default takes its first option when the wrong guess is cheap to change later
 * Only what is genuinely ambiguous (no option, no default, nothing in the request) is shown, and never more than three.
 */
export const MAX_ASKED = 3

const REGION_CURRENCY: Record<string, string> = { GB: 'GBP', US: 'USD', CA: 'CAD', AU: 'AUD', NZ: 'NZD', IN: 'INR', JP: 'JPY', CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', AE: 'AED', ZA: 'ZAR', IE: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', PT: 'EUR', BE: 'EUR', AT: 'EUR', FI: 'EUR' }
const TZ_CURRENCY: [RegExp, string][] = [[/^Europe\/London/, 'GBP'], [/^America\//, 'USD'], [/^Australia\//, 'AUD'], [/^Asia\/(Kolkata|Calcutta)/, 'INR'], [/^Asia\/Dubai/, 'AED'], [/^Asia\/Tokyo/, 'JPY'], [/^Europe\//, 'EUR']]

const CURRENCY_IN_TEXT: [RegExp, string][] = [[/£|\bgbp\b|\bpounds?\b|\bsterling\b/i, 'GBP'], [/\$|\busd\b|\bdollars?\b/i, 'USD'], [/€|\beur\b|\beuros?\b/i, 'EUR'], [/\baud\b/i, 'AUD'], [/\bcad\b/i, 'CAD'], [/₹|\binr\b|\brupees?\b/i, 'INR']]

export function guessCurrency(request: string, locale = typeof navigator !== 'undefined' ? navigator.language : 'en-GB', timeZone = safeTz()): string {
  for (const [re, c] of CURRENCY_IN_TEXT) if (re.test(request)) return c
  const region = /-([A-Z]{2})$/.exec(locale)?.[1]
  if (region && REGION_CURRENCY[region]) return REGION_CURRENCY[region]
  for (const [re, c] of TZ_CURRENCY) if (re.test(timeZone)) return c
  return 'GBP'
}

function safeTz() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export interface AutoAnswers {
  /** answered silently */
  auto: QuestionAnswer[]
  /** genuinely ambiguous: shown to the user (at most MAX_ASKED) */
  ask: Question[]
}

/**
 * Questions about a calculation, rule or dashboard are about WHICH real field or module the person meant. Picking the first
 * option or a "safe default" would be a guess, so only a question with exactly one possible answer is settled silently.
 */
export function autoAnswerConfigure(questions: Question[], now = new Date()): AutoAnswers {
  const auto: QuestionAnswer[] = []
  const ask: Question[] = []
  const at = now.toISOString()
  for (const q of questions) {
    if (q.options.length === 1) auto.push({ questionId: q.id, question: q.question, answer: q.options[0], at })
    else ask.push(q)
  }
  return { auto, ask: ask.slice(0, MAX_ASKED) }
}

export function autoAnswer(questions: Question[], request: string, now = new Date()): AutoAnswers {
  const text = norm(request)
  const auto: QuestionAnswer[] = []
  const ask: Question[] = []
  const at = now.toISOString()
  const done = (q: Question, answer: string) => auto.push({ questionId: q.id, question: q.question, answer, at })

  for (const q of questions) {
    const named = q.options.find((o) => o.length > 1 && new RegExp(`\\b${norm(o).replace(/ /g, '\\s+')}\\b`).test(text))
    if (named) { done(q, named); continue }
    if (q.id === 'currency' || /currenc/i.test(q.question)) { done(q, guessCurrency(request)); continue }
    if (q.safeDefault) { done(q, q.safeDefault); continue }
    if (q.options.length >= 2 && q.id !== 'business_type') { done(q, q.options[0]); continue }
    ask.push(q)
  }
  // anything beyond three genuine questions is answered with a sensible default instead of being asked
  const extra = ask.splice(MAX_ASKED)
  for (const q of extra) done(q, q.options[0] ?? 'Use your best judgement')
  return { auto, ask }
}
