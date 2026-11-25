/**
 * What the factory measures about itself and how it reacts when a number leaves its usual range. This file
 * is the configuration: a change to a band or a tier is a reviewed change to it, like code.
 */

export const METRIC_NAMES = [
  'first_pass_checks',
  'rework_rounds',
  'first_review_approval',
  'minutes_to_first_review',
  'minutes_to_delivery',
  'cost_per_delivery',
  'change_failure',
  'change_failure_required_checks',
  'change_failure_merge_conflict',
  'change_failure_release_red',
  'change_failure_other',
  'change_failure_low',
  'change_failure_medium',
  'change_failure_high',
  'hours_to_release',
  'handoff_share',
  'person_decisions_per_delivery',
  'net_lines_per_delivery',
  'test_share_of_change',
  'repeat_touch_share',
] as const
export type MetricName = (typeof METRIC_NAMES)[number]

/** Whether a stored name is one of the indicators measured today: a retired one may still have rows. */
export const isMetricName = (name: string): name is MetricName =>
  (METRIC_NAMES as readonly string[]).includes(name)

export type MetricSpec = {
  label: string
  unit: 'share' | 'count' | 'minutes' | 'hours' | 'usd'
  /** The direction in which the number gets worse. A move the other way never raises a signal. */
  worse: 'up' | 'down'
  /** A day with fewer observations than this makes no point: one run is not a rate. */
  minSamples: number
}

export const METRICS: Record<MetricName, MetricSpec> = {
  first_pass_checks: {
    label: 'Checks green on the first verification',
    unit: 'share',
    worse: 'down',
    minSamples: 3,
  },
  rework_rounds: { label: 'Rework rounds per run', unit: 'count', worse: 'up', minSamples: 3 },
  first_review_approval: {
    label: 'Approved on the first review',
    unit: 'share',
    worse: 'down',
    minSamples: 3,
  },
  minutes_to_first_review: {
    label: 'Minutes from the start of a run to its first review',
    unit: 'minutes',
    worse: 'up',
    minSamples: 3,
  },
  minutes_to_delivery: {
    label: 'Minutes from the start of a run to its delivery',
    unit: 'minutes',
    worse: 'up',
    minSamples: 3,
  },
  cost_per_delivery: {
    label: 'Cost per delivered run',
    unit: 'usd',
    worse: 'up',
    minSamples: 3,
  },
  change_failure: {
    label: 'Delivered work that came back',
    unit: 'share',
    worse: 'up',
    minSamples: 3,
  },
  // The causes of `change_failure`: each delivered run says one of them when it came back, so they add up to it.
  change_failure_required_checks: {
    label: 'Delivered work that came back: the required checks failed',
    unit: 'share',
    worse: 'up',
    minSamples: 3,
  },
  change_failure_merge_conflict: {
    label: 'Delivered work that came back: a merge conflict',
    unit: 'share',
    worse: 'up',
    minSamples: 3,
  },
  change_failure_release_red: {
    label: 'Delivered work that came back: the release went red',
    unit: 'share',
    worse: 'up',
    minSamples: 3,
  },
  change_failure_other: {
    label: 'Delivered work that came back: another cause',
    unit: 'share',
    worse: 'up',
    minSamples: 3,
  },
  // `change_failure` split by the risk level recorded for the delivered commit (#470). A delivery from before
  // the level was recorded is in none of them. Nothing acts on these; they are what a later decision reads.
  change_failure_low: {
    label: 'Delivered work that came back: low-risk changes',
    unit: 'share',
    worse: 'up',
    minSamples: 3,
  },
  change_failure_medium: {
    label: 'Delivered work that came back: medium-risk changes',
    unit: 'share',
    worse: 'up',
    minSamples: 3,
  },
  change_failure_high: {
    label: 'Delivered work that came back: high-risk changes',
    unit: 'share',
    worse: 'up',
    minSamples: 3,
  },
  hours_to_release: {
    label: 'Hours from the task to its release',
    unit: 'hours',
    worse: 'up',
    minSamples: 1,
  },
  handoff_share: {
    label: 'Finished runs handed to a person',
    unit: 'share',
    worse: 'up',
    minSamples: 3,
  },
  // Its samples are the deliveries of the day: a day with none makes no point, whatever a person decided.
  person_decisions_per_delivery: {
    label: "A person's decisions per delivered run",
    unit: 'count',
    worse: 'up',
    minSamples: 3,
  },
  // The three below describe the code the deliveries add up to (#474). Their samples are deliveries with a measured change.
  net_lines_per_delivery: {
    label: 'Lines added minus removed outside tests, per delivered run',
    unit: 'count',
    worse: 'up',
    minSamples: 3,
  },
  test_share_of_change: {
    label: 'Share of the added lines that are in test files',
    unit: 'share',
    worse: 'down',
    minSamples: 3,
  },
  repeat_touch_share: {
    label: 'Delivered runs that changed a file another delivery changed in the 14 days before',
    unit: 'share',
    worse: 'up',
    minSamples: 3,
  },
}

export const RULES = [
  'beyond_3_sigma',
  'two_of_three_beyond_2_sigma',
  'four_of_five_beyond_1_sigma',
  'eight_on_one_side',
] as const
export type Rule = (typeof RULES)[number]

/** What a broken rule leads to: `log` only records it, `show` also puts it on the panel, `act` opens an issue. */
export type Tier = 'log' | 'show' | 'act'

export type BandConfig = {
  /** The days before a point that make its baseline. */
  windowDays: number
  /** A baseline with fewer points than this says nothing, so no rule is read against it. */
  minBaselinePoints: number
  tiers: Record<Rule, Tier>
  /** Where an `act` signal is filed. */
  issueRepository: string
}

export const BANDS: BandConfig = {
  windowDays: 30,
  minBaselinePoints: 7,
  tiers: {
    beyond_3_sigma: 'act',
    two_of_three_beyond_2_sigma: 'show',
    four_of_five_beyond_1_sigma: 'log',
    // A slow drift breaks no sigma line, and it is the change nobody notices.
    eight_on_one_side: 'show',
  },
  issueRepository: 'paulohenriquevn/aifactory',
}

/** How the last week of each indicator is compared with the weeks before a baseline date. */
export type ComparisonConfig = {
  /** The days before the baseline date that make the baseline. */
  baselineDays: number
  /** The days, ending today, whose mean is compared. */
  weekDays: number
  /** A baseline with fewer points than this says nothing, so no week is compared with it. */
  minBaselinePoints: number
  /**
   * The width of the control band around the baseline mean, in standard errors of a mean of the week's
   * points: a mean of seven days varies less than one day does, so the band narrows by the root of their count.
   */
  sigmas: number
}

export const COMPARISON: ComparisonConfig = {
  baselineDays: 28,
  weekDays: 7,
  minBaselinePoints: 7,
  sigmas: 3,
}
