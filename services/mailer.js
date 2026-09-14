const nodemailer = require('nodemailer');
const { get, run } = require('../db');

let transporter;

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
        console.log('Text:', opts.text?.substring(0, 200));
        console.log('--- END ---');
        return { messageId: 'console-' + Date.now() };
      }
    };
  }
  return transporter;
}

function renderTemplate(templateStr, vars) {
  let result = templateStr;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value || '');
  }
  return result;
}

async function sendEmail(to, subject, html, text) {
  const t = getTransporter();
  try {
    await t.sendMail({
      from: process.env.SMTP_USER || 'noreply@communion-scheduler.fly.dev',
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

async function sendNotification(member, templateKey, vars, communionDateId) {
  const template = get('SELECT * FROM notification_templates WHERE template_key = ?', [templateKey]);
  if (!template) {
    console.error('[Mailer] Template not found:', templateKey);
    return;
  }

  const subject = renderTemplate(template.subject, vars);
  const html = renderTemplate(template.body_html, vars);
  const text = renderTemplate(template.body_text, vars);

  if (member.notify_email && member.email) {
    const result = await sendEmail(member.email, subject, html, text);
    run('INSERT INTO notification_log (member_id, communion_date_id, notification_type, channel, status, error_message) VALUES (?,?,?,?,?,?)',
      [member.id, communionDateId, templateKey, 'email', result.success ? 'sent' : 'failed', result.error || null]);
  }

  if (member.notify_sms && member.phone) {
    const result = await sendSms(member.phone, text);
    run('INSERT INTO notification_log (member_id, communion_date_id, notification_type, channel, status, error_message) VALUES (?,?,?,?,?,?)',
      [member.id, communionDateId, templateKey, 'sms', result.success ? 'sent' : 'failed', result.error || null]);
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
Communion Server Scheduling System
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

module.exports = { sendEmail, sendSms, sendNotification, renderTemplate };
