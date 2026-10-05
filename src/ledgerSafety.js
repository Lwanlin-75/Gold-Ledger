const malaysiaDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function todayInMalaysia(now = new Date()) {
  const parts = Object.fromEntries(malaysiaDate.formatToParts(now).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function shiftDay(day, amount) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

// Ref-backed gate prevents a second click before React has rendered disabled controls.
export class WriteGate {
  pending = 0;
  failed = false;
  synchronized = false;
  begin() {
    if (!this.synchronized || this.failed || this.pending) throw new Error('ledger_not_synchronized');
    this.pending++;
  }
  finish(success) { this.pending--; if (!success) this.failed = true; }
  canWrite() { return this.synchronized && !this.failed && !this.pending; }
  recovered() { if (!this.pending) { this.synchronized = true; this.failed = false; } }
}
