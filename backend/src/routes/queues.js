import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../../../shared/db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Helper: check if queue belongs to project/organization
async function checkProjectAccess(projectId, orgId) {
  const [project] = await db.queryRaw(
    'SELECT id FROM projects WHERE id = ? AND organization_id = ?',
    [projectId, orgId]
  );
  return project && project.length > 0;
}

// List all queues under user's projects
router.get('/', authenticateToken, async (req, res) => {
  const orgId = req.user.organizationId;
  try {
    const query = `
      SELECT q.*, p.name as project_name, rp.name as retry_policy_name
      FROM queues q
      JOIN projects p ON q.project_id = p.id
      LEFT JOIN retry_policies rp ON q.retry_policy_id = rp.id
      WHERE p.organization_id = ?
      ORDER BY q.priority DESC, q.name ASC
    `;
    const [queues] = await db.queryRaw(query, [orgId]);
    res.json(queues);
  } catch (error) {
    console.error('Fetch queues error:', error);
    res.status(500).json({ error: 'Failed to fetch queues: ' + error.message });
  }
});

// List projects
router.get('/projects', authenticateToken, async (req, res) => {
  const orgId = req.user.organizationId;
  try {
    const [projects] = await db.queryRaw(
      'SELECT id, name, description FROM projects WHERE organization_id = ?',
      [orgId]
    );
    res.json(projects);
  } catch (error) {
    console.error('Fetch projects error:', error);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// List retry policies
router.get('/retry-policies', authenticateToken, async (req, res) => {
  try {
    const [policies] = await db.queryRaw('SELECT * FROM retry_policies');
    res.json(policies);
  } catch (error) {
    console.error('Fetch policies error:', error);
    res.status(500).json({ error: 'Failed to fetch retry policies' });
  }
});

// Create new queue
router.post('/', authenticateToken, async (req, res) => {
  const { project_id, name, priority, concurrency_limit, retry_policy_id, rate_limit_per_min } = req.body;
  const orgId = req.user.organizationId;

  if (!project_id || !name) {
    return res.status(400).json({ error: 'project_id and name are required' });
  }

  try {
    const hasAccess = await checkProjectAccess(project_id, orgId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Unauthorized project context' });
    }

    // Check name collision within the project
    const [exists] = await db.queryRaw(
      'SELECT id FROM queues WHERE project_id = ? AND name = ?',
      [project_id, name]
    );
    if (exists && exists.length > 0) {
      return res.status(409).json({ error: 'Queue with this name already exists in the project' });
    }

    const id = uuidv4();
    await db.queryRaw(
      `INSERT INTO queues (id, project_id, name, priority, concurrency_limit, retry_policy_id, rate_limit_per_min)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        project_id,
        name,
        priority !== undefined ? priority : 0,
        concurrency_limit !== undefined ? concurrency_limit : 5,
        retry_policy_id || null,
        rate_limit_per_min || null
      ]
    );

    const [newQueue] = await db.queryRaw('SELECT * FROM queues WHERE id = ?', [id]);
    res.status(201).json(newQueue[0]);
  } catch (error) {
    console.error('Create queue error:', error);
    res.status(500).json({ error: 'Failed to create queue: ' + error.message });
  }
});

// Update queue settings
router.put('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { priority, concurrency_limit, retry_policy_id, is_paused, rate_limit_per_min } = req.body;
  const orgId = req.user.organizationId;

  try {
    // Verify access
    const [queue] = await db.queryRaw(
      `SELECT q.id, q.project_id FROM queues q 
       JOIN projects p ON q.project_id = p.id 
       WHERE q.id = ? AND p.organization_id = ?`,
      [id, orgId]
    );

    if (!queue || queue.length === 0) {
      return res.status(404).json({ error: 'Queue not found or unauthorized' });
    }

    await db.queryRaw(
      `UPDATE queues 
       SET priority = COALESCE(?, priority),
           concurrency_limit = COALESCE(?, concurrency_limit),
           retry_policy_id = ?,
           is_paused = COALESCE(?, is_paused),
           rate_limit_per_min = ?
       WHERE id = ?`,
      [priority, concurrency_limit, retry_policy_id || null, is_paused, rate_limit_per_min || null, id]
    );

    const [updatedQueue] = await db.queryRaw('SELECT * FROM queues WHERE id = ?', [id]);
    res.json(updatedQueue[0]);
  } catch (error) {
    console.error('Update queue error:', error);
    res.status(500).json({ error: 'Failed to update queue: ' + error.message });
  }
});

// Pause queue
router.post('/:id/pause', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const orgId = req.user.organizationId;
  try {
    const [queue] = await db.queryRaw(
      `SELECT q.id FROM queues q 
       JOIN projects p ON q.project_id = p.id 
       WHERE q.id = ? AND p.organization_id = ?`,
      [id, orgId]
    );

    if (!queue || queue.length === 0) {
      return res.status(404).json({ error: 'Queue not found' });
    }

    await db.queryRaw('UPDATE queues SET is_paused = TRUE WHERE id = ?', [id]);
    res.json({ message: 'Queue paused successfully', id });
  } catch (error) {
    console.error('Pause queue error:', error);
    res.status(500).json({ error: 'Failed to pause queue' });
  }
});

// Resume queue
router.post('/:id/resume', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const orgId = req.user.organizationId;
  try {
    const [queue] = await db.queryRaw(
      `SELECT q.id FROM queues q 
       JOIN projects p ON q.project_id = p.id 
       WHERE q.id = ? AND p.organization_id = ?`,
      [id, orgId]
    );

    if (!queue || queue.length === 0) {
      return res.status(404).json({ error: 'Queue not found' });
    }

    await db.queryRaw('UPDATE queues SET is_paused = FALSE WHERE id = ?', [id]);
    res.json({ message: 'Queue resumed successfully', id });
  } catch (error) {
    console.error('Resume queue error:', error);
    res.status(500).json({ error: 'Failed to resume queue' });
  }
});

// Get queue specific stats
router.get('/:id/stats', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const orgId = req.user.organizationId;

  try {
    const [queue] = await db.queryRaw(
      `SELECT q.id FROM queues q 
       JOIN projects p ON q.project_id = p.id 
       WHERE q.id = ? AND p.organization_id = ?`,
      [id, orgId]
    );

    if (!queue || queue.length === 0) {
      return res.status(404).json({ error: 'Queue not found' });
    }

    // Get count per status
    const [counts] = await db.queryRaw(
      `SELECT status, COUNT(*) as count 
       FROM jobs 
       WHERE queue_id = ? 
       GROUP BY status`,
      [id]
    );

    const countsMap = {
      queued: 0,
      scheduled: 0,
      claimed: 0,
      running: 0,
      completed: 0,
      failed: 0,
      dlq: 0
    };

    counts.forEach(row => {
      if (countsMap.hasOwnProperty(row.status)) {
        countsMap[row.status] = row.count;
      }
    });

    res.json({ queueId: id, stats: countsMap });
  } catch (error) {
    console.error('Queue stats fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch queue stats' });
  }
});

// Delete queue
router.delete('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const orgId = req.user.organizationId;
  try {
    const [queue] = await db.queryRaw(
      `SELECT q.id FROM queues q 
       JOIN projects p ON q.project_id = p.id 
       WHERE q.id = ? AND p.organization_id = ?`,
      [id, orgId]
    );

    if (!queue || queue.length === 0) {
      return res.status(404).json({ error: 'Queue not found' });
    }

    await db.queryRaw('DELETE FROM queues WHERE id = ?', [id]);
    res.json({ message: 'Queue deleted successfully', id });
  } catch (error) {
    console.error('Delete queue error:', error);
    res.status(500).json({ error: 'Failed to delete queue' });
  }
});

export default router;
