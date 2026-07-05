import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../../shared/db.js';

// Routes
import authRouter from './routes/auth.js';
import queuesRouter from './routes/queues.js';
import jobsRouter from './routes/jobs.js';
import metricsRouter from './routes/metrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../../.env') });

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());

// Log incoming requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Mount Routes
app.use('/api/auth', authRouter);
app.use('/api/queues', queuesRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/metrics', metricsRouter);

// Basic health check route
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date() });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

// WebSocket Clients Registry
const clients = new Set();

wss.on('connection', (ws) => {
  console.log('Dashboard WebSocket client connected.');
  clients.add(ws);

  // Send initial data immediately
  sendSystemStats(ws);

  ws.on('close', () => {
    console.log('Dashboard WebSocket client disconnected.');
    clients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket client error:', error);
    clients.delete(ws);
  });
});

// Broadcast helper function to notify all dashboard clients
export function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// Function to fetch system metrics and push them to a single ws client
async function sendSystemStats(ws) {
  try {
    const stats = await getAggregatedStats();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'metrics_update', data: stats }));
    }
  } catch (error) {
    console.error('Error fetching stats for WebSocket client:', error);
  }
}

// Function to compute current aggregated scheduler stats
async function getAggregatedStats() {
  const [jobCounts] = await db.queryRaw(`
    SELECT status, COUNT(*) as count 
    FROM jobs 
    GROUP BY status
  `);

  const [queueCounts] = await db.queryRaw(`
    SELECT COUNT(*) as count FROM queues
  `);

  const [activeWorkers] = await db.queryRaw(`
    SELECT COUNT(*) as count 
    FROM workers 
    WHERE status = 'active' AND last_heartbeat_at >= DATE_SUB(NOW(), INTERVAL 30 SECOND)
  `);

  // Calculate recent throughput (completed jobs in the last 5 minutes)
  const [throughput] = await db.queryRaw(`
    SELECT COUNT(*) as count 
    FROM jobs 
    WHERE status = 'completed' AND completed_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
  `);

  const countsMap = {
    queued: 0,
    scheduled: 0,
    claimed: 0,
    running: 0,
    completed: 0,
    failed: 0,
    dlq: 0
  };

  jobCounts.forEach(row => {
    if (countsMap.hasOwnProperty(row.status)) {
      countsMap[row.status] = row.count;
    }
  });

  return {
    jobStates: countsMap,
    queuesCount: queueCounts[0]?.count || 0,
    activeWorkers: activeWorkers[0]?.count || 0,
    throughputPerFiveMin: throughput[0]?.count || 0,
    timestamp: new Date()
  };
}

// Start broadcast loop every 2 seconds to keep live metrics sync'd
setInterval(async () => {
  if (clients.size > 0) {
    try {
      const stats = await getAggregatedStats();
      broadcast({ type: 'metrics_update', data: stats });
    } catch (error) {
      console.error('WebSocket broadcast loop error:', error);
    }
  }
}, 2000);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Backend API Server running on port ${PORT}`);
  console.log(`WebSocket server linked to Express HTTP Server`);
});
