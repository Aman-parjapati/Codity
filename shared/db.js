import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env from root
dotenv.config({ path: path.join(__dirname, '../.env') });

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'jobs_user',
  password: process.env.DB_PASSWORD || 'jobs_password',
  database: process.env.DB_DATABASE || 'jobs_db',
  waitForConnections: true,
  connectionLimit: 15,
  queueLimit: 0,
  multipleStatements: true // critical for running migrations and batch queries
});

export const db = {
  /**
   * Execute query
   */
  async query(sql, params) {
    return await pool.execute(sql, params);
  },

  /**
   * Execute raw query (supports multiple statements)
   */
  async queryRaw(sql, params) {
    return await pool.query(sql, params);
  },

  /**
   * Get connection from pool
   */
  async getConnection() {
    return await pool.getConnection();
  },

  /**
   * Transaction execution wrapper
   * @param {function(connection): Promise<any>} callback 
   */
  async transaction(callback) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await callback(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  /**
   * Close connection pool
   */
  async close() {
    await pool.end();
  }
};
export default db;
