import express from 'express';
import db from '../../../shared/db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Fetch general dashboard metrics
router.get('/overview', authenticateToken, async (req, res) => {
  const orgId = req.user.organizationId;
  try {
    // 1. Job status distribution
    const [statusDistribution] = await db.queryRaw(`
      SELECT j.status, COUNT(*) as count 
      FROM jobs j
      JOIN queues q ON j.queue_id = q.id
      JOIN projects p ON q.project_id = p.id
      WHERE p.organization_id = ?
      GROUP BY j.status
    `, [orgId]);

    const statusCounts = {
      queued: 0,
      scheduled: 0,
      claimed: 0,
      running: 0,
      completed: 0,
      failed: 0,
      dlq: 0
    };

    statusDistribution.forEach(row => {
      if (statusCounts.hasOwnProperty(row.status)) {
        statusCounts[row.status] = parseInt(row.count);
      }
    });

    // 2. Average job execution time by queue
    const [executionSpeeds] = await db.queryRaw(`
      SELECT q.name as queue_name, ROUND(AVG(je.duration_ms), 0) as avg_duration_ms
      FROM job_executions je
      JOIN jobs j ON je.job_id = j.id
      JOIN queues q ON j.queue_id = q.id
      JOIN projects p ON q.project_id = p.id
      WHERE p.organization_id = ? AND je.status = 'completed'
      GROUP BY q.id
    `, [orgId]);

    // Prune offline workers whose heartbeats are older than 3 minutes to keep the registry clean
    await db.queryRaw(`
      DELETE FROM workers 
      WHERE last_heartbeat_at < DATE_SUB(NOW(), INTERVAL 3 MINUTE)
    `);

    // 3. Worker list and heartbeats
    const [workers] = await db.queryRaw(`
      SELECT w.*,
        (SELECT COUNT(*) FROM jobs WHERE worker_id = w.id AND status = 'running') as current_load
      FROM workers w
      ORDER BY w.last_heartbeat_at DESC
    `);

    // Add virtual state flag to workers: 'live', 'stale', 'dead'
    const enrichedWorkers = workers.map(worker => {
      const now = new Date();
      const heartbeat = new Date(worker.last_heartbeat_at);
      const diffSeconds = (now - heartbeat) / 1000;

      let virtualStatus = 'active';
      if (diffSeconds > 15 && diffSeconds <= 45) {
        virtualStatus = 'stale';
      } else if (diffSeconds > 45 || worker.status === 'inactive') {
        virtualStatus = 'offline';
      }

      return {
        ...worker,
        virtualStatus
      };
    });

    // 4. Executions Timeline (Completed vs Failed over last 24h, grouped by hour)
    const [timeline] = await db.queryRaw(`
      SELECT 
        DATE_FORMAT(finished_at, '%Y-%m-%d %H:00:00') as hour_bucket,
        SUM(CASE WHEN je.status = 'completed' THEN 1 ELSE 0 END) as completed_count,
        SUM(CASE WHEN je.status = 'failed' THEN 1 ELSE 0 END) as failed_count
      FROM job_executions je
      JOIN jobs j ON je.job_id = j.id
      JOIN queues q ON j.queue_id = q.id
      JOIN projects p ON q.project_id = p.id
      WHERE p.organization_id = ?
        AND finished_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      GROUP BY hour_bucket
      ORDER BY hour_bucket ASC
    `, [orgId]);

    res.json({
      statusCounts,
      executionSpeeds,
      workers: enrichedWorkers,
      timeline
    });
  } catch (error) {
    console.error('Fetch overview metrics error:', error);
    res.status(500).json({ error: 'Failed to fetch overview metrics' });
  }
});

// Fetch system logs list for live monitoring
router.get('/logs', authenticateToken, async (req, res) => {
  const orgId = req.user.organizationId;
  const { limit = 50 } = req.query;

  try {
    const [logs] = await db.queryRaw(`
      SELECT jl.*, j.name as job_name
      FROM job_logs jl
      JOIN jobs j ON jl.job_id = j.id
      JOIN queues q ON j.queue_id = q.id
      JOIN projects p ON q.project_id = p.id
      WHERE p.organization_id = ?
      ORDER BY jl.created_at DESC
      LIMIT ?
    `, [orgId, parseInt(limit)]);

    res.json(logs);
  } catch (error) {
    console.error('Fetch system logs error:', error);
    res.status(500).json({ error: 'Failed to fetch system logs' });
  }
});

export default router;
