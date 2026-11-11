const { get, all } = require('../db');

// Herndon 10:45 vs McLean 11:15 can't both be served; McLean 8:45 vs Herndon 10:45 can.
const CROSS_CAMPUS_GAP_MINUTES = 90;

function minutesOf(serviceTime) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec((serviceTime || '').trim());
  if (!m) return null;
  let hours = parseInt(m[1], 10) % 12;
  if (m[3].toUpperCase() === 'PM') hours += 12;
  return hours * 60 + parseInt(m[2], 10);
}

function campusOf(location) {
  return (location || '').split(' ')[0];
}

function slotsClash(a, b) {
  if (a.service_time === b.service_time) return true;
  if (campusOf(a.location) === campusOf(b.location)) return false;
  const ma = minutesOf(a.service_time);
  const mb = minutesOf(b.service_time);
  return ma !== null && mb !== null && Math.abs(ma - mb) < CROSS_CAMPUS_GAP_MINUTES;
}

function describeSlot(s) {
  return `${s.service_time} (${s.location}${s.area ? ', ' + s.area : ''})`;
}

function memberAssignmentsOn(memberId, communionDateId) {
  return all(
    `SELECT a.id, a.slot_config_id, sc.service_time, sc.location, sc.area
     FROM assignments a JOIN slot_config sc ON a.slot_config_id = sc.id
     WHERE a.member_id = ? AND a.communion_date_id = ?`,
    [memberId, communionDateId]
  );
}

function findTimeConflict(memberId, communionDateId, slotConfigId, ignoreAssignmentIds = []) {
  const slot = get('SELECT * FROM slot_config WHERE id = ?', [slotConfigId]);
  if (!slot) return null;
  const ignore = ignoreAssignmentIds.map(Number);
  return memberAssignmentsOn(memberId, communionDateId)
    .find(a => !ignore.includes(a.id) && slotsClash(a, slot)) || null;
}

function subject(name) {
  return name === 'You' ? "You're" : `${name} is`;
}

// Returns a reason string if swapping the two assignments would double-book either person.
function tradeConflict(reqA, tgtA, requesterName, targetName) {
  const reqClash = findTimeConflict(reqA.member_id, reqA.communion_date_id, tgtA.slot_config_id, [reqA.id]);
  if (reqClash) return `${subject(requesterName)} also serving ${describeSlot(reqClash)} that day.`;
  const tgtClash = findTimeConflict(tgtA.member_id, tgtA.communion_date_id, reqA.slot_config_id, [tgtA.id]);
  if (tgtClash) return `${subject(targetName)} also serving ${describeSlot(tgtClash)} that day.`;
  return null;
}

function findDateConflicts(communionDateId) {
  const rows = all(
    `SELECT a.id, a.member_id, m.name, sc.service_time, sc.location, sc.area
     FROM assignments a
     JOIN members m ON a.member_id = m.id
     JOIN slot_config sc ON a.slot_config_id = sc.id
     WHERE a.communion_date_id = ?
     ORDER BY m.name, sc.sort_order`,
    [communionDateId]
  );
  const byMember = new Map();
  for (const r of rows) {
    if (!byMember.has(r.member_id)) byMember.set(r.member_id, []);
    byMember.get(r.member_id).push(r);
  }
  const conflicts = [];
  const assignmentIds = new Set();
  for (const list of byMember.values()) {
    const clashing = list.filter(a => list.some(b => b !== a && slotsClash(a, b)));
    if (clashing.length) {
      conflicts.push({ name: clashing[0].name, slots: clashing.map(describeSlot) });
      clashing.forEach(a => assignmentIds.add(a.id));
    }
  }
  return { conflicts, assignmentIds };
}

module.exports = { slotsClash, describeSlot, findTimeConflict, tradeConflict, findDateConflicts };
