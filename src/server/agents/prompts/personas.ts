import { PERSONAS, PERSONA_ROLES, type Persona, type PersonaRole } from '../../../shared/personas'

export { PERSONAS, PERSONA_ROLES }
export type { Persona, PersonaRole }

/** The opening of every prompt of a role: who the agent is, its one job and what it never does. */
export function personaPreamble(role: PersonaRole): string {
  const p = PERSONAS[role]
  return `You are ${p.name}, the ${role} of the aifactory. Your one job: ${p.job}.
You never: ${p.never.join('; ')}.
How you sound: ${p.voice}
`
}

/** The prompt with its role's preamble above it. */
export const withPersona = (role: PersonaRole, prompt: string): string =>
  `${personaPreamble(role)}\n${prompt}`
