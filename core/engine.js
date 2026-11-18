// Assignment rules shared by every sign-up ministry: sign-up, withdraw, auto-fill, staff edits and swaps.
const { get, all, run, transaction, lastId } = require('../db');
const { isEligible, MINISTRY_NAMES } = require('./eligibility');
const cal = require('./calendar');
const { emailPerson, emailStaff, appUrl } = require('./notify');

const SIGNUP_WINDOW_MONTHS = 3;
const CROSS_CAMPUS_GAP_MINUTES = 90;

// ─── Positions and time clashes ─────────────────────
function minutesOf(t) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(t || '').trim());
  if (!m) return null;
  return ((parseInt(m[1], 10) % 12) + (m[3].toUpperCase() === 'PM' ? 12 : 0)) * 60 + parseInt(m[2], 10);
}

// Same service time always clashes; Herndon and McLean slots under 90 minutes apart also clash.
function positionsClash(a, b) {
  if (!a.service_time || !b.service_time) return false;
  if (a.service_time === b.service_time) return true;
  if (a.campus === b.campus) return false;
  const ma = minutesOf(a.service_time), mb = minutesOf(b.service_time);
  return ma !== null && mb !== null && Math.abs(ma - mb) < CROSS_CAMPUS_GAP_MINUTES;
}

function describePosition(p) {
  return [p.service_time, `${p.campus}${p.area ? ' ' + p.area : ''}`].filter(Boolean).join(' · ');
}

// ─── Lookups ────────────────────────────────────────
function getEvent(id) {
  return get(`SELECT e.*, d.date, d.label AS day_label FROM ministry_events e JOIN service_days d ON d.id = e.service_day_id WHERE e.id = ?`, [id]);
}

function eventPositions(event) {
  return event.kind === 'special'
    ? all('SELECT * FROM positions WHERE event_id = ? AND active = 1 ORDER BY sort_order', [event.id])
    : all('SELECT * FROM positions WHERE ministry = ? AND event_id IS NULL AND active = 1 ORDER BY sort_order', [event.ministry]);
}

function eventAssignments(eventId) {
  return all(`SELECT a.*, p.name AS person_name, p.email AS person_email FROM assignments a
              JOIN people p ON p.id = a.person_id WHERE a.event_id = ? ORDER BY p.name`, [eventId]);
}

function eventSlots(event) {
  const assigned = eventAssignments(event.id);
  const covers = new Map(all('SELECT * FROM covered_slots WHERE event_id = ?', [event.id]).map(c => [c.position_id, c]));
  return eventPositions(event).map(pos => {
    const people = assigned.filter(a => a.position_id === pos.id);
    const cover = covers.get(pos.id) || null;
    return {
      ...pos, assigned: people, filled: people.length,
      covered: cover ? cover.covered_by : null,
      open: cover ? 0 : Math.max(0, pos.needed - people.length),
    };
  });
}

function coveredBy(eventId, positionId) {
  const c = get('SELECT covered_by FROM covered_slots WHERE event_id = ? AND position_id = ?', [eventId, positionId]);
  return c ? c.covered_by : null;
}

function dayAssignments(personId, serviceDayId) {
  return all(`SELECT a.*, pos.service_time, pos.campus, pos.area, e.ministry, e.id AS event_id
              FROM assignments a JOIN positions pos ON pos.id = a.position_id
              JOIN ministry_events e ON e.id = a.event_id
              WHERE a.person_id = ? AND e.service_day_id = ?`, [personId, serviceDayId]);
}

function awayStatus(personId, serviceDayId, ministry) {
  const away = get('SELECT * FROM unavailability WHERE person_id = ? AND service_day_id = ?', [personId, serviceDayId]);
  if (!away) return { away: false, blocked: false };
  const exception = !!get('SELECT 1 FROM availability_exceptions WHERE person_id = ? AND service_day_id = ? AND ministry = ?',
    [personId, serviceDayId, ministry]);
  return { away: true, blocked: !exception, reason: away.reason };
}

function isOpen(event) {
  const today = cal.todayIso();
  return event.kind === 'regular' && event.status === 'upcoming' &&
    event.date > today && event.date <= cal.addMonths(today, SIGNUP_WINDOW_MONTHS);
}

