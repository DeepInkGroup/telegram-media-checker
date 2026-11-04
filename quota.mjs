export const dailyLimits = { free: 50, pro: 200 };
export function setLimit(plan, value) {
  if (!Object.hasOwn(dailyLimits, plan) || !Number.isSafeInteger(value) || value < 0 || value > 1000000) return false;
  dailyLimits[plan] = value;
  return true;
}
export function resetUsage(user) {
  delete user.quotaDate;
  delete user.quotaUsed;
}
export function quota(user, now = new Date()) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const plan = user.plan === 'pro' ? 'pro' : 'free';
  const used = user.quotaDate === date ? (user.quotaUsed || 0) : 0;
  return { date, plan, used, limit: dailyLimits[plan] };
}
export function consume(user, now = new Date()) {
  const current = quota(user, now);
  if (current.used >= current.limit) return false;
  user.quotaDate = current.date;
  user.quotaUsed = current.used + 1;
  return true;
}
