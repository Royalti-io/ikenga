// Default scheduled_for slots for newsletter approval flow.
// Lagos is UTC+1 with no DST; the offset is constant.

const LAGOS_OFFSET_HOURS = 1;

function nextLagosSlot(now: Date, targetDow: number, targetHourLagos: number): string {
  const lagosNow = new Date(now.getTime() + LAGOS_OFFSET_HOURS * 3600_000);
  const dow = lagosNow.getUTCDay();
  let daysAhead = (targetDow - dow + 7) % 7;
  if (daysAhead === 0 && lagosNow.getUTCHours() >= targetHourLagos) {
    daysAhead = 7;
  }
  const target = new Date(
    Date.UTC(
      lagosNow.getUTCFullYear(),
      lagosNow.getUTCMonth(),
      lagosNow.getUTCDate() + daysAhead,
      targetHourLagos - LAGOS_OFFSET_HOURS,
      0,
      0,
      0,
    ),
  );
  return target.toISOString();
}

export function nextTuesdayTenAmLagos(now: Date = new Date()): string {
  return nextLagosSlot(now, 2, 10);
}

export function nextThursdayTwoPmLagos(now: Date = new Date()): string {
  return nextLagosSlot(now, 4, 14);
}

export function getNextSlot(
  type: 'newsletter' | 'investor_update',
  now: Date = new Date(),
): string {
  return type === 'investor_update' ? nextThursdayTwoPmLagos(now) : nextTuesdayTenAmLagos(now);
}
