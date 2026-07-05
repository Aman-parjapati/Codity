import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import parser from 'cron-parser';
import db from '../../../shared/db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Get jobs list with filters, search, and pagination
router.get('/', authenticateToken, async (req, res) => {
  const orgId = req.user.organizationId;
  const { status, queue_id, search, limit = 20, offset = 0 } = req.query;

  try {
    let query = `
      SELECT j.*, q.name as queue_name, p.name as project_name
      FROM jobs j
      JOIN queues q ON j.queue_id = q.id
      JOIN projects p ON q.project_id = p.id
      WHERE p.organization_id = ?
    `;
    const params = [orgId];

    if (status) {
      query += ` AND j.status = ?`;
      params.push(status);
    }
    if (queue_id) {
      query += ` AND j.queue_id = ?`;
      params.push(queue_id);
    }
    if (search) {
      query += ` AND (j.name LIKE ? OR j.id LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ` ORDER BY j.created_at DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));

    const [jobs] = await db.queryRaw(query, params);

    // Get total count
    let countQuery = `
      SELECT COUNT(*) as total
      FROM jobs j
      JOIN queues q ON j.queue_id = q.id
      JOIN projects p ON q.project_id = p.id
      WHERE p.organization_id = ?
    `;
    const countParams = [orgId];

    if (status) {
      countQuery += ` AND j.status = ?`;
      countParams.push(status);
    }
    if (queue_id) {
      countQuery += ` AND j.queue_id = ?`;
      countParams.push(queue_id);
    }
    if (search) {
      countQuery += ` AND (j.name LIKE ? OR j.id LIKE ?)`;
      countParams.push(`%${search}%`, `%${search}%`);
    }

    const [totalRes] = await db.queryRaw(countQuery, countParams);

    res.json({
      jobs,
      total: totalRes[0]?.total || 0,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Fetch jobs error:', error);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

// Get job details (payload, logs, executions, dependencies)
router.get('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const orgId = req.user.organizationId;

  try {
    const [jobs] = await db.queryRaw(
      `SELECT j.*, q.name as queue_name, p.name as project_name
       FROM jobs j
       JOIN queues q ON j.queue_id = q.id
       JOIN projects p ON q.project_id = p.id
       WHERE j.id = ? AND p.organization_id = ?`,
      [id, orgId]
    );

    if (!jobs || jobs.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const job = jobs[0];

    // Fetch executions
    const [executions] = await db.queryRaw(
      `SELECT * FROM job_executions WHERE job_id = ? ORDER BY started_at DESC`,
      [id]
    );

    // Fetch logs (limit to last 200 logs for safety)
    const [logs] = await db.queryRaw(
      `SELECT * FROM job_logs WHERE job_id = ? ORDER BY created_at ASC LIMIT 200`,
      [id]
    );

    // Fetch dependencies
    const [parents] = await db.queryRaw(
      `SELECT jd.parent_job_id, p.name, p.status 
       FROM job_dependencies jd
       JOIN jobs p ON jd.parent_job_id = p.id
       WHERE jd.child_job_id = ?`,
      [id]
    );

    const [children] = await db.queryRaw(
      `SELECT jd.child_job_id, c.name, c.status 
       FROM job_dependencies jd
       JOIN jobs c ON jd.child_job_id = c.id
       WHERE jd.parent_job_id = ?`,
      [id]
    );

    res.json({
      job,
      executions,
      logs,
      dependencies: {
        parents,
        children
      }
    });
  } catch (error) {
    console.error('Fetch job details error:', error);
    res.status(500).json({ error: 'Failed to fetch job details' });
  }
});

// Enqueue a job
router.post('/', authenticateToken, async (req, res) => {
  const { queue_id, name, payload, run_at, recurring_cron, max_retries, retry_policy_id, dependencies } = req.body;
  const orgId = req.user.organizationId;

  if (!queue_id || !name) {
    return res.status(400).json({ error: 'queue_id and name are required' });
  }

  try {
    // Validate queue and ownership
    const [queue] = await db.queryRaw(
      `SELECT q.id, q.retry_policy_id FROM queues q 
       JOIN projects p ON q.project_id = p.id 
       WHERE q.id = ? AND p.organization_id = ?`,
      [queue_id, orgId]
    );

    if (!queue || queue.length === 0) {
      return res.status(404).json({ error: 'Target queue not found' });
    }

    const jobId = uuidv4();
    let runTime = run_at ? new Date(run_at) : new Date();
    let status = 'queued';

    // If recurring cron, validate and set initial execution time
    if (recurring_cron) {
      try {
        const interval = parser.parseExpression(recurring_cron);
        runTime = interval.next().toDate();
        status = 'scheduled';
      } catch (err) {
        return res.status(400).json({ error: 'Invalid cron expression: ' + err.message });
      }
    } else if (run_at && new Date(run_at) > new Date()) {
      status = 'scheduled';
    }

    // Handle dependency mapping inside transaction
    await db.transaction(async (conn) => {
      // 1. Insert Job
      await conn.query(
        `INSERT INTO jobs (id, queue_id, name, payload, status, run_at, recurring_cron, max_retries, retry_policy_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          jobId,
          queue_id,
          name,
          payload ? JSON.stringify(payload) : null,
          status,
          runTime,
          recurring_cron || null,
          max_retries !== undefined ? max_retries : 3,
          retry_policy_id || queue[0].retry_policy_id || null
        ]
      );

      // 2. Wire up parent dependencies
      if (dependencies && Array.isArray(dependencies) && dependencies.length > 0) {
        for (const parentId of dependencies) {
          // Check if parent exists
          const [parent] = await conn.query('SELECT id FROM jobs WHERE id = ?', [parentId]);
          if (parent && parent.length > 0) {
            await conn.query(
              'INSERT INTO job_dependencies (parent_job_id, child_job_id) VALUES (?, ?)',
              [parentId, jobId]
            );
          }
        }
        // Force state to scheduled if it has pending dependencies
        await conn.query(`UPDATE jobs SET status = 'scheduled' WHERE id = ?`, [jobId]);
      }
    });

    const [newJob] = await db.queryRaw('SELECT * FROM jobs WHERE id = ?', [jobId]);
    res.status(201).json(newJob[0]);
  } catch (error) {
    console.error('Enqueue job error:', error);
    res.status(500).json({ error: 'Failed to enqueue job: ' + error.message });
  }
});

// Enqueue a batch of jobs
router.post('/batch', authenticateToken, async (req, res) => {
  const { queue_id, jobs } = req.body; // jobs is an array of {name, payload}
  const orgId = req.user.organizationId;

  if (!queue_id || !jobs || !Array.isArray(jobs) || jobs.length === 0) {
    return res.status(400).json({ error: 'queue_id and non-empty jobs array are required' });
  }

  try {
    const [queue] = await db.queryRaw(
      `SELECT q.id FROM queues q 
       JOIN projects p ON q.project_id = p.id 
       WHERE q.id = ? AND p.organization_id = ?`,
      [queue_id, orgId]
    );

    if (!queue || queue.length === 0) {
      return res.status(404).json({ error: 'Target queue not found' });
    }

    const batchId = uuidv4();
    const createdJobs = [];

    await db.transaction(async (conn) => {
      for (const job of jobs) {
        const jobId = uuidv4();
        await conn.query(
          `INSERT INTO jobs (id, queue_id, name, payload, status, batch_id)
           VALUES (?, ?, ?, ?, 'queued', ?)`,
          [jobId, queue_id, job.name, job.payload ? JSON.stringify(job.payload) : null, batchId]
        );
        createdJobs.push({ id: jobId, name: job.name });
      }
    });

    res.status(201).json({
      message: `Enqueued batch of ${jobs.length} jobs.`,
      batchId,
      jobs: createdJobs
    });
  } catch (error) {
    console.error('Enqueue batch error:', error);
    res.status(500).json({ error: 'Failed to enqueue batch' });
  }
});

// Trigger retry for failed/DLQ job
router.post('/:id/retry', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const orgId = req.user.organizationId;

  try {
    const [job] = await db.queryRaw(
      `SELECT j.id, j.status FROM jobs j 
       JOIN queues q ON j.queue_id = q.id 
       JOIN projects p ON q.project_id = p.id 
       WHERE j.id = ? AND p.organization_id = ?`,
      [id, orgId]
    );

    if (!job || job.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (job[0].status !== 'failed' && job[0].status !== 'dlq') {
      return res.status(400).json({ error: 'Only failed or DLQ jobs can be manually retried' });
    }

    await db.transaction(async (conn) => {
      // 1. Remove from DLQ if exists
      await conn.query('DELETE FROM dead_letter_queue WHERE job_id = ?', [id]);
      // 2. Put job back in queue
      await conn.query(
        `UPDATE jobs 
         SET status = 'queued', 
             retry_count = 0, 
             run_at = NOW(), 
             worker_id = NULL,
             completed_at = NULL,
             started_at = NULL,
             claimed_at = NULL
         WHERE id = ?`,
        [id]
      );
    });

    res.json({ message: 'Job scheduled for retry successfully', id });
  } catch (error) {
    console.error('Manual retry error:', error);
    res.status(500).json({ error: 'Failed to trigger manual retry' });
  }
});

// Cancel/Delete job
router.delete('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const orgId = req.user.organizationId;

  try {
    const [job] = await db.queryRaw(
      `SELECT j.id, j.status FROM jobs j 
       JOIN queues q ON j.queue_id = q.id 
       JOIN projects p ON q.project_id = p.id 
       WHERE j.id = ? AND p.organization_id = ?`,
      [id, orgId]
    );

    if (!job || job.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Delete job (cascades logs/executions)
    await db.queryRaw('DELETE FROM jobs WHERE id = ?', [id]);
    res.json({ message: 'Job deleted/cancelled successfully', id });
  } catch (error) {
    console.error('Delete job error:', error);
    res.status(500).json({ error: 'Failed to cancel job' });
  }
});

export default router;
