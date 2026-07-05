import db from '../../shared/db.js';

/**
 * Execute job based on name and payload
 * @param {object} job - Job database row details
 * @param {string} executionId - Current execution ID
 * @param {function(string, string)} logFn - Log writer callback (level, message)
 */
export async function executeJob(job, executionId, logFn) {
  const { name, payload } = job;
  const data = payload || {};
  
  await logFn('info', `Starting execution of job "${name}" (ID: ${job.id}, Execution: ${executionId})`);
  
  // Simulated processing delay
  const durationMs = data.durationMs || Math.floor(Math.random() * 2000) + 500;
  await logFn('info', `Simulating task execution of duration ${durationMs}ms...`);
  
  // Introduce a delay
  await new Promise(resolve => setTimeout(resolve, durationMs));

  // Determine behavior based on job name / payload parameters
  const jobLower = name.toLowerCase();

  if (jobLower.includes('fail') || data.shouldFail) {
    const errors = [
      'Connection timed out with downstream gateway API',
      'Resource locked: lock acquired by another transaction node',
      'Validation Error: "email" field must be a valid email format',
      'Database deadlock detected while writing back log reports',
      'Authentication Failed: Stripe signature verify failed'
    ];
    const failureMsg = data.errorMessage || errors[Math.floor(Math.random() * errors.length)];
    await logFn('error', `Execution encountered critical error: ${failureMsg}`);
    throw new Error(failureMsg);
  }

  if (jobLower.includes('backup') || jobLower.includes('daemon')) {
    await logFn('info', `Reading disk file systems indices... 4.2GB indexed.`);
    await logFn('info', `Uploading zipped archive to Amazon S3 bucket "${data.s3_bucket || 'acme-backups'}"...`);
    await logFn('info', `S3 upload completed. ETag: "a8b92bceee9801"`);
  } else if (jobLower.includes('invoice') || jobLower.includes('payment')) {
    await logFn('info', `Retrieving active invoices details for invoice ID: ${data.invoiceId || 1024}`);
    await logFn('info', `Processing Stripe Charge for customer: ${data.customer || 'Acme Customer'}`);
    await logFn('info', `Charge processed successfully. Reference: ch_887123aa128`);
  } else if (jobLower.includes('video') || jobLower.includes('render')) {
    await logFn('info', `Initializing video rendering frames engine...`);
    await logFn('info', `Processing frame segments range: ${data.range || '1-50'}...`);
    await logFn('info', `Video frames rendering completed. Writing to output buffer.`);
  } else {
    // Default task execution
    const num = data.limit || 50000;
    await logFn('info', `Performing computational crunching up to limit: ${num}`);
    let sum = 0;
    for (let i = 0; i < Math.min(num, 5000000); i++) {
      sum += Math.sqrt(i);
    }
    await logFn('info', `Computation calculation completed. Result hash: ${sum.toFixed(4)}`);
  }

  await logFn('info', `Job execution completed successfully in ${durationMs}ms.`);
}

/**
 * Generate AI explanation for failed executions (Mock OpenAI/Gemini logs diagnostics)
 * @param {string} jobName 
 * @param {string} errorMessage 
 * @returns {string} - Markdown diagnostic
 */
function generateLocalFailureSummary(jobName, errorMessage) {
  const time = new Date().toISOString();
  
  let explanation = `### 🤖 AI Diagnostic Summary
**Timestamp**: \`${time}\`
**Job Name**: \`${jobName}\`

#### 🔍 Root Cause Analysis
The job failed because:
> **"${errorMessage}"**

This error typically indicates that:`;

  if (errorMessage.includes('Connection') || errorMessage.includes('timed out')) {
    explanation += `
- The downstream API server took too long to respond, exceeding the socket connection timeout.
- This might be caused by temporary network latency or the target server experiencing high load.`;
  } else if (errorMessage.includes('Authentication') || errorMessage.includes('API key')) {
    explanation += `
- The request credentials, authentication token, or API signatures were rejected.
- The key has either expired, has insufficient permissions, or the secret environment variable is incorrectly set.`;
  } else if (errorMessage.includes('Validation')) {
    explanation += `
- The payload sent does not match the schema constraints required by the validation schemas.
- Check the structure of the input parameters in the client request.`;
  } else {
    explanation += `
- A database-level lock collision, query exception, or unhandled runtime error occurred inside the code script.
- The thread stack crashed during the database or transaction writeback loop.`;
  }

  explanation += `

#### 💡 Recommended Actions
1. **Verify Credentials**: Check that tokens and API keys are loaded correctly.
2. **Backoff Retries**: Since this queue uses retry policies, linear/exponential backoff will throttle subsequent requests to prevent spamming.
3. **Endpoint Check**: Ping the status endpoint of the downstream API to check for general outage.`;

  return explanation;
}

/**
 * Generate AI explanation for failed executions (Real Gemini API call with local fallback)
 * @param {string} jobName 
 * @param {string} errorMessage 
 * @returns {Promise<string>} - Markdown diagnostic
 */
export async function generateAiFailureSummary(jobName, errorMessage) {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    return generateLocalFailureSummary(jobName, errorMessage);
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${geminiKey}`;
    const prompt = `You are a DevOps diagnostics AI bot. Analyze this background task failure:
Job Name: "${jobName}"
Error Message: "${errorMessage}"

Generate a short, professional diagnostics report in markdown. Include a "🔍 Root Cause Analysis" section and "💡 Recommended Actions" bullet points. Do not include introductory notes, start directly with the analysis.`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: prompt
          }]
        }]
      })
    });

    if (res.ok) {
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        return `### 🤖 AI Diagnostic Summary\n\n${text}`;
      }
    }
  } catch (error) {
    console.error('Failed to generate real Gemini AI failure summary:', error);
  }

  return generateLocalFailureSummary(jobName, errorMessage);
}
