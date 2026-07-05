-- Schema creation script for Distributed Job Scheduler (MySQL 8.0)

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS job_logs;
DROP TABLE IF EXISTS job_executions;
DROP TABLE IF EXISTS workers;
DROP TABLE IF EXISTS dead_letter_queue;
DROP TABLE IF EXISTS job_dependencies;
DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS queues;
DROP TABLE IF EXISTS retry_policies;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS organization_users;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS organizations;

SET FOREIGN_KEY_CHECKS = 1;

-- 1. Organizations
CREATE TABLE organizations (
  id VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Users
CREATE TABLE users (
  id VARCHAR(36) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Organization Users Mapping
CREATE TABLE organization_users (
  organization_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  role VARCHAR(50) DEFAULT 'member',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, user_id),
  CONSTRAINT fk_org_users_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_org_users_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Projects
CREATE TABLE projects (
  id VARCHAR(36) NOT NULL,
  organization_id VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_projects_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Retry Policies
CREATE TABLE retry_policies (
  id VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL, -- 'fixed', 'linear', 'exponential'
  base_delay_seconds INT NOT NULL DEFAULT 5,
  max_delay_seconds INT NOT NULL DEFAULT 300,
  max_retries INT NOT NULL DEFAULT 3,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Queues
CREATE TABLE queues (
  id VARCHAR(36) NOT NULL,
  project_id VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  priority INT NOT NULL DEFAULT 0, -- Higher means higher priority execution
  concurrency_limit INT NOT NULL DEFAULT 5,
  retry_policy_id VARCHAR(36) DEFAULT NULL,
  is_paused BOOLEAN NOT NULL DEFAULT FALSE,
  rate_limit_per_min INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_project_queue (project_id, name),
  CONSTRAINT fk_queues_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
  CONSTRAINT fk_queues_retry_policy FOREIGN KEY (retry_policy_id) REFERENCES retry_policies (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. Jobs
CREATE TABLE jobs (
  id VARCHAR(36) NOT NULL,
  queue_id VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  payload JSON DEFAULT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'queued', -- 'queued', 'scheduled', 'claimed', 'running', 'completed', 'failed', 'dlq'
  run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- Execution timestamp for delayed/scheduled jobs
  recurring_cron VARCHAR(255) DEFAULT NULL,
  batch_id VARCHAR(36) DEFAULT NULL,
  retry_count INT NOT NULL DEFAULT 0,
  max_retries INT NOT NULL DEFAULT 3,
  retry_policy_id VARCHAR(36) DEFAULT NULL,
  worker_id VARCHAR(36) DEFAULT NULL,
  claimed_at TIMESTAMP NULL DEFAULT NULL,
  started_at TIMESTAMP NULL DEFAULT NULL,
  completed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_jobs_queue FOREIGN KEY (queue_id) REFERENCES queues (id) ON DELETE CASCADE,
  CONSTRAINT fk_jobs_retry_policy FOREIGN KEY (retry_policy_id) REFERENCES retry_policies (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Indexing for jobs polling & search
CREATE INDEX idx_jobs_status_run_at ON jobs (status, run_at);
CREATE INDEX idx_jobs_queue_status ON jobs (queue_id, status);
CREATE INDEX idx_jobs_batch_id ON jobs (batch_id);

-- 8. Job Dependencies (for DAG Workflow management)
CREATE TABLE job_dependencies (
  parent_job_id VARCHAR(36) NOT NULL,
  child_job_id VARCHAR(36) NOT NULL,
  PRIMARY KEY (parent_job_id, child_job_id),
  CONSTRAINT fk_dependencies_parent FOREIGN KEY (parent_job_id) REFERENCES jobs (id) ON DELETE CASCADE,
  CONSTRAINT fk_dependencies_child FOREIGN KEY (child_job_id) REFERENCES jobs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Indexing for dependency checks
CREATE INDEX idx_dependencies_child ON job_dependencies (child_job_id);

-- 9. Dead Letter Queue
CREATE TABLE dead_letter_queue (
  id VARCHAR(36) NOT NULL,
  job_id VARCHAR(36) NOT NULL,
  queue_id VARCHAR(36) NOT NULL,
  original_payload JSON DEFAULT NULL,
  failure_reason TEXT NOT NULL,
  failed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_dlq_job FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE,
  CONSTRAINT fk_dlq_queue FOREIGN KEY (queue_id) REFERENCES queues (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 10. Active Workers
CREATE TABLE workers (
  id VARCHAR(36) NOT NULL,
  hostname VARCHAR(255) NOT NULL,
  concurrency_limit INT NOT NULL DEFAULT 5,
  status VARCHAR(50) NOT NULL DEFAULT 'active', -- 'active', 'inactive'
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_heartbeat_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 11. Job Executions (History of runs and retries)
CREATE TABLE job_executions (
  id VARCHAR(36) NOT NULL,
  job_id VARCHAR(36) NOT NULL,
  worker_id VARCHAR(36) DEFAULT NULL,
  status VARCHAR(50) NOT NULL, -- 'running', 'completed', 'failed'
  error_message TEXT DEFAULT NULL,
  ai_summary TEXT DEFAULT NULL,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP NULL DEFAULT NULL,
  duration_ms INT DEFAULT NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_executions_job FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_executions_job_id ON job_executions (job_id);

-- 12. Detailed Execution Logs
CREATE TABLE job_logs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  job_id VARCHAR(36) NOT NULL,
  execution_id VARCHAR(36) NOT NULL,
  level VARCHAR(50) NOT NULL DEFAULT 'info', -- 'info', 'warn', 'error', 'debug'
  message TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_logs_job FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE,
  CONSTRAINT fk_logs_execution FOREIGN KEY (execution_id) REFERENCES job_executions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_logs_execution ON job_logs (execution_id);