function upcomingEvents(ministry, fromIso, toIso) {
  return all(`SELECT e.*, d.date, d.label AS day_label FROM ministry_events e JOIN service_days d ON d.id = e.service_day_id
              WHERE e.ministry = ? AND d.date >= ? AND d.date <= ? ORDER BY d.date`, [ministry, fromIso, toIso]);
}

function logChange(eventId, assignmentId, actorId, action, details) {
  run('INSERT INTO assignment_changes (event_id, assignment_id, changed_by, action, details) VALUES (?,?,?,?,?)',
    [eventId, assignmentId, actorId, action, JSON.stringify(details || {})]);
}

// ─── Sign-up rules ──────────────────────────────────
// Returns { error, away, warning } describing why a person can't take a position, or {} if they can.
function signupProblem(person, event, position, { confirmOverlap = false } = {}) {
  if (!isEligible(person, event.ministry)) return { error: `You aren't on the ${MINISTRY_NAMES[event.ministry]} roster.` };
  if (!isOpen(event)) return { error: 'Sign-up for this Sunday is closed.' };
  if (!eventPositions(event).some(p => p.id === position.id)) return { error: 'That position is not part of this Sunday.' };
  const cover = coveredBy(event.id, position.id);
  if (cover) return { error: `${cover} is covering that slot, so no sign-up is needed.` };
  const mine = dayAssignments(person.id, event.service_day_id);
  if (mine.some(a => a.event_id === event.id && a.position_id === position.id)) return { error: "You're already signed up for that slot." };
  const sameMinistry = mine.find(a => a.ministry === event.ministry && positionsClash(a, position));
  if (sameMinistry) return { error: `You're already serving ${describePosition(sameMinistry)}. Withdraw from that slot first to switch.` };
  const filled = get('SELECT COUNT(*) AS c FROM assignments WHERE event_id = ? AND position_id = ?', [event.id, position.id]).c;
  if (filled >= position.needed) return { error: 'That slot is already full.' };
  if (awayStatus(person.id, event.service_day_id, event.ministry).blocked) return { away: true, error: 'You marked this Sunday away.' };
  const otherMinistry = mine.find(a => a.ministry !== event.ministry && positionsClash(a, position));
  if (otherMinistry && !confirmOverlap) {
    return { warning: `You're also serving ${MINISTRY_NAMES[otherMinistry.ministry]} at ${describePosition(otherMinistry)}.` };
  }
  return {};
}

function claim(person, eventId, positionId, opts = {}) {
  return transaction(() => {
    const event = getEvent(eventId);
    const position = event && get('SELECT * FROM positions WHERE id = ?', [positionId]);
    if (!event || !position) return { error: 'That slot was not found.' };
    const problem = signupProblem(person, event, position, opts);
    if (problem.error || problem.warning) return problem;
    run("INSERT INTO assignments (event_id, position_id, person_id, type) VALUES (?,?,?,'voluntary')", [event.id, position.id, person.id]);
    const id = lastId();
    logChange(event.id, id, person.id, 'signup', { person: person.name, position: describePosition(position) });
    return { ok: true };
  });
}

function withdraw(person, assignmentId) {
  return transaction(() => {
    const a = get('SELECT * FROM assignments WHERE id = ? AND person_id = ?', [assignmentId, person.id]);
    if (!a) return { error: 'That assignment was not found.' };
    const event = getEvent(a.event_id);
    if (!isOpen(event) || a.type !== 'voluntary') return { error: 'Sign-up is closed for this Sunday. Propose a swap instead.' };
    run('DELETE FROM assignments WHERE id = ?', [a.id]);
    logChange(event.id, a.id, person.id, 'withdraw', { person: person.name });
    return { ok: true };
  });
}

function optIn(person, eventId) {
  const event = getEvent(eventId);
  if (!event) return;
  run('INSERT OR IGNORE INTO availability_exceptions (person_id, service_day_id, ministry) VALUES (?,?,?)',
    [person.id, event.service_day_id, event.ministry]);
}

