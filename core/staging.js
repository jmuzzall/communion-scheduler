// When STAGING_ALLOWED_EMAILS is set (comma-separated), the app is a test copy holding real
// roster data: only listed people may sign in, and email goes only to them.
function allowedEmails() {
  return (process.env.STAGING_ALLOWED_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
}

function isStaging() {
  return allowedEmails().length > 0;
}

function isAllowed(email) {
  if (!isStaging()) return true;
  return allowedEmails().includes(String(email || '').trim().toLowerCase());
}

function filterRecipients(to) {
  const list = Array.isArray(to) ? to : String(to || '').split(',');
  return list.map(e => e.trim()).filter(Boolean).filter(isAllowed);
}

module.exports = { isStaging, isAllowed, filterRecipients };
