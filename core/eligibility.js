// Who may serve in each ministry. Communion takes active and inactive officers;
// Prayer is active elders; Duty Deacon is active McLean deacons.
const RULES = {
  communion: p => p.office === 'elder' || p.office === 'deacon',
  prayer: p => p.office === 'elder' && !!p.active,
  duty: p => p.office === 'deacon' && !!p.active && p.home_campus === 'McLean',
};

const MINISTRY_NAMES = { communion: 'Communion', prayer: 'Prayer', duty: 'Duty Deacon' };

function isEligible(person, ministry) {
  const rule = RULES[ministry];
  return !!(rule && person && rule(person));
}

function eligibleMinistries(person) {
  return Object.keys(RULES).filter(m => isEligible(person, m));
}

module.exports = { isEligible, eligibleMinistries, MINISTRY_NAMES };
