// Validation rules shared by the browser and the server, so the sign-up form
// shows exactly the constraints the API enforces.

export const NAME_MIN = 2;
export const NAME_MAX = 60;
export const EMAIL_MAX = 120;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 64;

export const PUBLIC_ROLES = ['INVESTOR', 'MANAGER'];
export const ALL_ROLES = ['INVESTOR', 'MANAGER', 'SUPPORT', 'ADMIN'];

export const CATEGORIES = [
  'Agriculture',
  'Clean energy',
  'Education',
  'Health',
  'Technology',
  'Water & sanitation',
  'Community infrastructure',
  'Arts & culture',
];


const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', 'qwerty123',
  'iloveyou', 'admin123', 'welcome1', 'letmein1', 'abc12345', 'passw0rd',
  'p@ssw0rd', 'p@ssword1', 'qwertyuiop', '11111111', 'sunshine1', 'football1',
]);

const NAME_RE = /^[\p{L}][\p{L} .'-]*[\p{L}.]$/u;
// Practical email check: one @, no spaces, a dot in the domain, a 2+ letter TLD.
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function validateName(raw) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ');
  if (name.length < NAME_MIN) return `Name must be at least ${NAME_MIN} characters.`;
  if (name.length > NAME_MAX) return `Name must be ${NAME_MAX} characters or fewer.`;
  if (!NAME_RE.test(name)) return 'Name can only contain letters, spaces, apostrophes, hyphens and dots.';
  return null;
}

export function validateEmail(raw) {
  const email = normalizeEmail(raw);
  if (!email) return 'Enter your email address.';
  if (email.length > EMAIL_MAX) return `Email must be ${EMAIL_MAX} characters or fewer.`;
  if (!EMAIL_RE.test(email) || email.includes('..')) return 'Enter a valid email address, like name@example.com.';
  return null;
}

/**
 * Each rule is checked separately so the form can show a live checklist.
 * Returns [{ id, label, ok }].
 */
export function passwordChecks(password, { name = '', email = '' } = {}) {
  const pw = String(password || '');
  const lower = pw.toLowerCase();
  const personal = [
    ...String(name).toLowerCase().split(/\s+/),
    normalizeEmail(email).split('@')[0],
  ].filter((part) => part && part.length >= 3);

  return [
    { id: 'length', label: `${PASSWORD_MIN}–${PASSWORD_MAX} characters`, ok: pw.length >= PASSWORD_MIN && pw.length <= PASSWORD_MAX },
    { id: 'upper', label: 'An uppercase letter', ok: /[A-Z]/.test(pw) },
    { id: 'lower', label: 'A lowercase letter', ok: /[a-z]/.test(pw) },
    { id: 'digit', label: 'A number', ok: /\d/.test(pw) },
    { id: 'symbol', label: 'A symbol, like ! @ # or %', ok: /[^A-Za-z0-9\s]/.test(pw) },
    { id: 'spaces', label: 'No spaces', ok: pw.length > 0 && !/\s/.test(pw) },
    {
      id: 'personal',
      label: 'Doesn’t contain your name or email',
      ok: pw.length > 0 && !personal.some((part) => lower.includes(part)),
    },
    { id: 'common', label: 'Not a commonly used password', ok: pw.length > 0 && !COMMON_PASSWORDS.has(lower) },
  ];
}

export function validatePassword(password, context) {
  const failed = passwordChecks(password, context).filter((c) => !c.ok);
  if (failed.length === 0) return null;
  return `Password needs: ${failed.map((c) => c.label.toLowerCase()).join(', ')}.`;
}

/** Validate a sign-up payload. Returns { errors, value }. */
export function validateSignup(input, { allowedRoles = PUBLIC_ROLES } = {}) {
  const errors = {};
  const name = String(input.name || '').trim().replace(/\s+/g, ' ');
  const email = normalizeEmail(input.email);
  const role = String(input.role || '').toUpperCase();

  const nameErr = validateName(name);
  if (nameErr) errors.name = nameErr;
  const emailErr = validateEmail(email);
  if (emailErr) errors.email = emailErr;
  const pwErr = validatePassword(input.password, { name, email });
  if (pwErr) errors.password = pwErr;
  if (input.confirmPassword !== undefined && input.confirmPassword !== input.password) {
    errors.confirmPassword = 'Passwords don’t match.';
  }
  if (!allowedRoles.includes(role)) errors.role = 'Choose how you’ll use CrowdFunding.';
  if (input.acceptTerms !== undefined && input.acceptTerms !== true) {
    errors.acceptTerms = 'You need to accept the terms to create an account.';
  }

  return { errors, value: { name, email, role, password: String(input.password || '') } };
}
