/**
 * Cheap, dependency-free detection of "configure" requests (a calculation, a rule or a dashboard), shared by the Studio
 * intent parser and the deterministic parser (nl.ts). It only decides WHERE a request goes; it never builds anything.
 */

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim()

const DASHBOARD = /\b(create|build|make|add|set ?up|generate|design|give me)\b.{0,40}\bdashboard\b|^dashboard\b|\bdashboard (showing|with|that shows|for|of|to show|displaying)\b/
const CALCULATE = /^(please |can you |could you |i want to |i'd like to |i need to )?(automatically |auto-?)?(calculate|compute|work out)\b|\b(automatically|auto-?) (calculate|compute|set|update|mark|fill)\b|\b(add|create|make|set up) (a |an )?(calculation|calculated field|formula field)\b/
const RULE = /^(please |can you |could you )?(create (a )?rule[:,]? ?|add (a )?rule[:,]? ?|rule[:,] ?)?(if|when|whenever)\b.{2,}\b(then|set|mark|change|update)\b|\bif\b.{2,}\bthen\b.{0,12}\b(set|mark|change|update|make)\b|\b(add|create|make|set up) (a |an )?(conditional )?rule\b/

export type ConfigureShape = 'dashboard' | 'rule' | 'calculation'

/** Which kind of configuration a request asks for, or undefined when it is not a configure request. */
export function configureShape(input: string): ConfigureShape | undefined {
  const t = norm(input)
  if (!t) return undefined
  if (DASHBOARD.test(t)) return 'dashboard'
  if (RULE.test(t)) return 'rule'
  if (CALCULATE.test(t)) return 'calculation'
  return undefined
}

export const looksLikeConfigure = (input: string): boolean => configureShape(input) !== undefined
