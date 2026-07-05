import { v4 as uuidv4 } from 'uuid';
import os from 'os';
import parser from 'cron-parser';
import db from '../../shared/db.js';
import { executeJob, generateAiFailureSummary } from './executor.js';

const workerId = uuidv4();
const hostname = process.env.WORKER_HOSTNAME || `Aman-node-${Math.floor(Math.random() * 4) + 1}`;
const CONCURRENCY_LIMIT = parseInt(process.env.CONCURRENCY_LIMIT) || 1; // Max concurrent tasks per worker (default 1 slot)
let activeJobsCount = 0;
let isShuttingDown = false;
let pollingTimeout = null;
let heartbeatInterval = null;

console.log(`Initializing Worker Service Node (ID: ${workerId}, Hostname: ${hostname})`);

// 1. Register Worker in database
async function registerWorker() {
  try {
    await db.queryRaw(
      `INSERT INTO workers (id, hostname, concurrency_limit, status, started_at, last_heartbeat_at)
       VALUES (?, ?, ?, 'active', NOW(), NOW())
       ON DUPLICATE KEY UPDATE status = 'active', last_heartbeat_at = NOW()`,
      [workerId, hostname, CONCURRENCY_LIMIT]
    );
    console.log(`Worker registered successfully in DB.`);
  } catch (error) {
    console.error('Failed to register worker in DB:', error);
    process.exit(1);
  }
}

// 2. Worker Heartbeat Loop
function startHeartbeat() {
  heartbeatInterval = setInterval(async () => {
    try {
      await db.queryRaw(
        'UPDATE workers SET last_heartbeat_at = NOW() WHERE id = ?',
        [workerId]
      );
    } catch (error) {
      console.error('Worker heartbeat failed:', error.message);
    }
  }, 5000);
}

// 3. Log writer helper to insert job logs directly to DB
async function writeJobLog(jobId, executionId, level, message) {
  const ts = new Date().toISOString();
  console.log(`[JobLog] [${level.toUpperCase()}] [${jobId}] [${ts}] ${message}`);
  try {
    await db.queryRaw(
      `INSERT INTO job_logs (job_id, execution_id, level, message)
       VALUES (?, ?, ?, ?)`,
      [jobId, executionId, level, message]
    );
  } catch (error) {
    console.error(`Failed to write job log for job ${jobId} to DB:`, error.message);
  }
}

// 4. Calculate retry delay based on policy
async function calculateRetryDelay(policyId, retryCount) {
  if (!policyId) return 5; // Default 5 seconds if no policy
  
  try {
    const [policies] = await db.queryRaw(
      'SELECT type, base_delay_seconds, max_delay_seconds FROM retry_policies WHERE id = ?',
      [policyId]
    );
    
    if (!policies || policies.length === 0) return 5;
    
    const policy = policies[0];
    let delay = policy.base_delay_seconds;
    
    if (policy.type === 'linear') {
      delay = policy.base_delay_seconds * (retryCount + 1);
    } else if (policy.type === 'exponential') {
      delay = policy.base_delay_seconds * Math.pow(2, retryCount);
    }
    
    return Math.min(delay, policy.max_delay_seconds);
  } catch (error) {
    console.error('Error fetching retry policy details:', error);
    return 5;
  }
}

// 5. Handle complete job outcomes (Success / Retry / DLQ)
async function handleJobSuccess(job, durationMs) {
  try {
    await db.transaction(async (conn) => {
      // Create completed execution log
      await conn.query(
        `UPDATE job_executions 
         SET status = 'completed', finished_at = NOW(), duration_ms = ?
         WHERE id = ?`,
        [durationMs, job.executionId]
      );

      // Handle cron rescheduling if present
      if (job.recurring_cron) {
        try {
          const interval = parser.parseExpression(job.recurring_cron);
          const nextRunAt = interval.next().toDate();
          
          await conn.query(
            `UPDATE jobs 
             SET status = 'scheduled',
                 run_at = ?,
                 worker_id = NULL,
                 claimed_at = NULL,
                 started_at = NULL,
                 completed_at = NULL,
                 retry_count = 0,
                 updated_at = NOW()
             WHERE id = ?`,
            [nextRunAt, job.id]
          );
          console.log(`Rescheduled recurring job "${job.name}" (ID: ${job.id}) for next run: ${nextRunAt.toISOString()}`);
        } catch (cronErr) {
          throw new Error('Cron reschedule calculation failed: ' + cronErr.message);
        }
      } else {
        // Normal completion
        await conn.query(
          `UPDATE jobs 
           SET status = 'completed', completed_at = NOW(), updated_at = NOW()
           WHERE id = ?`,
          [job.id]
        );
      }
    });
  } catch (error) {
    console.error(`Failed to record job success for ${job.id}:`, error);
  }
}

