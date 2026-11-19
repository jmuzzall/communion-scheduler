const { all } = require('../db');
const { sendEmail } = require('../services/mailer');

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function appUrl() {
  return process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
}

// paragraphs: plain-text strings; each becomes a <p> in HTML and a line in text.
async function emailPerson(person, subject, paragraphs, link) {
  if (!person || !person.notify_email) return;
  await emailAddress(person.email, subject, paragraphs, link);
}

async function emailAddress(address, subject, paragraphs, link) {
  const html = paragraphs.map(p => `<p>${escapeHtml(p)}</p>`).join('') +
    (link ? `<p><a href="${link.url}" style="display:inline-block;padding:10px 20px;background:#C5963A;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;">${escapeHtml(link.label)}</a></p>` : '');
  const text = paragraphs.join('\n\n') + (link ? `\n\n${link.label}: ${link.url}` : '');
  await sendEmail(address, subject, html, text);
}

function staffRecipients() {
  return all(`SELECT DISTINCT p.* FROM people p JOIN role_grants r ON r.person_id = p.id
              WHERE r.role IN ('staff','super') AND p.notify_email = 1`);
}

async function emailStaff(subject, paragraphs, link) {
  for (const s of staffRecipients()) await emailPerson(s, subject, paragraphs, link);
}

module.exports = { emailPerson, emailAddress, emailStaff, escapeHtml, appUrl };
