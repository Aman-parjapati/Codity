import React, { useState, useEffect, useRef } from 'react';
import { 
  Activity, 
  Layers, 
  Play, 
  Pause, 
  Plus, 
  RefreshCw, 
  Trash2, 
  Cpu, 
  Search, 
  X, 
  FileText, 
  AlertTriangle, 
  CheckCircle, 
  Clock, 
  Sparkles,
  Link2,
  Calendar,
  LogOut,
  Folder
} from 'lucide-react';

export default function App() {
  // Auth state
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [user, setUser] = useState(JSON.parse(localStorage.getItem('user')) || null);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authOrgName, setAuthOrgName] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [authError, setAuthError] = useState('');

  // App tabs: 'dashboard', 'queues', 'jobs', 'workers'
  const [activeTab, setActiveTab] = useState('dashboard');

  // Live system metrics (driven by WebSocket and HTTP polling)
  const [metrics, setMetrics] = useState({
    jobStates: { queued: 0, scheduled: 0, claimed: 0, running: 0, completed: 0, failed: 0, dlq: 0 },
    queuesCount: 0,
    activeWorkers: 0,
    throughputPerFiveMin: 0,
    timeline: []
  });

  // App data list states
  const [queues, setQueues] = useState([]);
  const [projects, setProjects] = useState([]);
  const [retryPolicies, setRetryPolicies] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [systemLogs, setSystemLogs] = useState([]);

  // Filter and search states
  const [jobsFilterStatus, setJobsFilterStatus] = useState('');
  const [jobsFilterQueue, setJobsFilterQueue] = useState('');
  const [jobsSearch, setJobsSearch] = useState('');
  const [jobsPage, setJobsPage] = useState(0);
  const [jobsTotalCount, setJobsTotalCount] = useState(0);

  // Selected job details modal state
  const [selectedJobId, setSelectedJobId] = useState(null);
  const [selectedJobDetail, setSelectedJobDetail] = useState(null);
  
  // Modals state
  const [showCreateQueueModal, setShowCreateQueueModal] = useState(false);
  const [showCreateJobModal, setShowCreateJobModal] = useState(false);
  const [showEditQueueModal, setShowEditQueueModal] = useState(false);

  // Forms state
  const [newQueueName, setNewQueueName] = useState('');
  const [newQueuePriority, setNewQueuePriority] = useState(10);
  const [newQueueConcurrency, setNewQueueConcurrency] = useState(5);
  const [newQueuePolicy, setNewQueuePolicy] = useState('');
  const [newQueueProjectId, setNewQueueProjectId] = useState('');

  const [editingQueue, setEditingQueue] = useState(null);
  const [editQueuePriority, setEditQueuePriority] = useState(10);
  const [editQueueConcurrency, setEditQueueConcurrency] = useState(5);
  const [editQueuePolicy, setEditQueuePolicy] = useState('');

  const [newJobName, setNewJobName] = useState('');
  const [newJobQueueId, setNewJobQueueId] = useState('');
  const [newJobPayload, setNewJobPayload] = useState('{\n  "durationMs": 1500\n}');
  const [newJobType, setNewJobType] = useState('immediate'); // 'immediate', 'delayed', 'cron'
  const [newJobDelayMin, setNewJobDelayMin] = useState(5);
  const [newJobCron, setNewJobCron] = useState('*/1 * * * *');
  const [newJobMaxRetries, setNewJobMaxRetries] = useState(3);
  const [newJobPolicyId, setNewJobPolicyId] = useState('');
  const [newJobDependencies, setNewJobDependencies] = useState(''); // comma-separated job IDs

  const [wsConnected, setWsConnected] = useState(false);

  const wsRef = useRef(null);

  // Effect: Auth verification and initial data loading
  useEffect(() => {
    if (!token) return;

    fetchProjects();
    fetchRetryPolicies();
    fetchQueues();
    fetchJobs();
    fetchWorkersAndMetrics();
    fetchSystemLogs();

    // 1. Establish WebSocket Connection for live metrics updates
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    console.log(`Connecting WebSocket to ${wsUrl}`);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connection opened successfully.');
      setWsConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'metrics_update') {
          setMetrics(prev => ({
            ...prev,
            ...payload.data
          }));
        }
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket encountered an error:', err);
      setWsConnected(false);
    };

    ws.onclose = () => {
      console.log('WebSocket closed. Reconnecting fallback will poll API.');
      setWsConnected(false);
    };

    // 2. HTTP Polling Fallback every 4 seconds for logs/active entities
    const pollInterval = setInterval(() => {
      fetchQueues();
      fetchJobs();
      fetchWorkersAndMetrics();
      fetchSystemLogs();
    }, 4000);

    return () => {
      clearInterval(pollInterval);
      if (wsRef.current) wsRef.current.close();
    };
  }, [token, jobsFilterStatus, jobsFilterQueue, jobsSearch, jobsPage]);

  // Load selected job details when ID is set
  useEffect(() => {
    if (selectedJobId) {
      fetchJobDetails(selectedJobId);
    }
  }, [selectedJobId]);

  // Auth Operations
  const handleLogin = async (e) => {
    e.preventDefault();
    setAuthError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: authEmail, password: authPassword })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      setToken(data.token);
      setUser(data.user);
    } catch (err) {
      setAuthError(err.message);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setAuthError('');
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: authEmail, password: authPassword, orgName: authOrgName })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed');
      
      setIsRegistering(false);
      setAuthError('Registration successful! Please login.');
    } catch (err) {
      setAuthError(err.message);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setToken('');
    setUser(null);
    if (wsRef.current) wsRef.current.close();
  };

  // API Call wrappers
  const getHeaders = () => ({
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  });

  const fetch = async (url, options = {}) => {
    const res = await window.fetch(url, {
      ...options,
      headers: {
        ...getHeaders(),
        ...options.headers
      }
    });
    if (res.status === 401 || res.status === 403) {
      handleLogout();
    }
    return res;
  };

  const fetchQueues = async () => {
    try {
      const res = await fetch('/api/queues', { headers: getHeaders() });
      if (res.ok) {
        const data = await res.json();
        setQueues(data);
        if (data.length > 0 && !newJobQueueId) {
          setNewJobQueueId(data[0].id);
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  const fetchProjects = async () => {
    try {
      const res = await fetch('/api/queues/projects', { headers: getHeaders() });
      if (res.ok) {
        const data = await res.json();
        setProjects(data);
        if (data.length > 0) {
          setNewQueueProjectId(data[0].id);
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  const fetchRetryPolicies = async () => {
    try {
      const res = await fetch('/api/queues/retry-policies', { headers: getHeaders() });
      if (res.ok) {
        const data = await res.json();
        setRetryPolicies(data);
        if (data.length > 0 && !newQueuePolicyId) {
          const linear = data.find(p => p.type === 'linear');
          setNewQueuePolicyId(linear ? linear.id : data[0].id);
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  const fetchJobs = async () => {
    try {
      let url = `/api/jobs?limit=15&offset=${jobsPage * 15}`;
      if (jobsFilterStatus) url += `&status=${jobsFilterStatus}`;
      if (jobsFilterQueue) url += `&queue_id=${jobsFilterQueue}`;
      if (jobsSearch) url += `&search=${encodeURIComponent(jobsSearch)}`;

      const res = await fetch(url, { headers: getHeaders() });
      if (res.ok) {
        const data = await res.json();
        setJobs(data.jobs);
        setJobsTotalCount(data.total);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const fetchWorkersAndMetrics = async () => {
    try {
      const res = await fetch('/api/metrics/overview', { headers: getHeaders() });
      if (res.ok) {
        const data = await res.json();
        setWorkers(data.workers);
        if (!wsConnected) {
          // Fallback sync metrics from API if WebSocket is offline
          setMetrics({
            jobStates: data.statusCounts,
            queuesCount: queues.length,
            activeWorkers: data.workers.filter(w => w.virtualStatus === 'active').length,
            throughputPerFiveMin: metrics.throughputPerFiveMin, // keep current or mock
            timeline: data.timeline || []
          });
        } else {
          setMetrics(prev => ({
            ...prev,
            timeline: data.timeline || []
          }));
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  const fetchSystemLogs = async () => {
    try {
      const res = await fetch('/api/metrics/logs?limit=40', { headers: getHeaders() });
      if (res.ok) {
        const data = await res.json();
        setSystemLogs(data);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const fetchJobDetails = async (jobId) => {
    try {
      const res = await fetch(`/api/jobs/${jobId}`, { headers: getHeaders() });
      if (res.ok) {
        const data = await res.json();
        setSelectedJobDetail(data);
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Queue Operations
  const handleCreateQueue = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/queues', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          project_id: newQueueProjectId,
          name: newQueueName,
          priority: parseInt(newQueuePriority),
          concurrency_limit: parseInt(newQueueConcurrency),
          retry_policy_id: newQueuePolicy || null
        })
      });
      if (res.ok) {
        setShowCreateQueueModal(false);
        setNewQueueName('');
        fetchQueues();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to create queue');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handlePauseQueue = async (queueId) => {
    try {
      const res = await fetch(`/api/queues/${queueId}/pause`, {
        method: 'POST',
        headers: getHeaders()
      });
      if (res.ok) fetchQueues();
    } catch (err) {
      console.error(err);
    }
  };

  const handleResumeQueue = async (queueId) => {
    try {
      const res = await fetch(`/api/queues/${queueId}/resume`, {
        method: 'POST',
        headers: getHeaders()
      });
      if (res.ok) fetchQueues();
    } catch (err) {
      console.error(err);
    }
  };

  const handleOpenEditQueue = (queue) => {
    setEditingQueue(queue);
    setEditQueuePriority(queue.priority);
    setEditQueueConcurrency(queue.concurrency_limit);
    setEditQueuePolicy(queue.retry_policy_id || '');
    setShowEditQueueModal(true);
  };

  const handleUpdateQueue = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`/api/queues/${editingQueue.id}`, {
        method: 'PUT',
        headers: getHeaders(),
        body: JSON.stringify({
          priority: parseInt(editQueuePriority),
          concurrency_limit: parseInt(editQueueConcurrency),
          retry_policy_id: editQueuePolicy || null
        })
      });
      if (res.ok) {
        setShowEditQueueModal(false);
        fetchQueues();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeleteQueue = async (queueId) => {
    if (!confirm('Are you sure you want to delete this queue? All jobs within it will be deleted.')) return;
    try {
      const res = await fetch(`/api/queues/${queueId}`, {
        method: 'DELETE',
        headers: getHeaders()
      });
      if (res.ok) fetchQueues();
    } catch (err) {
      console.error(err);
    }
  };

  // Job Operations
  const handleCreateJob = async (e) => {
    e.preventDefault();
    try {
      let payloadObj = null;
      try {
        if (newJobPayload) payloadObj = JSON.parse(newJobPayload);
      } catch (err) {
        alert('Invalid JSON in payload field');
        return;
      }

      let runAt = null;
      if (newJobType === 'delayed') {
        runAt = new Date(Date.now() + newJobDelayMin * 60000).toISOString();
      }

      // Convert dependencies string to array
      const dependenciesArray = newJobDependencies
        ? newJobDependencies.split(',').map(id => id.trim()).filter(id => id.length > 0)
        : [];

      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          queue_id: newJobQueueId,
          name: newJobName,
          payload: payloadObj,
          run_at: runAt,
          recurring_cron: newJobType === 'cron' ? newJobCron : null,
          max_retries: parseInt(newJobMaxRetries),
          retry_policy_id: newJobPolicyId || null,
          dependencies: dependenciesArray
        })
      });

      if (res.ok) {
        setShowCreateJobModal(false);
        setNewJobName('');
        setNewJobPayload('{\n  "durationMs": 1500\n}');
        setNewJobDependencies('');
        fetchJobs();
      } else {
        const errData = await res.json();
        alert(errData.error || 'Failed to create job');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleRetryJob = async (jobId) => {
    try {
      const res = await fetch(`/api/jobs/${jobId}/retry`, {
        method: 'POST',
        headers: getHeaders()
      });
      if (res.ok) {
        fetchJobs();
        if (selectedJobId === jobId) fetchJobDetails(jobId);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeleteJob = async (jobId) => {
    if (!confirm('Cancel this job execution?')) return;
    try {
      const res = await fetch(`/api/jobs/${jobId}`, {
        method: 'DELETE',
        headers: getHeaders()
      });
      if (res.ok) {
        fetchJobs();
        setSelectedJobId(null);
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Utility mock trigger for creating instant demo failure/cron tasks
  const triggerMockTasks = async (type) => {
    try {
      if (!newJobQueueId) {
        alert('Please create a queue first.');
        return;
      }
      
      let name = 'Invoice Calculation';
      let payload = { durationMs: 1200 };
      
      if (type === 'fail') {
        name = 'Downstream sync - CRASH';
        payload = { durationMs: 800, shouldFail: true, errorMessage: 'API signature authentication rejected: invalid checksum' };
      } else if (type === 'batch') {
        // Enqueue batch directly
        const res = await fetch('/api/jobs/batch', {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({
            queue_id: newJobQueueId,
            jobs: [
              { name: 'Batch Frame #1', payload: { durationMs: 500 } },
              { name: 'Batch Frame #2', payload: { durationMs: 600 } },
              { name: 'Batch Frame #3', payload: { durationMs: 700 } }
            ]
          })
        });
        if (res.ok) fetchJobs();
        return;
      } else if (type === 'dag') {
        // Enqueue a workflow sequence: Parent -> Child
        const resA = await fetch('/api/jobs', {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({
            queue_id: newJobQueueId,
            name: 'DAG Parent: Compress Video',
            payload: { durationMs: 1500 }
          })
        });
        const dataA = await resA.json();
        
        if (resA.ok) {
          await fetch('/api/jobs', {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({
              queue_id: newJobQueueId,
              name: 'DAG Child: Distribute Stream',
              payload: { durationMs: 1000 },
              dependencies: [dataA.id]
            })
          });
          fetchJobs();
        }
        return;
      }

      await fetch('/api/jobs', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          queue_id: newJobQueueId,
          name,
          payload
        })
      });
      fetchJobs();
    } catch (err) {
      console.error(err);
    }
  };

  // Auth Redirect logic
  if (!token) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-header">
            <h2>Acme Job Engine</h2>
            <p>{isRegistering ? 'Register your scheduler account' : 'Sign in to management dashboard'}</p>
          </div>

          <form onSubmit={isRegistering ? handleRegister : handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {authError && (
              <div style={{ color: 'var(--danger)', fontSize: '0.85rem', background: 'rgba(239,68,68,0.1)', padding: '0.5rem 1rem', borderRadius: '8px', border: '1px solid rgba(239,68,68,0.2)' }}>
                {authError}
              </div>
            )}
            
            <div className="form-group">
              <label>Email Address</label>
              <input 
                type="email" 
                className="form-input" 
                required 
                value={authEmail} 
                onChange={(e) => setAuthEmail(e.target.value)} 
                placeholder="admin@acme.com" 
              />
            </div>

            <div className="form-group">
              <label>Password</label>
              <input 
                type="password" 
                className="form-input" 
                required 
                value={authPassword} 
                onChange={(e) => setAuthPassword(e.target.value)} 
                placeholder="••••••••" 
              />
            </div>

            {isRegistering && (
              <div className="form-group">
                <label>Organization Name</label>
                <input 
                  type="text" 
                  className="form-input" 
                  required={isRegistering} 
                  value={authOrgName} 
                  onChange={(e) => setAuthOrgName(e.target.value)} 
                  placeholder="Acme Corp" 
                />
              </div>
            )}

            <button type="submit" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: '0.5rem' }}>
              {isRegistering ? 'Create Account' : 'Sign In'}
            </button>
          </form>

          <div style={{ textAlign: 'center', marginTop: '1.5rem', fontSize: '0.85rem' }}>
            <span style={{ color: 'var(--text-muted)' }}>
              {isRegistering ? 'Already have an account?' : 'Need a new organization?'}
            </span>{' '}
            <button 
              className="btn-link" 
              style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', fontWeight: 'bold', textDecoration: 'underline' }}
              onClick={() => {
                setIsRegistering(!isRegistering);
                setAuthError('');
              }}
            >
              {isRegistering ? 'Sign In' : 'Register Now'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Loaded Dashboard UI
  return (
    <div className="app-container">
      {/* Sidebar Navigation */}
      <aside className="sidebar">
        <div>
          <div className="brand">
            <div className="avatar" style={{ background: 'var(--primary)', color: '#fff' }}>JS</div>
            <h1>Acme Job Scheduler</h1>
          </div>

          <ul className="nav-links">
            <li 
              className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`}
              onClick={() => setActiveTab('dashboard')}
            >
              <Activity /> Dashboard
            </li>
            <li 
              className={`nav-item ${activeTab === 'queues' ? 'active' : ''}`}
              onClick={() => setActiveTab('queues')}
            >
              <Layers /> Queues Config
            </li>
            <li 
              className={`nav-item ${activeTab === 'jobs' ? 'active' : ''}`}
              onClick={() => setActiveTab('jobs')}
            >
              <FileText /> Job Explorer
            </li>
            <li 
              className={`nav-item ${activeTab === 'workers' ? 'active' : ''}`}
              onClick={() => setActiveTab('workers')}
            >
              <Cpu /> Worker Nodes
            </li>
          </ul>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Quick Demo Controls Panel */}
          <div style={{ background: 'rgba(255,255,255,0.03)', padding: '0.75rem', borderRadius: '12px', border: '1px solid var(--border-glass)' }}>
            <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '0.5rem', fontWeight: 'bold' }}>Mock Task Spawners</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.35rem' }}>
              <button onClick={() => triggerMockTasks('success')} className="btn btn-secondary" style={{ padding: '0.25rem', fontSize: '0.75rem' }}>Job</button>
              <button onClick={() => triggerMockTasks('fail')} className="btn btn-danger" style={{ padding: '0.25rem', fontSize: '0.75rem' }}>Fail Job</button>
              <button onClick={() => triggerMockTasks('batch')} className="btn btn-secondary" style={{ padding: '0.25rem', fontSize: '0.75rem' }}>Batch</button>
              <button onClick={() => triggerMockTasks('dag')} className="btn btn-primary" style={{ padding: '0.25rem', fontSize: '0.75rem' }}>DAG Workflow</button>
            </div>
          </div>

          <div className="user-badge">
            <div className="avatar">A</div>
            <div className="user-info">
              <span className="user-email">{user?.email}</span>
              <span className="user-role">{user?.orgRole}</span>
            </div>
            <button 
              className="btn btn-icon btn-secondary" 
              onClick={handleLogout} 
              title="Logout" 
              style={{ marginLeft: 'auto', padding: '0.35rem' }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Panel content */}
      <main className="main-content">
        <header className="top-header">
          <div className="page-title">
            <h2>
              {activeTab === 'dashboard' && 'Operations Dashboard'}
              {activeTab === 'queues' && 'Queue Configuration'}
              {activeTab === 'jobs' && 'Background Job Explorer'}
              {activeTab === 'workers' && 'Worker Registry'}
            </h2>
            <p>
              {activeTab === 'dashboard' && 'Real-time overview of active worker heartbeats, state throughput and backlogs.'}
              {activeTab === 'queues' && 'Manage job routing paths, concurrency limitations, priority profiles, and retry rates.'}
              {activeTab === 'jobs' && 'Browse task logs metadata, track parent DAG linkages, and retry dead letter logs.'}
              {activeTab === 'workers' && 'Monitor health nodes and execution thresholds for distributed threads.'}
            </p>
          </div>

          <div className="actions-bar">
            {wsConnected ? (
              <span className="badge badge-status completed" style={{ height: 'fit-content', display: 'flex', gap: '0.25rem', padding: '0.5rem 0.75rem' }}>
                <span style={{ width: '6px', height: '6px', background: 'var(--success)', borderRadius: '50%', display: 'inline-block' }}></span> WS Connected
              </span>
            ) : (
              <span className="badge badge-status claimed" style={{ height: 'fit-content', display: 'flex', gap: '0.25rem', padding: '0.5rem 0.75rem' }}>
                <span style={{ width: '6px', height: '6px', background: 'var(--warning)', borderRadius: '50%', display: 'inline-block' }}></span> API Syncing
              </span>
            )}
            
            {activeTab === 'queues' && (
              <button className="btn btn-primary" onClick={() => setShowCreateQueueModal(true)}>
                <Plus size={16} /> Create Queue
              </button>
            )}
            {activeTab === 'jobs' && (
              <button className="btn btn-primary" onClick={() => setShowCreateJobModal(true)}>
                <Plus size={16} /> Enqueue Job
              </button>
            )}
          </div>
        </header>

        {/* TAB 1: DASHBOARD VIEW */}
        {activeTab === 'dashboard' && (
          <>
            {/* Status counts grid */}
            <section className="metrics-grid">
              <div className="metric-card" style={{ '--accent': 'var(--primary)' }}>
                <div className="metric-header">
                  <span>Queued Jobs</span>
                  <Clock size={16} />
                </div>
                <div className="metric-body">
                  <div className="metric-value">{metrics.jobStates.queued}</div>
                  <div className="metric-sub">Waiting in line</div>
                </div>
              </div>

              <div className="metric-card" style={{ '--accent': 'var(--warning)' }}>
                <div className="metric-header">
                  <span>Running / Claimed</span>
                  <Activity size={16} />
                </div>
                <div className="metric-body">
                  <div className="metric-value">{metrics.jobStates.running + metrics.jobStates.claimed}</div>
                  <div className="metric-sub">Executing on worker threads</div>
                </div>
              </div>

              <div className="metric-card" style={{ '--accent': 'var(--success)' }}>
                <div className="metric-header">
                  <span>Completed</span>
                  <CheckCircle size={16} />
                </div>
                <div className="metric-body">
                  <div className="metric-value">{metrics.jobStates.completed}</div>
                  <div className="metric-sub">Executed successfully</div>
                </div>
              </div>

              <div className="metric-card" style={{ '--accent': 'var(--danger)' }}>
                <div className="metric-header">
                  <span>Failed & DLQ</span>
                  <AlertTriangle size={16} />
                </div>
                <div className="metric-body">
                  <div className="metric-value">{metrics.jobStates.failed + metrics.jobStates.dlq}</div>
                  <div className="metric-sub">Requires manual recovery</div>
                </div>
              </div>

              <div className="metric-card" style={{ '--accent': 'var(--info)' }}>
                <div className="metric-header">
                  <span>Active Workers</span>
                  <Cpu size={16} />
                </div>
                <div className="metric-body">
                  <div className="metric-value">{metrics.activeWorkers}</div>
                  <div className="metric-sub">Registered nodes online</div>
                </div>
              </div>
            </section>

            {/* Timelines and Log list */}
            <section className="charts-container">
              {/* timeline SVG graphic chart */}
              <div className="panel-card">
                <div className="panel-title">
                  Throughput Timeline
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Executions (Last 24 Hours)</span>
                </div>
                
                <div className="chart-wrapper">
                  {metrics.timeline.length === 0 ? (
                    <div style={{ flex: 1, textAlign: 'center', color: 'var(--text-muted)', paddingBottom: '3rem' }}>
                      No recent metrics timeline recorded. Trigger some mock tasks to generate graphs.
                    </div>
                  ) : (
                    metrics.timeline.map((bucket, idx) => {
                      const completed = parseInt(bucket.completed_count || 0);
                      const failed = parseInt(bucket.failed_count || 0);
                      const total = completed + failed;
                      const maxTotal = Math.max(...metrics.timeline.map(t => parseInt(t.completed_count || 0) + parseInt(t.failed_count || 0)), 1);
                      const pct = Math.max(10, (total / maxTotal) * 80); // clamp min 10% for graphic visibility
                      
                      const hourStr = new Date(bucket.hour_bucket).getHours() + ':00';

                      return (
                        <div key={idx} className="chart-bar-container">
                          <div 
                            className="chart-bar-fill" 
                            style={{ height: `${pct}%`, background: failed > 0 ? 'linear-gradient(to top, var(--danger) 0%, var(--primary) 100%)' : undefined }}
                            data-val={`Completed: ${completed}, Failed: ${failed}`}
                          ></div>
                          <span className="chart-bar-label">{hourStr}</span>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Logs live tracker list */}
              <div className="panel-card">
                <div className="panel-title">
                  System Logs
                  <span className="spinner" style={{ width: '14px', height: '14px', borderWidth: '2px' }}></span>
                </div>
                <div className="logs-list">
                  {systemLogs.length === 0 ? (
                    <div style={{ color: 'var(--text-muted)', textAlign: 'center', paddingTop: '4rem' }}>
                      Waiting for worker loops to generate job logs...
                    </div>
                  ) : (
                    systemLogs.map((log) => {
                      const timeStr = new Date(log.created_at).toLocaleTimeString();
                      return (
                        <div key={log.id} className="log-row">
                          <span className="log-time">{timeStr}</span>
                          <span className={`log-level ${log.level}`}>{log.level}</span>
                          <span className="log-msg">
                            <strong style={{ color: 'var(--primary)' }}>[{log.job_name || 'System'}]</strong> {log.message}
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </section>
          </>
        )}

        {/* TAB 2: QUEUE CONFIGURATION */}
        {activeTab === 'queues' && (
          <section className="queues-grid">
            {queues.map((q) => {
              const activeCount = q.concurrency_limit;
              
              return (
                <div key={q.id} className={`queue-card ${q.is_paused ? 'paused' : ''}`}>
                  <div className="queue-card-header">
                    <div>
                      <h4 className="queue-card-name">{q.name}</h4>
                      <span className="queue-card-project">{q.project_name || 'Main Scheduler'}</span>
                    </div>
                    {q.is_paused ? (
                      <span className="badge badge-status claimed">Paused</span>
                    ) : (
                      <span className="badge badge-status completed">Active</span>
                    )}
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem', fontSize: '0.85rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--text-muted)' }}>Priority Grade:</span>
                      <span className="badge badge-priority">{q.priority}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--text-muted)' }}>Concurrency Limit:</span>
                      <span style={{ fontWeight: 'bold' }}>{q.concurrency_limit} jobs</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--text-muted)' }}>Fallback Strategy:</span>
                      <span style={{ color: 'var(--primary)', fontWeight: '500' }}>
                        {q.retry_policy_name || 'No Policy (Fail Fast)'}
                      </span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                    {q.is_paused ? (
                      <button className="btn btn-secondary btn-icon" onClick={() => handleResumeQueue(q.id)} title="Resume Queue">
                        <Play size={16} />
                      </button>
                    ) : (
                      <button className="btn btn-secondary btn-icon" onClick={() => handlePauseQueue(q.id)} title="Pause Queue">
                        <Pause size={16} />
                      </button>
                    )}
                    <button className="btn btn-secondary" style={{ flexGrow: 1 }} onClick={() => handleOpenEditQueue(q)}>
                      Edit Config
                    </button>
                    <button className="btn btn-secondary btn-icon" style={{ color: 'var(--danger)' }} onClick={() => handleDeleteQueue(q.id)} title="Delete Queue">
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              );
            })}
          </section>
        )}

        {/* TAB 3: JOB EXPLORER */}
        {activeTab === 'jobs' && (
          <section className="panel-card" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {/* Filter and Search Bar */}
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
              <div style={{ position: 'relative', flex: 1, minWidth: '240px' }}>
                <Search size={18} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                <input 
                  type="text" 
                  className="form-input" 
                  style={{ paddingLeft: '2.5rem' }} 
                  placeholder="Search jobs by name or UUID..." 
                  value={jobsSearch}
                  onChange={(e) => { setJobsSearch(e.target.value); setJobsPage(0); }}
                />
              </div>

              <select 
                className="form-input" 
                style={{ width: '160px' }} 
                value={jobsFilterStatus} 
                onChange={(e) => { setJobsFilterStatus(e.target.value); setJobsPage(0); }}
              >
                <option value="">All Statuses</option>
                <option value="queued">Queued</option>
                <option value="scheduled">Scheduled</option>
                <option value="running">Running</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
                <option value="dlq">DLQ</option>
              </select>

              <select 
                className="form-input" 
                style={{ width: '160px' }} 
                value={jobsFilterQueue} 
                onChange={(e) => { setJobsFilterQueue(e.target.value); setJobsPage(0); }}
              >
                <option value="">All Queues</option>
                {queues.map(q => (
                  <option key={q.id} value={q.id}>{q.name}</option>
                ))}
              </select>
            </div>

            {/* Jobs Data Table */}
            <div className="table-wrapper">
              <table className="table-main">
                <thead>
                  <tr>
                    <th>Job Name / ID</th>
                    <th>Queue</th>
                    <th>Status</th>
                    <th>Execution Info</th>
                    <th>Created At</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.length === 0 ? (
                    <tr>
                      <td colSpan="6" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '3rem' }}>
                        No jobs match the current filters. Click "Enqueue Job" to push work.
                      </td>
                    </tr>
                  ) : (
                    jobs.map((job) => {
                      const runAt = new Date(job.run_at);
                      
                      return (
                        <tr key={job.id}>
                          <td>
                            <div 
                              style={{ fontWeight: '600', cursor: 'pointer', color: '#fff' }} 
                              onClick={() => setSelectedJobId(job.id)}
                              className="btn-link"
                            >
                              {job.name}
                            </div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{job.id}</div>
                          </td>
                          <td>{job.queue_name}</td>
                          <td>
                            <span className={`badge badge-status ${job.status}`}>
                              {job.status === 'running' ? 'Running' : job.status}
                            </span>
                          </td>
                          <td>
                            {job.status === 'completed' && job.completed_at && (
                              <span style={{ fontSize: '0.85rem', color: 'var(--success)' }}>Completed</span>
                            )}
                            {job.recurring_cron && (
                              <div style={{ fontSize: '0.75rem', color: 'var(--info)' }}>Cron: {job.recurring_cron}</div>
                            )}
                            {job.status === 'scheduled' && (
                              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Trigger: {runAt.toLocaleTimeString()}</div>
                            )}
                            {job.retry_count > 0 && job.status !== 'completed' && (
                              <div style={{ fontSize: '0.75rem', color: 'var(--warning)' }}>Retry attempt: {job.retry_count}/{job.max_retries}</div>
                            )}
                          </td>
                          <td style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                            {new Date(job.created_at).toLocaleString()}
                          </td>
                          <td>
                            <div className="table-action-btns">
                              {(job.status === 'failed' || job.status === 'dlq') && (
                                <button className="btn btn-secondary btn-icon" style={{ color: 'var(--success)' }} onClick={() => handleRetryJob(job.id)} title="Retry Job">
                                  <RefreshCw size={14} />
                                </button>
                              )}
                              <button className="btn btn-secondary btn-icon" style={{ color: 'var(--danger)' }} onClick={() => handleDeleteJob(job.id)} title="Cancel Job">
                                  <Trash2 size={14} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls */}
            {jobsTotalCount > 15 && (
              <div style={{ display: 'flex', justifySelf: 'center', gap: '0.5rem', marginTop: '1rem', alignSelf: 'center' }}>
                <button className="btn btn-secondary" disabled={jobsPage === 0} onClick={() => setJobsPage(jobsPage - 1)}>
                  Prev
                </button>
                <span style={{ display: 'flex', alignItems: 'center', padding: '0 1rem', fontSize: '0.9rem' }}>
                  Page {jobsPage + 1} of {Math.ceil(jobsTotalCount / 15)}
                </span>
                <button className="btn btn-secondary" disabled={(jobsPage + 1) * 15 >= jobsTotalCount} onClick={() => setJobsPage(jobsPage + 1)}>
                  Next
                </button>
              </div>
            )}
          </section>
        )}

        {/* TAB 4: WORKERS REGISTRY */}
        {activeTab === 'workers' && (
          <section className="panel-card">
            <div className="table-wrapper">
              <table className="table-main">
                <thead>
                  <tr>
                    <th>WORKER ID</th>
                    <th>HOSTNAME</th>
                    <th>CAPACITY</th>
                    <th>CURRENT LOAD</th>
                    <th>HEARTBEAT</th>
                    <th>STATUS</th>
                  </tr>
                </thead>
                <tbody>
                  {workers.length === 0 ? (
                    <tr>
                      <td colSpan="6" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '3rem' }}>
                        No active worker service registered. Make sure to launch the worker service.
                      </td>
                    </tr>
                  ) : (
                    workers.map((worker) => {
                      const lhb = new Date(worker.last_heartbeat_at);
                      const diffSec = Math.max(0, Math.round((new Date() - lhb) / 1000));
                      const heartbeatText = diffSec < 6 ? 'just now' : `${diffSec}s ago`;
                      
                      return (
                        <tr key={worker.id}>
                          <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 'bold' }}>{worker.id}</td>
                          <td style={{ fontWeight: '600' }}>{worker.hostname}</td>
                          <td>{worker.concurrency_limit} slot{worker.concurrency_limit > 1 ? 's' : ''}</td>
                          <td style={{ fontFamily: 'var(--font-mono)' }}>{worker.current_load || 0}/{worker.concurrency_limit}</td>
                          <td>{heartbeatText}</td>
                          <td>
                            {worker.virtualStatus === 'active' && (
                              <span className="badge badge-status completed">LIVE</span>
                            )}
                            {worker.virtualStatus === 'stale' && (
                              <span className="badge badge-status claimed">STALE</span>
                            )}
                            {worker.virtualStatus === 'offline' && (
                              <span className="badge badge-status failed">OFFLINE</span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>

      {/* MODAL: CREATE QUEUE */}
      {showCreateQueueModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3>Create Queue Channel</h3>
              <button className="btn btn-secondary btn-icon" onClick={() => setShowCreateQueueModal(false)}><X size={16} /></button>
            </div>

            <form onSubmit={handleCreateQueue} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <div className="form-group">
                <label>Select Project</label>
                <select className="form-input" value={newQueueProjectId} onChange={(e) => setNewQueueProjectId(e.target.value)}>
                  {projects.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label>Queue Name</label>
                <input 
                  type="text" 
                  className="form-input" 
                  required 
                  value={newQueueName} 
                  onChange={(e) => setNewQueueName(e.target.value)} 
                  placeholder="invoice-processing"
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Priority Rank</label>
                  <input 
                    type="number" 
                    className="form-input" 
                    min="0" 
                    max="1000" 
                    value={newQueuePriority} 
                    onChange={(e) => setNewQueuePriority(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Concurrency Limit</label>
                  <input 
                    type="number" 
                    className="form-input" 
                    min="1" 
                    max="100" 
                    value={newQueueConcurrency} 
                    onChange={(e) => setNewQueueConcurrency(e.target.value)}
                  />
                </div>
              </div>

              <div className="form-group">
                <label>Retry Backoff Policy</label>
                <select className="form-input" value={newQueuePolicy} onChange={(e) => setNewQueuePolicy(e.target.value)}>
                  <option value="">None (Fail immediately)</option>
                  {retryPolicies.map(rp => (
                    <option key={rp.id} value={rp.id}>{rp.name} ({rp.type})</option>
                  ))}
                </select>
              </div>

              <button type="submit" className="btn btn-primary" style={{ marginTop: '0.5rem', justifyContent: 'center' }}>
                Create Queue
              </button>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: EDIT QUEUE CONFIG */}
      {showEditQueueModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3>Edit Queue: {editingQueue?.name}</h3>
              <button className="btn btn-secondary btn-icon" onClick={() => setShowEditQueueModal(false)}><X size={16} /></button>
            </div>

            <form onSubmit={handleUpdateQueue} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <div className="form-row">
                <div className="form-group">
                  <label>Priority Rank</label>
                  <input 
                    type="number" 
                    className="form-input" 
                    min="0" 
                    max="1000" 
                    value={editQueuePriority} 
                    onChange={(e) => setEditQueuePriority(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Concurrency Limit</label>
                  <input 
                    type="number" 
                    className="form-input" 
                    min="1" 
                    max="100" 
                    value={editQueueConcurrency} 
                    onChange={(e) => setEditQueueConcurrency(e.target.value)}
                  />
                </div>
              </div>

              <div className="form-group">
                <label>Retry Backoff Policy</label>
                <select className="form-input" value={editQueuePolicy} onChange={(e) => setEditQueuePolicy(e.target.value)}>
                  <option value="">None (Fail immediately)</option>
                  {retryPolicies.map(rp => (
                    <option key={rp.id} value={rp.id}>{rp.name} ({rp.type})</option>
                  ))}
                </select>
              </div>

              <button type="submit" className="btn btn-primary" style={{ marginTop: '0.5rem', justifyContent: 'center' }}>
                Save Settings
              </button>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: ENQUEUE JOB */}
      {showCreateJobModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3>Enqueue Background Task</h3>
              <button className="btn btn-secondary btn-icon" onClick={() => setShowCreateJobModal(false)}><X size={16} /></button>
            </div>

            <form onSubmit={handleCreateJob} style={{ display: 'flex', flexDirection: 'column', gap: '1.15rem' }}>
              <div className="form-group">
                <label>Target Queue Channel</label>
                <select className="form-input" value={newJobQueueId} onChange={(e) => setNewJobQueueId(e.target.value)}>
                  {queues.map(q => (
                    <option key={q.id} value={q.id}>{q.name} (Priority: {q.priority})</option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label>Job Display Name</label>
                <input 
                  type="text" 
                  className="form-input" 
                  required 
                  value={newJobName} 
                  onChange={(e) => setNewJobName(e.target.value)} 
                  placeholder="Compile User Metrics Report"
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Max Retry Attempts</label>
                  <input 
                    type="number" 
                    className="form-input" 
                    min="0" 
                    max="10" 
                    value={newJobMaxRetries} 
                    onChange={(e) => setNewJobMaxRetries(e.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label>Overwrite Retry Policy (Optional)</label>
                  <select className="form-input" value={newJobPolicyId} onChange={(e) => setNewJobPolicyId(e.target.value)}>
                    <option value="">Use Queue Defaults</option>
                    {retryPolicies.map(rp => (
                      <option key={rp.id} value={rp.id}>{rp.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label>Job Trigger Schedule</label>
                <div style={{ display: 'flex', gap: '1rem' }}>
                  <label style={{ display: 'flex', gap: '0.25rem', cursor: 'pointer' }}>
                    <input type="radio" checked={newJobType === 'immediate'} onChange={() => setNewJobType('immediate')} /> Immediate
                  </label>
                  <label style={{ display: 'flex', gap: '0.25rem', cursor: 'pointer' }}>
                    <input type="radio" checked={newJobType === 'delayed'} onChange={() => setNewJobType('delayed')} /> Delayed
                  </label>
                  <label style={{ display: 'flex', gap: '0.25rem', cursor: 'pointer' }}>
                    <input type="radio" checked={newJobType === 'cron'} onChange={() => setNewJobType('cron')} /> Recurring (Cron)
                  </label>
                </div>
              </div>

              {newJobType === 'delayed' && (
                <div className="form-group">
                  <label>Execution Delay (Minutes from now)</label>
                  <input 
                    type="number" 
                    className="form-input" 
                    min="1" 
                    value={newJobDelayMin} 
                    onChange={(e) => setNewJobDelayMin(e.target.value)} 
                  />
                </div>
              )}

              {newJobType === 'cron' && (
                <div className="form-group">
                  <label>Cron Expression (min hour day month day-of-week)</label>
                  <input 
                    type="text" 
                    className="form-input" 
                    value={newJobCron} 
                    onChange={(e) => setNewJobCron(e.target.value)} 
                    placeholder="*/5 * * * *"
                  />
                </div>
              )}

              <div className="form-group">
                <label>Workflow Dependencies (Optional - Comma separated Parent Job UUIDs)</label>
                <input 
                  type="text" 
                  className="form-input" 
                  value={newJobDependencies} 
                  onChange={(e) => setNewJobDependencies(e.target.value)} 
                  placeholder="e.g. job-uuid-1, job-uuid-2"
                />
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>This job will not execute until all specified parent tasks have completed.</span>
              </div>

              <div className="form-group">
                <label>Input Parameters Payload (JSON format)</label>
                <textarea 
                  className="form-input" 
                  rows="3" 
                  style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}
                  value={newJobPayload} 
                  onChange={(e) => setNewJobPayload(e.target.value)}
                ></textarea>
              </div>

              <button type="submit" className="btn btn-primary" style={{ marginTop: '0.5rem', justifyContent: 'center' }}>
                Enqueue Job
              </button>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: JOB DETAILED EXPLORER */}
      {selectedJobId && selectedJobDetail && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '750px' }}>
            <div className="modal-header">
              <div>
                <h3>Job Details</h3>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>UUID: {selectedJobDetail.job.id}</span>
              </div>
              <button 
                className="btn btn-secondary btn-icon" 
                onClick={() => { setSelectedJobId(null); setSelectedJobDetail(null); }}
              >
                <X size={16} />
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '1.5rem' }}>
              {/* Left Column: Metadata & Payload */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div style={{ display: 'flex', gap: '0.75rem' }}>
                  <span className={`badge badge-status ${selectedJobDetail.job.status}`}>{selectedJobDetail.job.status}</span>
                  <span className="badge badge-priority">Queue: {selectedJobDetail.job.queue_name}</span>
                </div>

                <div className="form-group">
                  <label>Parameters Payload</label>
                  <pre style={{ background: 'rgba(0, 0, 0, 0.25)', border: '1px solid var(--border-glass)', padding: '0.75rem', borderRadius: '8px', overflowX: 'auto', fontSize: '0.8rem', fontFamily: 'var(--font-mono)' }}>
                    {JSON.stringify(selectedJobDetail.job.payload, null, 2)}
                  </pre>
                </div>

                {/* Workflow graph details */}
                {(selectedJobDetail.dependencies.parents.length > 0 || selectedJobDetail.dependencies.children.length > 0) && (
                  <div className="workflow-dag-box">
                    <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', fontWeight: 'bold', color: 'var(--text-muted)' }}>Workflow DAG Dependencies</div>
                    <div className="dag-steps-row">
                      {selectedJobDetail.dependencies.parents.map(p => (
                        <React.Fragment key={p.parent_job_id}>
                          <div className="dag-node">
                            <span style={{ fontSize: '0.8rem', fontWeight: '600', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>{p.name}</span>
                            <span style={{ fontSize: '0.7rem' }} className={`badge badge-status ${p.status}`}>{p.status}</span>
                          </div>
                          <span className="dag-arrow">→</span>
                        </React.Fragment>
                      ))}
                      
                      <div className="dag-node active-node">
                        <span style={{ fontSize: '0.8rem', fontWeight: 'bold' }}>{selectedJobDetail.job.name}</span>
                        <span style={{ fontSize: '0.7rem' }} className={`badge badge-status ${selectedJobDetail.job.status}`}>{selectedJobDetail.job.status}</span>
                      </div>

                      {selectedJobDetail.dependencies.children.map(c => (
                        <React.Fragment key={c.child_job_id}>
                          <span className="dag-arrow">→</span>
                          <div className="dag-node">
                            <span style={{ fontSize: '0.8rem', fontWeight: '600' }}>{c.name}</span>
                            <span style={{ fontSize: '0.7rem' }} className={`badge badge-status ${c.status}`}>{c.status}</span>
                          </div>
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                )}

                {/* Render AI Summary for failures */}
                {(selectedJobDetail.job.status === 'failed' || selectedJobDetail.job.status === 'dlq') && selectedJobDetail.executions?.[0]?.ai_summary && (
                  <div className="ai-summary-box">
                    <h3><Sparkles size={16} /> AI Diagnostic Report</h3>
                    <div 
                      style={{ lineHeight: '1.4' }}
                      dangerouslySetInnerHTML={{ 
                        __html: selectedJobDetail.executions[0].ai_summary
                          .replace(/### (.*)/g, '<strong style="color:#d8b4fe;display:block;margin-top:0.5rem">$1</strong>')
                          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
                          .replace(/`([^`]+)`/g, '<code style="background:rgba(0,0,0,0.3);padding:2px 4px;border-radius:4px;font-family:var(--font-mono)">$1</code>')
                          .replace(/> (.*)/g, '<blockquote style="border-left:3px solid var(--primary);padding-left:0.5rem;margin:0.25rem 0;color:var(--text-muted)">$1</blockquote>')
                      }}
                    />
                  </div>
                )}
              </div>

              {/* Right Column: Execution History & Logs */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', borderLeft: '1px solid var(--border-glass)', paddingLeft: '1.5rem' }}>
                <div>
                  <h4 style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>Run History</h4>
                  <div style={{ maxHeight: '180px', overflowY: 'auto', border: '1px solid var(--border-glass)', borderRadius: '8px' }}>
                    <table className="table-main" style={{ fontSize: '0.75rem' }}>
                      <thead>
                        <tr>
                          <th>Start</th>
                          <th>Duration</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedJobDetail.executions.length === 0 ? (
                          <tr>
                            <td colSpan="3" style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No execution history</td>
                          </tr>
                        ) : (
                          selectedJobDetail.executions.map(exec => (
                            <tr key={exec.id}>
                              <td>{new Date(exec.started_at).toLocaleTimeString()}</td>
                              <td>{exec.duration_ms ? `${exec.duration_ms}ms` : '-'}</td>
                              <td>
                                <span className={`badge badge-status ${exec.status}`}>{exec.status}</span>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div>
                  <h4 style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>Job Console Logs</h4>
                  <div className="logs-list" style={{ height: '220px' }}>
                    {selectedJobDetail.logs.length === 0 ? (
                      <div style={{ color: 'var(--text-muted)', textAlign: 'center', paddingTop: '3rem' }}>No execution logs recorded yet.</div>
                    ) : (
                      selectedJobDetail.logs.map(log => (
                        <div key={log.id} className="log-row">
                          <span className="log-time">{new Date(log.created_at).toLocaleTimeString()}</span>
                          <span className={`log-level ${log.level}`}>{log.level}</span>
                          <span className="log-msg" style={{ wordBreak: 'break-all' }}>{log.message}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '0.5rem', marginTop: 'auto' }}>
                  {(selectedJobDetail.job.status === 'failed' || selectedJobDetail.job.status === 'dlq') && (
                    <button className="btn btn-success" style={{ flexGrow: 1 }} onClick={() => handleRetryJob(selectedJobDetail.job.id)}>
                      <RefreshCw size={16} /> Force Retry
                    </button>
                  )}
                  <button className="btn btn-danger" style={{ flexGrow: 1 }} onClick={() => handleDeleteJob(selectedJobDetail.job.id)}>
                    <Trash2 size={16} /> Cancel Task
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