// ─── Auto-fill ──────────────────────────────────────
// Fills open slots: active elders, active deacons, inactive elders, then inactive deacons; then people
// whose preferred campus matches; then whoever has served least across all ministries in the last 12 months.
const PRIORITY = p => (p.active ? 0 : 2) + (p.office === 'elder' ? 0 : 1);

function autofill(eventId, actorId = null) {
  const event = getEvent(eventId);
  if (!event) throw new Error('Event not found');
  const yearAgo = cal.addDays(cal.todayIso(), -365);
  const counts = Object.fromEntries(all(`SELECT a.person_id, COUNT(*) AS c FROM assignments a
      JOIN ministry_events e ON e.id = a.event_id JOIN service_days d ON d.id = e.service_day_id
      WHERE d.date >= ? GROUP BY a.person_id`, [yearAgo]).map(r => [r.person_id, r.c]));
  const people = all('SELECT * FROM people').filter(p => isEligible(p, event.ministry));
  const added = [];

  // Fill the campus with fewer interested people first, so Herndon officers aren't used up by McLean slots.
  const campusOf = p => p.preferred_campus || p.home_campus;
  const interest = campus => people.filter(p => campusOf(p) === campus).length;
  const slots = eventSlots(event).sort((a, b) => (interest(a.campus) - interest(b.campus)) || (a.sort_order - b.sort_order));

  transaction(() => {
    const takenToday = new Set(eventAssignments(event.id).map(a => a.person_id));
    for (const slot of slots) {
      for (let i = 0; i < slot.open; i++) {
        const candidates = people.filter(p => {
          if (takenToday.has(p.id)) return false;
          if (awayStatus(p.id, event.service_day_id, event.ministry).blocked) return false;
          return !dayAssignments(p.id, event.service_day_id).some(a => positionsClash(a, slot));
        }).sort((a, b) =>
          (PRIORITY(a) - PRIORITY(b)) ||
          ((campusOf(a) === slot.campus ? 0 : 1) - (campusOf(b) === slot.campus ? 0 : 1)) ||
          ((counts[a.id] || 0) - (counts[b.id] || 0)) ||
          (Math.random() - 0.5));
        const chosen = candidates[0];
        if (!chosen) break;
        run("INSERT INTO assignments (event_id, position_id, person_id, type) VALUES (?,?,?,'auto')", [event.id, slot.id, chosen.id]);
        logChange(event.id, lastId(), actorId, 'autofill', { person: chosen.name, position: describePosition(slot) });
        takenToday.add(chosen.id);
        counts[chosen.id] = (counts[chosen.id] || 0) + 1;
        added.push({ person: chosen, position: slot });
      }
    }
    run("UPDATE ministry_events SET status = 'filled' WHERE id = ?", [event.id]);
  });
  return { event, added };
}

async function sendAssignmentNotices(event, added) {
  for (const { person, position } of added) {
    await emailPerson(person, `You're serving ${MINISTRY_NAMES[event.ministry]} on ${cal.formatDay(event.date)}`, [
      `Hi ${person.name},`,
      `You've been assigned to serve ${MINISTRY_NAMES[event.ministry].toLowerCase()} on ${cal.formatLongDay(event.date)}: ${describePosition(position)}.`,
      "If you can't serve, propose a swap with another officer in MPC Officer Service.",
    ], { url: `${appUrl()}/me`, label: 'View My Sundays' });
  }
}

