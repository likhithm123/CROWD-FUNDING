const CURRENCY = import.meta.env.VITE_CURRENCY || 'INR';
const LOCALE = CURRENCY === 'INR' ? 'en-IN' : undefined;

const moneyFmt = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: CURRENCY, maximumFractionDigits: 0 });
const moneyExact = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: CURRENCY, minimumFractionDigits: 0, maximumFractionDigits: 2 });
const compactFmt = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: CURRENCY, notation: 'compact', maximumFractionDigits: 1 });

export const currencySymbol = moneyFmt.formatToParts(0).find((p) => p.type === 'currency')?.value || '';
export const money = (n) => moneyFmt.format(Number(n) || 0);
export const moneyPrecise = (n) => moneyExact.format(Number(n) || 0);
export const moneyShort = (n) => (Math.abs(n) >= 100000 ? compactFmt.format(n) : moneyFmt.format(n));
export const number = (n) => new Intl.NumberFormat(LOCALE).format(n);
export const percent = (part, whole) => (whole > 0 ? Math.min(100, Math.floor((part / whole) * 100)) : 0);

export function date(value) {
  if (!value) return '';
  return new Date(value).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function dateTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleString(LOCALE, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export function ago(value) {
  const s = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) { const d = Math.floor(s / 86400); return `${d} day${d === 1 ? '' : 's'} ago`; }
  return date(value);
}

export function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const initials = (name = '') => name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');

export const ROLE_LABEL = { INVESTOR: 'Backer', MANAGER: 'Project lead', ADMIN: 'Administrator', SUPPORT: 'Support' };

export const STATUS = {
  PENDING: { label: 'Waiting for review', cls: 'status-pending' },
  VERIFIED: { label: 'Raising funds', cls: 'status-live' },
  REJECTED: { label: 'Changes requested', cls: 'status-rejected' },
  FUNDED: { label: 'Goal reached', cls: 'status-funded' },
  CLOSED: { label: 'Funds released', cls: 'status-closed' },
};

export const TICKET_STATUS = {
  OPEN: { label: 'Open', cls: 'status-pending' },
  IN_PROGRESS: { label: 'In progress', cls: 'status-funded' },
  RESOLVED: { label: 'Resolved', cls: 'status-closed' },
};

// Flat, quiet colours per category for the strip on each project tile.
export const CATEGORY_COLOR = {
  Agriculture: '#7aa84f',
  'Clean energy': '#e2a93b',
  Education: '#4f7cac',
  Health: '#c4607a',
  Technology: '#6b6fb5',
  'Water & sanitation': '#3a9bb3',
  'Community infrastructure': '#8a7a66',
  'Arts & culture': '#c27d4a',
};
