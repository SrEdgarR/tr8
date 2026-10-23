import type { ProcessStatus } from '../data/processes';
export function processFixture(): ProcessStatus {
  return {
    channels: { email: false, google: false },
    scheduler: { enabled: true, last_run_at: '2026-10-23T19:00:00Z' },
    budget: { daily_limit: 500, used_today: 1, batch_limit: 20, max_attempts: 8, monthly_limit: 10000, used_month: 1, blocked: false },
    counts: { pending: 0, leased: 0, retry: 0, succeeded: 1, cancelled: 0, unknown: 0, dead: 0 },
    retention_days: 30,
    jobs: [
      {
        id: '154db997-7778-41d6-85a2-65ad32f84c55',
        entity_kind: 'task',
        event_kind: 'task.changed',
        state: 'succeeded',
        attempts: 1,
        created_at: '2026-10-23T18:59:00Z',
        available_at: '2026-10-23T18:59:00Z',
        finished_at: '2026-10-23T19:00:00Z',
        reason: 'reconciled',
      },
    ],
  };
}
