import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import db from '../../../shared/db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'scheduler-auth-jwt-secret-key-99882211';

// Register a new user + create user's organization
router.post('/register', async (req, res) => {
  const { email, password, orgName } = req.body;

  if (!email || !password || !orgName) {
    return res.status(400).json({ error: 'Email, password, and organization name are required' });
  }

  try {
    // Check if user exists
    const [existing] = await db.queryRaw('SELECT id FROM users WHERE email = ?', [email]);
    if (existing && existing.length > 0) {
      return res.status(409).json({ error: 'User with this email already exists' });
    }

    const userId = uuidv4();
    const orgId = uuidv4();
    const passwordHash = await bcrypt.hash(password, 10);

    // Write inside a transaction to ensure org user links are atomic
    await db.transaction(async (conn) => {
      // 1. Create Org
      await conn.query('INSERT INTO organizations (id, name) VALUES (?, ?)', [orgId, orgName]);
      // 2. Create User
      await conn.query(
        'INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)',
        [userId, email, passwordHash, 'admin']
      );
      // 3. Map user to org as owner
      await conn.query(
        'INSERT INTO organization_users (organization_id, user_id, role) VALUES (?, ?, ?)',
        [orgId, userId, 'owner']
      );
      // 4. Auto-create a Default Project for the new organization
      const projectId = uuidv4();
      await conn.query(
        'INSERT INTO projects (id, organization_id, name, description) VALUES (?, ?, ?, ?)',
        [projectId, orgId, 'Default Project', 'Primary system queues and tasks workspace']
      );
    });

    res.status(201).json({
      message: 'User and organization registered successfully',
      userId,
      orgId
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to register user: ' + error.message });
  }
});

// Login User
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const [users] = await db.queryRaw('SELECT * FROM users WHERE email = ?', [email]);
    if (!users || users.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = users[0];
    const passwordValid = await bcrypt.compare(password, user.password_hash);
    if (!passwordValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Get the user's organization
    const [orgUsers] = await db.queryRaw(
      'SELECT organization_id, role FROM organization_users WHERE user_id = ? LIMIT 1',
      [user.id]
    );

    const organizationId = orgUsers?.[0]?.organization_id || null;
    const orgRole = orgUsers?.[0]?.role || 'member';

    // Sign JWT
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: user.role,
        organizationId,
        orgRole
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        organizationId,
        orgRole
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed: ' + error.message });
  }
});

// Get current profile
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const [users] = await db.queryRaw(
      'SELECT id, email, role, created_at FROM users WHERE id = ?',
      [req.user.userId]
    );

    if (!users || users.length === 0) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    const user = users[0];

    // Fetch associated organization details
    const [orgs] = await db.queryRaw(
      `SELECT o.id, o.name, ou.role 
       FROM organizations o 
       JOIN organization_users ou ON o.id = ou.organization_id 
       WHERE ou.user_id = ?`,
      [user.id]
    );

    res.json({
      user,
      organizations: orgs
    });
  } catch (error) {
    console.error('Profile fetching error:', error);
    res.status(500).json({ error: 'Failed to fetch profile: ' + error.message });
  }
});

export default router;
