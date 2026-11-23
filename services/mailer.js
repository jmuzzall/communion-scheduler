const nodemailer = require('nodemailer');
const staging = require('../core/staging');

let transporter;

// ── Microsoft 365 (Graph) sending ─────────────────────────────
// Used when MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET and MAIL_FROM are all set: the app signs in as
// the church's app registration and sends from the MAIL_FROM mailbox. Otherwise SMTP (or the console).
function graphConfigured() {
  return !!(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET && process.env.MAIL_FROM);
}

let graphToken = null; // { value, expiresAt }

async function getGraphToken() {
  if (graphToken && graphToken.expiresAt > Date.now() + 60 * 1000) return graphToken.value;
  const resp = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(process.env.MS_TENANT_ID)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    // Microsoft's error text names the problem (wrong secret, expired secret, wrong tenant) without echoing the secret
    throw new Error(`Microsoft sign-in failed (${resp.status}): ${data.error || ''} ${String(data.error_description || '').split('\r\n')[0]}`.trim());
  }
  graphToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return graphToken.value;
}

async function sendViaGraph({ to, subject, html }) {
  const token = await getGraphToken();
  const recipients = String(to).split(',').map(a => a.trim()).filter(Boolean).map(address => ({ emailAddress: { address } }));
  const resp = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(process.env.MAIL_FROM)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: recipients },
      saveToSentItems: false,
    }),
  });
  if (resp.status === 401) graphToken = null; // try a fresh sign-in next time
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    const msg = data.error ? `${data.error.code}: ${data.error.message}` : `HTTP ${resp.status}`;
    throw new Error(`Microsoft send failed (${resp.status}): ${msg}`);
  }
}

function getTransporter() {
  if (transporter) return transporter;
  if (process.env.SMTP_HOST && process.env.SMTP_PASS && process.env.SMTP_PASS !== 'your-app-password') {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  } else {
    console.log('[Mailer] No SMTP configured — logging emails to console');
    transporter = {
      sendMail: async (opts) => {
        console.log('--- EMAIL ---');
        console.log('To:', opts.to);
        console.log('Subject:', opts.subject);
        console.log('Text:', opts.text);
        console.log('--- END ---');
        return { messageId: 'console-' + Date.now() };
      }
    };
  }
  return transporter;
}

async function sendEmail(to, subject, html, text) {
  if (staging.isStaging()) {
    const allowed = staging.filterRecipients(to);
    if (!allowed.length) {
      console.log(`[Staging] Email "${subject}" not sent: no tester among recipients`);
      return { success: true, suppressed: true };
    }
    to = allowed.join(', ');
  }
  if (graphConfigured()) {
    try {
      await sendViaGraph({ to, subject, html: wrapHtmlEmail(subject, html) });
      return { success: true };
    } catch (err) {
      console.error('[Mailer] Send failed:', err.message);
      return { success: false, error: err.message };
    }
  }
  const t = getTransporter();
  try {
    await t.sendMail({
      from: process.env.SMTP_USER || 'noreply@mpc-officer-service.fly.dev',
      to,
      subject,
      html: wrapHtmlEmail(subject, html),
      text,
    });
    return { success: true };
  } catch (err) {
    console.error('[Mailer] Send failed:', err.message);
    return { success: false, error: err.message };
  }
}

async function sendSms(phone, text) {
  if (staging.isStaging()) {
    console.log('[Staging] Text message not sent: SMS is off on the test copy');
    return { success: true, suppressed: true };
  }
  if (!process.env.TWILIO_SID || !process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_SID === 'your-twilio-account-sid') {
    console.log('[SMS] No Twilio configured — logging to console');
    console.log('--- SMS ---');
    console.log('To:', phone);
    console.log('Body:', text);
    console.log('--- END ---');
    return { success: true };
  }
  try {
    const accountSid = process.env.TWILIO_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_PHONE;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: phone, From: from, Body: text }),
    });
    if (!resp.ok) throw new Error(`Twilio ${resp.status}`);
    return { success: true };
  } catch (err) {
    console.error('[SMS] Send failed:', err.message);
    return { success: false, error: err.message };
  }
}

function wrapHtmlEmail(title, bodyContent) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:24px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
<tr><td style="background:#1B3A5C;padding:24px 32px;text-align:center;">
<h1 style="margin:0;color:#fff;font-size:20px;font-family:Georgia,serif;">McLean Presbyterian Church</h1>
<div style="width:40px;height:3px;background:#C5963A;margin:10px auto 0;border-radius:2px;"></div>
</td></tr>
<tr><td style="padding:32px;color:#2D3748;font-size:15px;line-height:1.6;">
${bodyContent}
</td></tr>
<tr><td style="background:#f7f4ee;padding:16px 32px;text-align:center;font-size:12px;color:#6b7280;">
MPC Officer Service
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function mailMethod() {
  if (graphConfigured()) return `Microsoft 365 (${process.env.MAIL_FROM})`;
  if (process.env.SMTP_HOST && process.env.SMTP_PASS && process.env.SMTP_PASS !== 'your-app-password') return `SMTP (${process.env.SMTP_HOST})`;
  return 'console only (no email configured)';
}

module.exports = { sendEmail, sendSms, mailMethod };