// ─── Staff edits ────────────────────────────────────
function staffAssign(actor, eventId, positionId, personId, allowConflict) {
  const event = getEvent(eventId);
  const position = event && get('SELECT * FROM positions WHERE id = ?', [positionId]);
  const person = get('SELECT * FROM people WHERE id = ?', [personId]);
  if (!event || !position || !person) return { error: 'Choose a person and a slot.' };
  if (!isEligible(person, event.ministry)) return { error: `${person.name} isn't on the ${MINISTRY_NAMES[event.ministry]} roster.` };
  if (!eventPositions(event).some(p => p.id === position.id)) return { error: 'That position is not part of this Sunday.' };
  const cover = coveredBy(event.id, position.id);
  if (cover) return { error: `${cover} is covering that slot. Remove the cover first to assign someone.` };
  const mine = dayAssignments(person.id, event.service_day_id);
  if (mine.some(a => a.event_id === event.id && a.position_id === position.id)) return { error: `${person.name} is already in that slot.` };
  const filled = get('SELECT COUNT(*) AS c FROM assignments WHERE event_id = ? AND position_id = ?', [event.id, position.id]).c;
  if (filled >= position.needed) return { error: `${describePosition(position)} is already full.` };
  const clash = mine.find(a => positionsClash(a, position));
  const away = awayStatus(person.id, event.service_day_id, event.ministry);
  if (!allowConflict && clash) {
    return { error: `${person.name} is already serving ${MINISTRY_NAMES[clash.ministry]} at ${describePosition(clash)}. Remove that first, or tick "Allow anyway".` };
  }
  if (!allowConflict && away.blocked) return { error: `${person.name} marked this Sunday away. Tick "Allow anyway" to assign them regardless.` };
  transaction(() => {
    run("INSERT INTO assignments (event_id, position_id, person_id, type) VALUES (?,?,?,'staff')", [event.id, position.id, person.id]);
    logChange(event.id, lastId(), actor.id, 'staff_assign', { person: person.name, position: describePosition(position), override: !!(clash || away.blocked) });
  });
  emailPerson(person, `You're serving ${MINISTRY_NAMES[event.ministry]} on ${cal.formatDay(event.date)}`, [
    `Hi ${person.name},`,
    `${actor.name} assigned you to serve ${MINISTRY_NAMES[event.ministry].toLowerCase()} on ${cal.formatLongDay(event.date)}: ${describePosition(position)}.`,
  ], { url: `${appUrl()}/me`, label: 'View My Sundays' });
  return { ok: true, warning: clash || away.blocked ? `${person.name} is now double-booked or marked away that day.` : null };
}

function staffRemove(actor, assignmentId) {
  const a = get(`SELECT a.*, p.name AS person_name FROM assignments a JOIN people p ON p.id = a.person_id WHERE a.id = ?`, [assignmentId]);
  if (!a) return { error: 'That assignment was not found.' };
  const event = getEvent(a.event_id);
  const position = get('SELECT * FROM positions WHERE id = ?', [a.position_id]);
  const person = get('SELECT * FROM people WHERE id = ?', [a.person_id]);
  transaction(() => {
    run(`UPDATE swaps SET status = 'cancelled', reason = 'Staff changed the schedule', resolved_at = datetime('now')
         WHERE status = 'pending' AND (requester_assignment_id = ? OR target_assignment_id = ?)`, [a.id, a.id]);
    run('DELETE FROM assignments WHERE id = ?', [a.id]);
    logChange(event.id, a.id, actor.id, 'staff_remove', { person: a.person_name, position: describePosition(position) });
  });
  emailPerson(person, `Change to your ${MINISTRY_NAMES[event.ministry]} schedule`, [
    `Hi ${person.name},`,
    `${actor.name} removed you from ${MINISTRY_NAMES[event.ministry].toLowerCase()} on ${cal.formatLongDay(event.date)} (${describePosition(position)}).`,
  ], { url: `${appUrl()}/me`, label: 'View My Sundays' });
  return { ok: true, name: a.person_name };
}

