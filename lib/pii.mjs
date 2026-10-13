// Pattern checks run on every draft answer. A match counts as a leak unless
// the same text appears in a fact the asker is allowed to hear, so Charlie
// can still choose to share, say, a contact email.
const PATTERNS = [
  ['email', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g],
  ['phone', /\+?\d(?:[\s().-]*\d){8,}/g],
  ['street address', /\b\d{1,5}\s+(?:[A-Za-z0-9.'-]+\s){1,4}(?:st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|way|ct|court|pl|place|ter|terrace|hwy|highway)\b\.?/gi],
  ['coordinates', /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/g],
  ['id number', /\b\d{3}-\d{2}-\d{4}\b/g],
];

const normalize = (text) => text.toLowerCase().replace(/\s+/g, ' ');

export function findLeaks(answer, allowedFacts) {
  const allowed = normalize(allowedFacts.map((fact) => fact.text).join('\n'));
  const leaks = [];
  for (const [kind, pattern] of PATTERNS) {
    for (const match of answer.matchAll(pattern)) {
      if (!allowed.includes(normalize(match[0].trim()))) leaks.push(kind);
    }
  }
  return [...new Set(leaks)];
}
