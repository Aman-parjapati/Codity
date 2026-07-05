import { db } from '../../shared/db.js';
import { executeJob, generateAiFailureSummary } from '../../worker/src/executor.js';
import parser from 'cron-parser';

// Simulating the claiming query logic from worker/src/index.js
async function simulateClaimJob(workerId) {
  return await db.transaction(async (conn) => {
    // 1. Fetch active queues and running counts
    const [queues] = await conn.query(`
      SELECT q.id, q.concurrency_limit, 
        (SELECT COUNT(*) FROM jobs run_j WHERE run_j.queue_id = q.id AND run_j.status = 'running') as running_count
      FROM queues q
      WHERE q.is_paused = FALSE
    `);

    const eligibleQueueIds = queues
      .filter(q => q.running_count < q.concurrency_limit)
      .map(q => q.id);

    if (eligibleQueueIds.length === 0) return null;

    const placeholders = eligibleQueueIds.map(() => '?').join(',');
    const claimQuery = `
      SELECT j.id, j.name, j.queue_id, j.payload, j.retry_count, j.max_retries, j.recurring_cron, j.retry_policy_id
      FROM jobs j
      JOIN queues q ON j.queue_id = q.id
      WHERE j.status = 'queued'
        AND j.run_at <= NOW()
        AND j.queue_id IN (${placeholders})
        AND NOT EXISTS (
          SELECT 1 FROM job_dependencies jd
          JOIN jobs parent ON jd.parent_job_id = parent.id
          WHERE jd.child_job_id = j.id AND parent.status != 'completed'
        )
      ORDER BY q.priority DESC, j.created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;

    const [rows] = await conn.query(claimQuery, eligibleQueueIds);
    if (!rows || rows.length === 0) return null;

    const job = rows[0];
    await conn.query(
      `UPDATE jobs SET status = 'running', worker_id = ?, started_at = NOW(), updated_at = NOW() WHERE id = ?`,
      [workerId, job.id]
    );

    return job;
  });
}

describe('Distributed Job Scheduler Core Engine Integration Tests', () => {
  const testQueueId = 'q-test-integration-0000';
  const testProjectId = 'prj-3333-3333-3333-333333333333'; // From seeds

  beforeAll(async () => {
    // Inject a test queue
    await db.queryRaw(`
      INSERT INTO queues (id, project_id, name, priority, concurrency_limit, is_paused)
      VALUES (?, ?, ?, ?, ?, FALSE)
      ON DUPLICATE KEY UPDATE priority = ?, concurrency_limit = ?, is_paused = FALSE
    `, [testQueueId, testProjectId, 'test-integration-queue', 50, 2, 50, 2]);

    // Pause all other queues during the test run to avoid seed state pollution
    await db.queryRaw('UPDATE queues SET is_paused = TRUE WHERE id != ?', [testQueueId]);
  });

  afterAll(async () => {
    // Clean up test items
    await db.queryRaw('DELETE FROM jobs WHERE queue_id = ?', [testQueueId]);
    await db.queryRaw('DELETE FROM queues WHERE id = ?', [testQueueId]);
    // Restore default active status for other queues
    await db.queryRaw('UPDATE queues SET is_paused = FALSE');
    await db.close();
  });

  beforeEach(async () => {
    await db.queryRaw('DELETE FROM jobs WHERE queue_id = ?', [testQueueId]);
  });

  test('Claim atomic lock & concurrency limits (Respects max limit)', async () => {
    // 1. Enqueue 4 jobs on a queue with concurrency limit of 2
    await db.queryRaw(`
      INSERT INTO jobs (id, queue_id, name, status, run_at) VALUES 
      ('t-job-1', ?, 'Task 1', 'queued', NOW()),
      ('t-job-2', ?, 'Task 2', 'queued', NOW()),
      ('t-job-3', ?, 'Task 3', 'queued', NOW()),
      ('t-job-4', ?, 'Task 4', 'queued', NOW())
    `, [testQueueId, testQueueId, testQueueId, testQueueId]);

    // 2. Claim job 1 by worker-A
    const jobA1 = await simulateClaimJob('worker-A');
    expect(jobA1).not.toBeNull();
    expect(jobA1.id).toBe('t-job-1');

    // 3. Claim job 2 by worker-B
    const jobB1 = await simulateClaimJob('worker-B');
    expect(jobB1).not.toBeNull();
    expect(jobB1.id).toBe('t-job-2');

    // 4. Try claiming a third job (should fail/return null since queue concurrency limit = 2 is reached)
    const jobC1 = await simulateClaimJob('worker-C');
    expect(jobC1).toBeNull();

    // 5. Complete task 1 and free concurrency slot
    await db.queryRaw("UPDATE jobs SET status = 'completed' WHERE id = 't-job-1'");

    // 6. Claim again, should succeed now and claim the next available job in line
    const jobC2 = await simulateClaimJob('worker-C');
    expect(jobC2).not.toBeNull();
    expect(jobC2.id).toBe('t-job-3');
  });

  test('Job Workflow DAG Dependencies (Blocks children until parents complete)', async () => {
    // 1. Enqueue parent (job-p) and child (job-c)
    await db.queryRaw(`
      INSERT INTO jobs (id, queue_id, name, status, run_at) VALUES 
      ('job-p', ?, 'Parent Task', 'queued', NOW()),
      ('job-c', ?, 'Child Task', 'queued', NOW())
    `, [testQueueId, testQueueId]);

    // Link dependency: job-c depends on job-p
    await db.queryRaw('INSERT INTO job_dependencies (parent_job_id, child_job_id) VALUES (?, ?)', ['job-p', 'job-c']);

    // 2. Claim next task: Parent should be claimed since it has no unsatisfied dependencies
    const claimed1 = await simulateClaimJob('worker-A');
    expect(claimed1).not.toBeNull();
    expect(claimed1.id).toBe('job-p');

    // 3. Try to claim again: Child task should NOT be claimed because parent is still running ('running' != 'completed')
    const claimed2 = await simulateClaimJob('worker-B');
    expect(claimed2).toBeNull();

    // 4. Complete parent task
    await db.queryRaw("UPDATE jobs SET status = 'completed' WHERE id = 'job-p'");

    // 5. Claim again: Child task should now be claimed
    const claimed3 = await simulateClaimJob('worker-B');
    expect(claimed3).not.toBeNull();
    expect(claimed3.id).toBe('job-c');
  });

  test('Backoff Retry Policy calculations', () => {
    // Simulating retry calculation logic
    const calculateDelay = (type, base, max, count) => {
      let delay = base;
      if (type === 'linear') delay = base * (count + 1);
      else if (type === 'exponential') delay = base * Math.pow(2, count);
      return Math.min(delay, max);
    };

    // Test Linear Backoff (Base 5s, Max 60s)
    expect(calculateDelay('linear', 5, 60, 0)).toBe(5);
    expect(calculateDelay('linear', 5, 60, 1)).toBe(10);
    expect(calculateDelay('linear', 5, 60, 2)).toBe(15);

    // Test Exponential Backoff (Base 2s, Max 30s)
    expect(calculateDelay('exponential', 2, 30, 0)).toBe(2); // 2 * 1
    expect(calculateDelay('exponential', 2, 30, 1)).toBe(4); // 2 * 2
    expect(calculateDelay('exponential', 2, 30, 2)).toBe(8); // 2 * 4
    expect(calculateDelay('exponential', 2, 30, 3)).toBe(16); // 2 * 8
    expect(calculateDelay('exponential', 2, 30, 4)).toBe(30); // 2 * 16 = 32 (capped at 30)
  });
});