// ─── Pastor-covered slots ───────────────────────────
// Marks positions as covered (for example by a pastor). If anyone is already signed up for them,
// returns { needsConfirm, affected } until the caller confirms; then removes and emails them.
async function coverSlots(actor, eventId, positionIds, coverName, confirm) {
  const event = getEvent(eventId);
  if (!event) return { error: 'That Sunday was not found.' };
  const name = String(coverName || '').trim().slice(0, 80);
  if (!name) return { error: "Enter who's covering, for example Pastor Hart." };
  const valid = eventPositions(event).filter(p => positionIds.map(Number).includes(p.id));
  if (!valid.length) return { error: 'Choose at least one slot to cover.' };
  const ids = valid.map(p => p.id);
  const affected = eventAssignments(event.id).filter(a => ids.includes(a.position_id));
  if (affected.length && !confirm) return { needsConfirm: true, affected, positions: valid, name };

  transaction(() => {
    for (const a of affected) {
      run(`UPDATE swaps SET status = 'cancelled', reason = 'Slot covered by a pastor', resolved_at = datetime('now')
           WHERE status = 'pending' AND (requester_assignment_id = ? OR target_assignment_id = ?)`, [a.id, a.id]);
      run('DELETE FROM assignments WHERE id = ?', [a.id]);
      logChange(event.id, a.id, actor.id, 'cover_remove', { person: a.person_name, position: describePosition(valid.find(p => p.id === a.position_id)) });
    }
    for (const p of valid) {
      run('INSERT OR REPLACE INTO covered_slots (event_id, position_id, covered_by, created_by) VALUES (?,?,?,?)', [event.id, p.id, name, actor.id]);
      logChange(event.id, null, actor.id, 'cover', { person: name, position: describePosition(p) });
    }
  });

  for (const a of affected) {
    const person = get('SELECT * FROM people WHERE id = ?', [a.person_id]);
    const pos = valid.find(p => p.id === a.position_id);
    await emailPerson(person, `No need to serve ${MINISTRY_NAMES[event.ministry]} on ${cal.formatDay(event.date)}`, [
      `Hi ${person.name},`,
      `${name} is covering ${MINISTRY_NAMES[event.ministry].toLowerCase()} on ${cal.formatLongDay(event.date)} (${describePosition(pos)}), so you've been taken off that slot. Thank you for signing up.`,
    ], { url: `${appUrl()}/me`, label: 'View My Sundays' });
  }
  return { ok: true, count: valid.length, removed: affected.length };
}

function uncoverSlot(actor, eventId, positionId) {
  const cover = get('SELECT * FROM covered_slots WHERE event_id = ? AND position_id = ?', [eventId, positionId]);
  if (!cover) return { error: 'That slot is not covered.' };
  const position = get('SELECT * FROM positions WHERE id = ?', [positionId]);
  transaction(() => {
    run('DELETE FROM covered_slots WHERE id = ?', [cover.id]);
    logChange(Number(eventId), null, actor.id, 'uncover', { person: cover.covered_by, position: describePosition(position) });
  });
  return { ok: true };
}

// ─── Swaps ──────────────────────────────────────────
function assignmentDetail(id) {
  return get(`SELECT a.*, e.ministry, e.service_day_id, d.date, pos.service_time, pos.campus, pos.area, pos.needed,
                p.name AS person_name
              FROM assignments a JOIN ministry_events e ON e.id = a.event_id JOIN service_days d ON d.id = e.service_day_id
              JOIN positions pos ON pos.id = a.position_id JOIN people p ON p.id = a.person_id WHERE a.id = ?`, [id]);
}

// Would giving `incoming` to `personId` (while they give up `outgoing`) double-book or conflict with an away day?
function takeProblem(personId, name, outgoing, incoming) {
  const self = name === 'You';
  const away = awayStatus(personId, incoming.service_day_id, incoming.ministry);
  if (away.blocked) return `${self ? "You're" : name + ' is'} marked away on ${cal.formatDay(incoming.date)}.`;
  const clash = dayAssignments(personId, incoming.service_day_id)
    .find(a => a.id !== outgoing.id && a.ministry === incoming.ministry && positionsClash(a, incoming));
  if (clash) return `${self ? "You're" : name + ' is'} already serving ${describePosition(clash)} on ${cal.formatDay(incoming.date)}.`;
  return null;
}

function swapProblem(reqA, tgtA, requesterName, targetName) {
  const today = cal.todayIso();
  if (!reqA || !tgtA) return 'One of those assignments no longer exists.';
  if (reqA.ministry !== tgtA.ministry) return 'Swaps stay within one ministry.';
  if (reqA.person_id === tgtA.person_id) return "You can't swap with yourself.";
  if (reqA.date <= today || tgtA.date <= today) return 'Only upcoming Sundays can be swapped.';
  const pending = get(`SELECT 1 FROM swaps WHERE status = 'pending' AND (requester_assignment_id IN (?, ?) OR target_assignment_id IN (?, ?))`,
    [reqA.id, tgtA.id, reqA.id, tgtA.id]);
  if (pending) return 'One of these assignments already has a pending swap.';
  return takeProblem(reqA.person_id, requesterName, reqA, tgtA) || takeProblem(tgtA.person_id, targetName, tgtA, reqA);
}