async function handleJobFailure(job, errorMessage, durationMs) {
  const currentRetry = job.retry_count;
  const maxRetries = job.max_retries;

  try {
    const aiSummary = generateAiFailureSummary(job.name, errorMessage);

    if (currentRetry < maxRetries) {
      const delaySeconds = await calculateRetryDelay(job.retry_policy_id, currentRetry);
      const nextRunAt = new Date(Date.now() + delaySeconds * 1000);

      await db.transaction(async (conn) => {
        // 1. Update current execution log to failed
        await conn.query(
          `UPDATE job_executions 
           SET status = 'failed', error_message = ?, ai_summary = ?, finished_at = NOW(), duration_ms = ?
           WHERE id = ?`,
          [errorMessage, aiSummary, durationMs, job.executionId]
        );

        // 2. Put job back in queued status with incremented retry count and delay
        await conn.query(
          `UPDATE jobs 
           SET status = 'queued',
               retry_count = retry_count + 1,
               run_at = ?,
               worker_id = NULL,
               claimed_at = NULL,
               started_at = NULL,
               updated_at = NOW()
           WHERE id = ?`,
          [nextRunAt, job.id]
        );
      });
      
      await writeJobLog(job.id, job.executionId, 'warn', `Job failed. Scheduled retry #${currentRetry + 1} in ${delaySeconds}s (at ${nextRunAt.toISOString()})`);
    } else {
      // Move to Dead Letter Queue (DLQ)
      await db.transaction(async (conn) => {
        // 1. Update current execution log
        await conn.query(
          `UPDATE job_executions 
           SET status = 'failed', error_message = ?, ai_summary = ?, finished_at = NOW(), duration_ms = ?
           WHERE id = ?`,
          [errorMessage, aiSummary, durationMs, job.executionId]
        );

        // 2. Update job status to 'dlq'
        await conn.query(
          `UPDATE jobs 
           SET status = 'dlq', updated_at = NOW()
           WHERE id = ?`,
          [job.id]
        );

        // 3. Insert into DLQ table
        const dlqId = uuidv4();
        await conn.query(
          `INSERT INTO dead_letter_queue (id, job_id, queue_id, original_payload, failure_reason)
           VALUES (?, ?, ?, ?, ?)`,
          [
            dlqId,
            job.id,
            job.queue_id,
            job.payload ? JSON.stringify(job.payload) : null,
            `Max retries (${maxRetries}) exceeded. Last failure: ${errorMessage}`
          ]
        );
      });

      await writeJobLog(job.id, job.executionId, 'error', `Job failed permanently. Max retries exceeded. Exited to Dead Letter Queue (DLQ).`);
    }
  } catch (error) {
    console.error(`Failed to handle job failure for ${job.id}:`, error);
  }
}

// 6. Polling loop
async function pollAndClaimJob() {
  if (isShuttingDown) return;

  // Enforce local worker concurrency check
  if (activeJobsCount >= CONCURRENCY_LIMIT) {
    // Check back in 500ms
    pollingTimeout = setTimeout(pollAndClaimJob, 500);
    return;
  }

  let claimedJob = null;

  try {
    claimedJob = await db.transaction(async (conn) => {
      // A. Fetch active queues and running job counts to verify which queues are within limits
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

      // B. Fetch highest priority job from the eligible queues using FOR UPDATE SKIP LOCKED
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
      const executionId = uuidv4();

      // C. Claim the job in DB
      await conn.query(
        `UPDATE jobs 
         SET status = 'running',
             worker_id = ?,
             started_at = NOW(),
             claimed_at = NOW(),
             updated_at = NOW()
         WHERE id = ?`,
        [workerId, job.id]
      );

      // D. Log execution entry
      await conn.query(
        `INSERT INTO job_executions (id, job_id, worker_id, status, started_at)
         VALUES (?, ?, ?, 'running', NOW())`,
        [executionId, job.id, workerId]
      );

      return { ...job, executionId };
    });
  } catch (error) {
    console.error('Polling transaction error:', error);
  }

  if (claimedJob) {
    // Increment local concurrency count and execute asynchronously
    activeJobsCount++;
    runJobAsync(claimedJob);
  }

  // Poll again immediately if we claimed a job (increases throughput), or wait 1000ms if idle
  const nextPollDelay = claimedJob ? 50 : 1000;
  pollingTimeout = setTimeout(pollAndClaimJob, nextPollDelay);
}

// 7. Core Async Runner
async function runJobAsync(job) {
  const startTime = Date.now();
  const logger = (level, msg) => writeJobLog(job.id, job.executionId, level, msg);

  try {
    await executeJob(job, job.executionId, logger);
    const durationMs = Date.now() - startTime;
    await handleJobSuccess(job, durationMs);
  } catch (err) {
    const durationMs = Date.now() - startTime;
    await handleJobFailure(job, err.message, durationMs);
  } finally {
    activeJobsCount--;
    console.log(`Job finished. Local concurrency slots: ${activeJobsCount}/${CONCURRENCY_LIMIT}`);
  }
}

// 8. Graceful Shutdown Implementation
async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log(`Received ${signal}. Starting graceful worker shutdown...`);
  
  if (pollingTimeout) clearTimeout(pollingTimeout);
  if (heartbeatInterval) clearInterval(heartbeatInterval);

  // Wait for currently running jobs to complete
  let checkAttempts = 0;
  const maxAttempts = 15;
  while (activeJobsCount > 0 && checkAttempts < maxAttempts) {
    console.log(`Waiting for ${activeJobsCount} active jobs to complete... (Attempt ${checkAttempts + 1}/${maxAttempts})`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    checkAttempts++;
  }

  try {
    // Unregister worker
    console.log('Unregistering worker in DB...');
    await db.queryRaw('UPDATE workers SET status = \'inactive\' WHERE id = ?', [workerId]);
  } catch (error) {
    console.error('Error during worker unregistration:', error.message);
  } finally {
    await db.close();
    console.log('Database connections closed. Worker exited.');
    process.exit(0);
  }
}

// Start
async function bootstrap() {
  await registerWorker();
  startHeartbeat();
  // Kickstart polling loop
  pollAndClaimJob();
  
  // Register signals
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap();
