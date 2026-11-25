const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory state for active/recent batch jobs
let isRunning = false;
let shouldStop = false;
const recentLogs = [];

function logEvent(level, message, meta = null) {
  const timestamp = new Date().toISOString();
  const formatted = meta
    ? `[${timestamp}] [${level}] ${message} | ${JSON.stringify(meta)}`
    : `[${timestamp}] [${level}] ${message}`;

  // Prints directly to Render Logs (stdout/stderr)
  if (level === 'ERROR') {
    console.error(formatted);
  } else {
    console.log(formatted);
  }

  recentLogs.unshift(formatted);
  if (recentLogs.length > 200) recentLogs.pop();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeKenyanPhone(raw) {
  const digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('254') && digits.length === 12) return '0' + digits.slice(3);
  if (digits.startsWith('0') && digits.length === 10) return digits;
  if ((digits.startsWith('7') || digits.startsWith('1')) && digits.length === 9) {
    return '0' + digits;
  }
  return null;
}

/**
 * Initiates an STK Push using either:
 * 1) WALLET mode -> https://printpay.site/b2c/topup/stk_push (settles to PrintPay B2C Wallet)
 * 2) C2B mode    -> https://printpay.co.ke/api/stk_push (settles to configured Till/Paybill)
 */
async function sendStkPush(phone, amount) {
  const mode = (process.env.PRINTPAY_MODE || 'WALLET').toUpperCase();

  if (mode === 'WALLET') {
    const walletId = process.env.PRINTPAY_WALLET_ID;
    const securityCredential = process.env.PRINTPAY_SECURITY_CREDENTIAL;

    if (!walletId || !securityCredential) {
      throw new Error('Missing PRINTPAY_WALLET_ID or PRINTPAY_SECURITY_CREDENTIAL');
    }

    const response = await fetch('https://printpay.site/b2c/topup/stk_push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Wallet-ID': walletId,
        'X-Security-Credential': securityCredential,
      },
      body: JSON.stringify({
        phone,
        amount: Number(amount),
      }),
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    return { ok: response.ok, status: response.status, data };
  }

  // Fallback: Standard C2B endpoint
  const apiKey = process.env.PRINTPAY_API_KEY;
  if (!apiKey) {
    throw new Error('Missing PRINTPAY_API_KEY');
  }

  const formBody = new URLSearchParams({
    x_api_key: apiKey,
    phone_number: phone,
    amount: String(amount),
  });

  const response = await fetch('https://printpay.co.ke/api/stk_push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody.toString(),
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return { ok: response.ok, status: response.status, data };
}

async function runBatch(phones, amount, intervalSeconds) {
  isRunning = true;
  shouldStop = false;

  logEvent('INFO', `Starting STK batch`, {
    totalNumbers: phones.length,
    amountKES: amount,
    intervalSeconds,
    mode: process.env.PRINTPAY_MODE || 'WALLET',
  });

  for (let i = 0; i < phones.length; i++) {
    if (shouldStop) {
      logEvent('WARN', `Batch stopped manually at item ${i + 1}/${phones.length}`);
      break;
    }

    const phone = phones[i];
    logEvent('INFO', `[${i + 1}/${phones.length}] Sending STK Push to ${phone} for KES ${amount}`);

    try {
      const result = await sendStkPush(phone, amount);
      if (result.ok) {
        logEvent('SUCCESS', `[${i + 1}/${phones.length}] STK accepted for ${phone}`, result.data);
      } else {
        logEvent('ERROR', `[${i + 1}/${phones.length}] API rejected ${phone} (HTTP ${result.status})`, result.data);
      }
    } catch (err) {
      logEvent('ERROR', `[${i + 1}/${phones.length}] Request failed for ${phone}: ${err.message}`);
    }

    // Wait 3 seconds before the next request (skip wait after the final number)
    if (i < phones.length - 1 && !shouldStop) {
      logEvent('INFO', `Waiting ${intervalSeconds}s before next STK request...`);
      await sleep(intervalSeconds * 1000);
    }
  }

  logEvent('INFO', 'Batch execution finished.');
  isRunning = false;
}

// Optional callback receiver if you point PrintPay webhooks to https://<your-app>.onrender.com/api/callback
app.post('/api/callback', (req, res) => {
  logEvent('CALLBACK', 'Received PrintPay payment callback', req.body);
  res.status(200).json({ received: true });
});

app.post('/api/start', (req, res) => {
  const adminPass = process.env.ADMIN_PASSWORD;
  if (adminPass && req.headers['x-admin-password'] !== adminPass) {
    return res.status(401).json({ error: 'Invalid dashboard password.' });
  }

  if (isRunning) {
    return res.status(409).json({ error: 'A batch is already running.' });
  }

  const { numbers, amount } = req.body;
  const parsedAmount = Number(amount);

  if (!parsedAmount || parsedAmount < 1) {
    return res.status(400).json({ error: 'Amount must be at least 1 KES.' });
  }

  const rawList = String(numbers || '')
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const validPhones = [];
  const invalidPhones = [];

  for (const item of rawList) {
    const normalized = normalizeKenyanPhone(item);
    if (normalized) {
      validPhones.push(normalized);
    } else {
      invalidPhones.push(item);
    }
  }

  if (validPhones.length === 0) {
    return res.status(400).json({
      error: 'No valid Kenyan phone numbers found.',
      invalidPhones,
    });
  }

  // Run asynchronously so the HTTP request returns immediately
  runBatch(validPhones, parsedAmount, 3);

  return res.json({
    message: `Started sending ${validPhones.length} STK requests (3s apart).`,
    queued: validPhones.length,
    skippedInvalid: invalidPhones,
  });
});

app.post('/api/stop', (req, res) => {
  const adminPass = process.env.ADMIN_PASSWORD;
  if (adminPass && req.headers['x-admin-password'] !== adminPass) {
    return res.status(401).json({ error: 'Invalid dashboard password.' });
  }

  if (!isRunning) {
    return res.json({ message: 'No active batch running.' });
  }

  shouldStop = true;
  logEvent('WARN', 'Stop signal requested from UI.');
  return res.json({ message: 'Stopping after current request...' });
});

app.get('/api/status', (req, res) => {
  res.json({
    isRunning,
    logs: recentLogs,
  });
});

app.listen(PORT, '0.0.0.0', () => {
  logEvent('INFO', `PrintPay STK Bot server listening on port ${PORT}`);
});