function swapCandidates(person, assignmentId) {
  const mine = assignmentDetail(assignmentId);
  if (!mine || mine.person_id !== person.id) return null;
  const others = all(`SELECT a.id FROM assignments a JOIN ministry_events e ON e.id = a.event_id JOIN service_days d ON d.id = e.service_day_id
                      WHERE e.ministry = ? AND d.date > ? AND a.person_id != ? ORDER BY d.date`, [mine.ministry, cal.todayIso(), person.id])
    .map(r => assignmentDetail(r.id));
  return {
    mine,
    others: others.map(o => ({ ...o, position: describePosition(o), blockReason: swapProblem(mine, o, 'You', o.person_name) })),
  };
}

async function proposeSwap(person, myAssignmentId, theirAssignmentId, message) {
  const mine = assignmentDetail(myAssignmentId);
  const theirs = assignmentDetail(theirAssignmentId);
  if (!mine || mine.person_id !== person.id) return { error: 'That is not your assignment.' };
  const problem = swapProblem(mine, theirs, 'You', theirs ? theirs.person_name : '');
  if (problem) return { error: problem };
  run(`INSERT INTO swaps (ministry, requester_id, requester_assignment_id, target_id, target_assignment_id, message) VALUES (?,?,?,?,?,?)`,
    [mine.ministry, person.id, mine.id, theirs.person_id, theirs.id, String(message || '').trim().slice(0, 300) || null]);
  const target = get('SELECT * FROM people WHERE id = ?', [theirs.person_id]);
  await emailPerson(target, `${person.name} would like to swap ${MINISTRY_NAMES[mine.ministry]} Sundays`, [
    `Hi ${target.name},`,
    `${person.name} offers their ${MINISTRY_NAMES[mine.ministry].toLowerCase()} slot on ${cal.formatLongDay(mine.date)} (${describePosition(mine)}) in exchange for yours on ${cal.formatLongDay(theirs.date)} (${describePosition(theirs)}).`,
    ...(message ? [`Message: ${String(message).trim().slice(0, 300)}`] : []),
  ], { url: `${appUrl()}/swaps`, label: 'Review the swap' });
  return { ok: true, name: target.name };
}

async function acceptSwap(person, swapId) {
  const swap = get("SELECT * FROM swaps WHERE id = ? AND target_id = ? AND status = 'pending'", [swapId, person.id]);
  if (!swap) return { error: 'That swap was not found or was already answered.' };
  const reqA = assignmentDetail(swap.requester_assignment_id);
  const tgtA = assignmentDetail(swap.target_assignment_id);
  const requester = get('SELECT * FROM people WHERE id = ?', [swap.requester_id]);
  run("UPDATE swaps SET status = 'cancelled', resolved_at = datetime('now') WHERE id = ?", [swap.id]);
  const problem = swapProblem(reqA, tgtA, requester.name, 'You');
  if (problem) {
    run('UPDATE swaps SET reason = ? WHERE id = ?', [problem, swap.id]);
    await emailPerson(requester, 'Your swap could not go through', [
      `Hi ${requester.name},`,
      `Your swap with ${person.name} was cancelled: ${swapProblem(reqA, tgtA, 'You', person.name)}`,
    ], { url: `${appUrl()}/swaps`, label: 'View swaps' });
    return { error: `This swap was cancelled because it no longer works: ${problem}` };
  }
  transaction(() => {
    run("UPDATE assignments SET person_id = ?, type = 'swapped' WHERE id = ?", [tgtA.person_id, reqA.id]);
    run("UPDATE assignments SET person_id = ?, type = 'swapped' WHERE id = ?", [reqA.person_id, tgtA.id]);
    run("UPDATE swaps SET status = 'accepted', resolved_at = datetime('now') WHERE id = ?", [swap.id]);
    logChange(reqA.event_id, reqA.id, person.id, 'swap', { from: requester.name, to: person.name, position: describePosition(reqA) });
    logChange(tgtA.event_id, tgtA.id, person.id, 'swap', { from: person.name, to: requester.name, position: describePosition(tgtA) });
  });
  const ministry = MINISTRY_NAMES[reqA.ministry];
  await emailPerson(requester, `Swap accepted: ${ministry}`, [
    `Hi ${requester.name},`,
    `${person.name} accepted your swap. You now serve ${ministry.toLowerCase()} on ${cal.formatLongDay(tgtA.date)} (${describePosition(tgtA)}), and ${person.name} takes ${cal.formatLongDay(reqA.date)}.`,
  ], { url: `${appUrl()}/me`, label: 'View My Sundays' });
  await emailStaff(`${ministry} swap: ${requester.name} and ${person.name}`, [
    `${requester.name} and ${person.name} swapped ${ministry.toLowerCase()} Sundays.`,
    `${person.name} now serves ${cal.formatLongDay(reqA.date)} (${describePosition(reqA)}).`,
    `${requester.name} now serves ${cal.formatLongDay(tgtA.date)} (${describePosition(tgtA)}).`,
  ], { url: `${appUrl()}/admin/${reqA.ministry}`, label: 'Open the schedule' });
  return { ok: true };
}

