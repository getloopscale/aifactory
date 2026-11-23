import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import { stageEvent } from './schema'

describe('stage_event task index', () => {
  it('is declared on task, stage and id, in that order', () => {
    const index = getTableConfig(stageEvent).indexes.find(
      (i) => i.config.name === 'stage_event_task_stage_id',
    )
    expect(index?.config.columns.map((c) => (c as { name: string }).name)).toEqual([
      'task_id',
      'stage',
      'id',
    ])
  })

  it('is created by a migration that is safe on a database that already has it', () => {
    const sql = readFileSync(join(process.cwd(), 'drizzle/0037_stage_event_task_index.sql'), 'utf8')
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "stage_event_task_stage_id" ON "stage_event" USING btree ("task_id","stage","id")',
    )
  })
})
