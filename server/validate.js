// Strict input validation helpers. Values of the wrong JSON type are rejected
// (no silent coercion of "5" to 5) so client bugs surface as 400s.

import { badRequest } from './errors.js';

// C0/C1 control characters (tabs and newlines included) are never valid in
// the single-line fields this API accepts.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function requireObject(value, field = 'body') {
  if (!isPlainObject(value)) throw badRequest(`${field} must be a JSON object.`);
  return value;
}

export function charLength(value) {
  return [...value].length;
}

export function string(value, field, { min = 0, max = Infinity, trim = true, pattern, patternMessage } = {}) {
  if (typeof value !== 'string') throw badRequest(`${field} must be a string.`);
  const result = trim ? value.trim() : value;
  if (CONTROL_CHARS.test(result)) throw badRequest(`${field} contains invalid characters.`);
  const length = charLength(result);
  if (length < min) throw badRequest(min === 1 ? `${field} is required.` : `${field} must be at least ${min} characters.`);
  if (length > max) throw badRequest(`${field} must be at most ${max} characters.`);
  if (pattern && !pattern.test(result)) throw badRequest(patternMessage ?? `${field} has an invalid format.`);
  return result;
}

export function integer(value, field, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw badRequest(`${field} must be an integer.`);
  if (value < min || value > max) throw badRequest(`${field} must be between ${min} and ${max}.`);
  return value;
}

export function boolean(value, field) {
  if (typeof value !== 'boolean') throw badRequest(`${field} must be true or false.`);
  return value;
}

export function oneOf(value, field, allowed) {
  if (!allowed.includes(value)) throw badRequest(`${field} must be one of: ${allowed.join(', ')}.`);
  return value;
}