async function declineSwap(person, swapId) {
  const swap = get("SELECT * FROM swaps WHERE id = ? AND target_id = ? AND status = 'pending'", [swapId, person.id]);
  if (!swap) return { error: 'That swap was not found or was already answered.' };
  run("UPDATE swaps SET status = 'declined', resolved_at = datetime('now') WHERE id = ?", [swap.id]);
  const requester = get('SELECT * FROM people WHERE id = ?', [swap.requester_id]);
  await emailPerson(requester, 'Your swap was declined', [
    `Hi ${requester.name},`,
    `${person.name} declined your swap request. You can offer your slot to someone else.`,
  ], { url: `${appUrl()}/swaps`, label: 'View swaps' });
  return { ok: true };
}

function cancelSwap(person, swapId) {
  run("UPDATE swaps SET status = 'cancelled', resolved_at = datetime('now') WHERE id = ? AND requester_id = ? AND status = 'pending'", [swapId, person.id]);
}

function swapsFor(personId) {
  return all('SELECT * FROM swaps WHERE requester_id = ? OR target_id = ? ORDER BY created_at DESC', [personId, personId]).map(s => {
    const r = assignmentDetail(s.requester_assignment_id), t = assignmentDetail(s.target_assignment_id);
    const names = get('SELECT (SELECT name FROM people WHERE id = ?) AS rn, (SELECT name FROM people WHERE id = ?) AS tn', [s.requester_id, s.target_id]);
    return {
      ...s, requester_name: names.rn, target_name: names.tn, ministry_name: MINISTRY_NAMES[s.ministry],
      requester_slot: r ? `${cal.formatDay(r.date)} · ${describePosition(r)}` : '(no longer scheduled)',
      target_slot: t ? `${cal.formatDay(t.date)} · ${describePosition(t)}` : '(no longer scheduled)',
    };
  });
}

// Upcoming assignments for one person across every ministry.
function upcomingFor(personId, fromIso, toIso) {
  return all(`SELECT a.*, e.ministry, d.date, pos.service_time, pos.campus, pos.area FROM assignments a
              JOIN ministry_events e ON e.id = a.event_id JOIN service_days d ON d.id = e.service_day_id
              JOIN positions pos ON pos.id = a.position_id
              WHERE a.person_id = ? AND d.date >= ? AND d.date <= ? ORDER BY d.date, pos.sort_order`, [personId, fromIso, toIso]);
}

module.exports = {
  SIGNUP_WINDOW_MONTHS, positionsClash, describePosition, getEvent, eventPositions, eventSlots, eventAssignments,
  dayAssignments, awayStatus, isOpen, upcomingEvents, signupProblem, claim, withdraw, optIn,
  autofill, sendAssignmentNotices, staffAssign, staffRemove, coverSlots, uncoverSlot,
  swapCandidates, proposeSwap, acceptSwap, declineSwap, cancelSwap, swapsFor, upcomingFor, assignmentDetail,
};
