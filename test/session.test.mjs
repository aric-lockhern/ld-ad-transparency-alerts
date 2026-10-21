import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGoogleCookies } from '../src/session.mjs';

const SECRET = 'very-secret-session-value';
const cookieEditor = [
  { domain: '.google.com', name: '__Secure-1PSID', value: SECRET, path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction', expirationDate: 1800000000.5 },
  { domain: '.google.com', name: 'NID', value: 'n', path: '/', secure: true, httpOnly: true, sameSite: 'unspecified' },
  { domain: 'adstransparency.google.com', name: 'x', value: 'y', path: '/', secure: false, sameSite: 'lax' },
  { domain: '.facebook.com', name: 'c_user', value: 'not-ours', path: '/' },
];

test('no secret configured means anonymous, not an error', () => {
  assert.deepEqual(parseGoogleCookies(undefined), []);
  assert.deepEqual(parseGoogleCookies('  '), []);
});

test('Cookie-Editor export: only google.com cookies, mapped for Playwright', () => {
  const c = parseGoogleCookies(JSON.stringify(cookieEditor));
  assert.deepEqual(c.map((x) => x.name), ['__Secure-1PSID', 'NID', 'x']);
  assert.equal(c[0].sameSite, 'None');
  assert.equal(c[0].secure, true);
  assert.equal(c[0].expires, 1800000000);
  assert.equal(c[1].sameSite, 'Lax');
  assert.equal(c[1].expires, -1);
  assert.equal(c[2].sameSite, 'Lax');
});

test('Playwright storageState and base64 are accepted too', () => {
  const state = { cookies: cookieEditor.map((x) => ({ ...x, expires: 1800000000, sameSite: 'None' })), origins: [] };
  assert.equal(parseGoogleCookies(JSON.stringify(state)).length, 3);
  assert.equal(parseGoogleCookies(Buffer.from(JSON.stringify(cookieEditor)).toString('base64')).length, 3);
});

test('an export taken while signed out is refused, by name', () => {
  const signedOut = cookieEditor.filter((x) => x.name !== '__Secure-1PSID');
  assert.throws(() => parseGoogleCookies(JSON.stringify(signedOut)), /no sign-in cookie/);
  assert.throws(() => parseGoogleCookies(JSON.stringify([cookieEditor[3]])), /no google\.com cookies/);
  assert.throws(() => parseGoogleCookies('{"nope":1}'), /no cookie list/);
  assert.throws(() => parseGoogleCookies('not json at all {'), /not valid JSON/);
});

test('no error message ever contains a cookie value', () => {
  const bad = JSON.stringify([{ domain: '.google.com', name: 'NID', value: SECRET }]);
  try {
    parseGoogleCookies(bad);
    assert.fail('should throw');
  } catch (e) {
    assert.ok(!e.message.includes(SECRET));
  }
});
