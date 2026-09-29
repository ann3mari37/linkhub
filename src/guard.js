// Slows down guessing at the sign-in forms: 10 wrong tries per address per
// 15 minutes, counted separately for the family sign-in and the admin sign-in.
const WINDOW = 15 * 60 * 1000;
const LIMIT = 10;
const failures = new Map();

const keyOf = (kind, ip) => kind + ' ' + ip;

function blocked(kind, ip) {
  const f = failures.get(keyOf(kind, ip));
  return Boolean(f) && Date.now() - f.first < WINDOW && f.count >= LIMIT;
}

function recordFailure(kind, ip) {
  if (failures.size > 1000) {
    for (const [k, v] of failures) if (Date.now() - v.first > WINDOW) failures.delete(k);
  }
  const key = keyOf(kind, ip);
  const f = failures.get(key);
  if (!f || Date.now() - f.first > WINDOW) failures.set(key, { first: Date.now(), count: 1 });
  else f.count++;
}

const TOO_MANY = 'Too many wrong tries. Wait 15 minutes and try again.';

module.exports = { blocked, recordFailure, TOO_MANY };
