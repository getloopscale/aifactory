import { z } from 'zod'

import { MAX_LEAD_TIME_MINUTES, MIN_LEAD_TIME_MINUTES } from '../../shared/lead-time'
import { MAX_RUN_MINUTES, MIN_RUN_MINUTES } from '../../shared/panel'

const check = z.object({ name: z.string().max(40), command: z.string().max(600) })

/** A list of checks as a request may carry it; `patchProblem` says which ones can be saved. */
export const checksSchema = z.array(check).max(20)

/** Which list of a repository a proof is for; a request that names none is for its checks. */
export const proofKindSchema = z.enum(['checks', 'integration']).default('checks')

/** What may be changed on a repository, validated once at the boundary: the page's route and the guide's tool share it. */
export const repositoryPatchSchema = z.object({
  enabled: z.boolean().optional(),
  checks: checksSchema.nullable().optional(),
  integrationChecks: checksSchema.optional(),
  fixes: z.array(z.string().max(600)).max(20).optional(),
  egress: z.array(z.string().max(253)).max(50).optional(),
  baseBranch: z.string().max(100).nullable().optional(),
  releaseBranch: z.string().max(100).nullable().optional(),
  linearTeamId: z.string().max(100).nullable().optional(),
  linearLabel: z.string().max(100).nullable().optional(),
  askQuestions: z.boolean().optional(),
  reviewExternalPulls: z.boolean().optional(),
  harness: z.string().max(40).nullable().optional(),
  reviewer: z.string().max(40).nullable().optional(),
  releaseMode: z.enum(['manual', 'trial', 'auto']).nullable().optional(),
  runLimitMinutes: z.number().int().min(MIN_RUN_MINUTES).max(MAX_RUN_MINUTES).nullable().optional(),
  leadTimeAtRiskMinutes: z
    .number()
    .int()
    .min(MIN_LEAD_TIME_MINUTES)
    .max(MAX_LEAD_TIME_MINUTES)
    .nullable()
    .optional(),
  leadTimeOverdueMinutes: z
    .number()
    .int()
    .min(MIN_LEAD_TIME_MINUTES)
    .max(MAX_LEAD_TIME_MINUTES)
    .nullable()
    .optional(),
})
