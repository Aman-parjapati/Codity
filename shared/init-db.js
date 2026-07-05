import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const schemaPath = path.join(__dirname, 'schema.sql');
const seedPath = path.join(__dirname, 'seed.sql');

async function waitAndConnect(retries = 3, delay = 2000) {
  const host = process.env.DB_HOST || 'localhost';
  const port = parseInt(process.env.DB_PORT || '3306');
  const user = process.env.DB_USER || 'root';
  const password = process.env.DB_PASSWORD || '12345';

  console.log(`Connecting to MySQL on ${host}:${port} as ${user}...`);

  for (let i = 0; i < retries; i++) {
    try {
      const conn = await mysql.createConnection({
        host,
        port,
        user,
        password,
        multipleStatements: true
      });
      console.log('Successfully connected to MySQL database engine.');
      return conn;
    } catch (err) {
      console.log(`Connection attempt ${i + 1}/${retries} failed. (${err.message})`);
      if (i < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw new Error('Could not connect to MySQL server.');
}

async function run() {
  let conn;
  try {
    conn = await waitAndConnect();

    // 1. Create database if it does not exist
    const dbName = process.env.DB_DATABASE || 'jobs_db';
    console.log(`Creating database "${dbName}" if not exists...`);
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\`;`);

    // Switch to database
    await conn.changeUser({ database: dbName });

    // 3. Read & run schema.sql
    console.log('Applying database schema from schema.sql...');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await conn.query(schemaSql);
    console.log('Schema applied successfully.');

    // 4. Read & run seed.sql
    console.log('Applying seed data from seed.sql...');
    const seedSql = fs.readFileSync(seedPath, 'utf8');
    await conn.query(seedSql);
    console.log('Seed data seeded successfully.');

    console.log('Database initialization complete!');
  } catch (error) {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  } finally {
    if (conn) {
      await conn.end();
    }
  }
}

run();
