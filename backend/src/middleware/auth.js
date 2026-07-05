import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../../.env') });

const JWT_SECRET = process.env.JWT_SECRET || 'scheduler-auth-jwt-secret-key-99882211';

export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer <token>

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

/**
 * Middleware to restrict route operations by organization role
 * @param {string[]} allowedRoles - Roles allowed to perform the action
 */
export function requireOrgRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const role = req.user.orgRole; // 'owner', 'admin', 'member'
    if (!allowedRoles.includes(role)) {
      return res.status(403).json({ error: `Forbidden: Role '${role}' does not have permission to perform this action.` });
    }
    next();
  };
}
