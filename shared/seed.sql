-- Database seed data for Distributed Job Scheduler

-- 1. Insert Organization
INSERT INTO organizations (id, name) VALUES 
('org-1111-1111-1111-111111111111', 'Acme Corp');

-- 2. Insert User (Email: admin@acme.com, Password: adminpassword)
-- bcrypt hash for 'adminpassword': $2a$10$r8tZeqv3JcK8N9h29qV7oOqj5h0XvE7ZqQ5Gv3M/m.vXFhXJvTKeG
INSERT INTO users (id, email, password_hash, role) VALUES 
('usr-2222-2222-2222-222222222222', 'admin@acme.com', '$2a$10$r8tZeqv3JcK8N9h29qV7oOqj5h0XvE7ZqQ5Gv3M/m.vXFhXJvTKeG', 'admin');

-- 3. Map User to Org
INSERT INTO organization_users (organization_id, user_id, role) VALUES 
('org-1111-1111-1111-111111111111', 'usr-2222-2222-2222-222222222222', 'owner');

-- 4. Insert Project
INSERT INTO projects (id, organization_id, name, description) VALUES 
('prj-3333-3333-3333-333333333333', 'org-1111-1111-1111-111111111111', 'Production Schedulers', 'Core background queues and workflows for manufacturing automation.');

-- 5. Insert Retry Policies
INSERT INTO retry_policies (id, name, type, base_delay_seconds, max_delay_seconds, max_retries) VALUES 
('rp-fixed-000000000000', 'Fixed Delay (5s)', 'fixed', 5, 5, 3),
('rp-linear-00000000000', 'Linear Backoff', 'linear', 5, 60, 4),
('rp-exponential-00000', 'Exponential Backoff', 'exponential', 2, 300, 5);

-- 6. Insert Queues
INSERT INTO queues (id, project_id, name, priority, concurrency_limit, retry_policy_id, is_paused) VALUES 
('q-critical-0000000000', 'prj-3333-3333-3333-333333333333', 'critical-tasks', 100, 2, 'rp-fixed-000000000000', FALSE),
('q-default-00000000000', 'prj-3333-3333-3333-333333333333', 'default-tasks', 10, 5, 'rp-linear-00000000000', FALSE),
('q-low-priority-00000', 'prj-3333-3333-3333-333333333333', 'low-priority-reports', 1, 10, 'rp-exponential-00000', FALSE);

-- 7. Insert Jobs
-- Immediate Job
INSERT INTO jobs (id, queue_id, name, payload, status, run_at, max_retries, retry_policy_id) VALUES 
('job-imm-1111-1111-1111', 'q-default-00000000000', 'Process Invoice #1024', '{"invoiceId": 1024, "amount": 250.75, "customer": "Globex Corp"}', 'queued', NOW(), 3, 'rp-linear-00000000000');

-- Delayed Job (run in 1 hour)
INSERT INTO jobs (id, queue_id, name, payload, status, run_at, max_retries, retry_policy_id) VALUES 
('job-del-2222-2222-2222', 'q-default-00000000000', 'Send Welcome Email', '{"email": "user@globex.com", "name": "John Doe"}', 'scheduled', DATE_ADD(NOW(), INTERVAL 1 HOUR), 3, 'rp-linear-00000000000');

-- Recurring Cron Job (runs every 5 minutes - simulated)
INSERT INTO jobs (id, queue_id, name, payload, status, run_at, recurring_cron, max_retries, retry_policy_id) VALUES 
('job-cro-3333-3333-3333', 'q-low-priority-00000', 'Database Backup Daemon', '{"s3_bucket": "acme-backups", "database": "prod_users"}', 'scheduled', NOW(), '*/5 * * * *', 5, 'rp-exponential-00000');

-- Failed Job that went to Dead Letter Queue (DLQ)
INSERT INTO jobs (id, queue_id, name, payload, status, max_retries, retry_count, retry_policy_id) VALUES 
('job-fai-4444-4444-4444', 'q-critical-0000000000', 'Payment Gateway Sync', '{"transactionId": "tx_999923", "gateway": "Stripe"}', 'dlq', 3, 3, 'rp-fixed-000000000000');

INSERT INTO dead_letter_queue (id, job_id, queue_id, original_payload, failure_reason) VALUES 
('dlq-entry-4444-4444-44', 'job-fai-4444-4444-4444', 'q-critical-0000000000', '{"transactionId": "tx_999923", "gateway": "Stripe"}', 'Stripe API Authentication Failed: Invalid API key provided. Max retries (3) reached.');

-- Job Workflow DAG (Workflow Demo: Job A -> Job B)
-- Job A (Run first)
INSERT INTO jobs (id, queue_id, name, payload, status, run_at) VALUES 
('job-dag-a-1111-111111', 'q-default-00000000000', 'Render Video Frames', '{"videoId": "v_772", "resolution": "1080p", "range": "1-100"}', 'queued', NOW());

-- Job B (Wait for Job A)
INSERT INTO jobs (id, queue_id, name, payload, status, run_at) VALUES 
('job-dag-b-2222-222222', 'q-default-00000000000', 'Encode Video File', '{"videoId": "v_772", "codec": "h264"}', 'scheduled', NOW());

-- Dependency Mapping: Job B depends on Job A
INSERT INTO job_dependencies (parent_job_id, child_job_id) VALUES 
('job-dag-a-1111-111111', 'job-dag-b-2222-222222');
