const { get, all, run, save, getCategoryPriority } = require('../db');

function autoAssign(communionDateId) {
  const cd = get('SELECT * FROM communion_dates WHERE id = ?', [communionDateId]);
  if (!cd) throw new Error('Communion date not found');

  const slots = all('SELECT * FROM slot_config ORDER BY sort_order');
  const assigned = [];

  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const yearAgoStr = oneYearAgo.toISOString().split('T')[0];

  const alreadyAssigned = all(
    'SELECT member_id FROM assignments WHERE communion_date_id = ?', [communionDateId]
  ).map(r => r.member_id);

  const fullDayExclusions = all(
    'SELECT member_id FROM exclusions WHERE communion_date_id = ? AND exclusion_type = ?',
    [communionDateId, 'full_day']
  ).map(r => r.member_id);

  const serviceExclusions = all(
    'SELECT member_id, exclusion_value FROM exclusions WHERE communion_date_id = ? AND exclusion_type = ?',
    [communionDateId, 'service_time']
  );

  const locationExclusions = all(
    'SELECT member_id, exclusion_value FROM exclusions WHERE communion_date_id = ? AND exclusion_type = ?',
    [communionDateId, 'location']
  );

  const members = all('SELECT * FROM members ORDER BY id');

  const serviceCounts = {};
  for (const m of members) {
    const count = get(
      `SELECT COUNT(*) as c FROM assignments a
       JOIN communion_dates cd ON a.communion_date_id = cd.id
       WHERE a.member_id = ? AND cd.date >= ?`,
      [m.id, yearAgoStr]
    );
    serviceCounts[m.id] = count ? count.c : 0;
  }

  const assignedThisRound = new Set(alreadyAssigned);
  const excludedFullDay = new Set(fullDayExclusions);

  for (const slot of slots) {
    const currentCount = all(
      'SELECT COUNT(*) as c FROM assignments WHERE communion_date_id = ? AND slot_config_id = ?',
      [communionDateId, slot.id]
    );
    const filled = currentCount.length > 0 ? currentCount[0].c : 0;
    const needed = slot.servers_needed - filled;

    for (let i = 0; i < needed; i++) {
      const eligible = members.filter(m => {
        if (assignedThisRound.has(m.id)) return false;
        if (excludedFullDay.has(m.id)) return false;
        if (serviceExclusions.some(e => e.member_id === m.id && e.exclusion_value === slot.service_time)) return false;
        if (locationExclusions.some(e => e.member_id === m.id && e.exclusion_value === slot.location)) return false;
        return true;
      });

      eligible.sort((a, b) => {
        const pa = getCategoryPriority(a.category);
        const pb = getCategoryPriority(b.category);
        if (pa !== pb) return pa - pb;
        const ca = serviceCounts[a.id] || 0;
        const cb = serviceCounts[b.id] || 0;
        if (ca !== cb) return ca - cb;
        return Math.random() - 0.5;
      });

      if (eligible.length > 0) {
        const chosen = eligible[0];
        run(
          'INSERT INTO assignments (member_id, communion_date_id, slot_config_id, assignment_type, member_category_at_assignment) VALUES (?,?,?,?,?)',
          [chosen.id, communionDateId, slot.id, 'auto', chosen.category]
        );
        assignedThisRound.add(chosen.id);
        serviceCounts[chosen.id] = (serviceCounts[chosen.id] || 0) + 1;
        assigned.push({ member: chosen, slot });
      }
    }
  }

  run('UPDATE communion_dates SET status = ? WHERE id = ?', ['assigned', communionDateId]);
  return assigned;
}

function getServiceHistory(memberId, months = 12) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  return all(
    `SELECT a.*, cd.date as communion_date, sc.service_time, sc.location, sc.area
     FROM assignments a
     JOIN communion_dates cd ON a.communion_date_id = cd.id
     JOIN slot_config sc ON a.slot_config_id = sc.id
     WHERE a.member_id = ? AND cd.date >= ?
     ORDER BY cd.date DESC`,
    [memberId, cutoffStr]
  );
}

function getServiceCounts(months = 12) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  return all(
    `SELECT m.id, m.name, m.category, COUNT(a.id) as service_count
     FROM members m
     LEFT JOIN assignments a ON m.id = a.member_id
     LEFT JOIN communion_dates cd ON a.communion_date_id = cd.id AND cd.date >= ?
     GROUP BY m.id
     ORDER BY m.category, service_count ASC`,
    [cutoffStr]
  );
}

module.exports = { autoAssign, getServiceHistory, getServiceCounts };
