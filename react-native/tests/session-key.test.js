const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TRACKING_SESSION_KEY } = require('../trackingConfig');

// start() (App.js) writes a new session id on every START and the background task (locationTask.js)
// reads it on every delivery. If the two ever used different AsyncStorage key strings, the task
// would silently mint its own id and the session reset would stop working. Both must go through the
// one TRACKING_SESSION_KEY constant, never a string literal.

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const FILES = ['App.js', 'locationTask.js'];

// AsyncStorage.getItem / setItem / removeItem calls and the first argument's source text.
function asyncStorageKeyArguments(source) {
  return [...source.matchAll(/AsyncStorage\.(?:get|set|remove)Item\(\s*([^,)\s]+)/g)].map((m) => m[1]);
}

test('the session key keeps its original string so existing installs continue their session id', () => {
  assert.equal(TRACKING_SESSION_KEY, 'tracking_session_id');
});

test('App.js and locationTask.js both use TRACKING_SESSION_KEY from trackingConfig for the session id', () => {
  for (const file of FILES) {
    const source = read(file);
    const importsIt = new RegExp(`import\\s*\\{[^}]*\\bTRACKING_SESSION_KEY\\b[^}]*\\}\\s*from\\s*'\\./trackingConfig'`).test(source);
    assert.ok(importsIt, `${file} imports TRACKING_SESSION_KEY from ./trackingConfig`);
    assert.ok(
      asyncStorageKeyArguments(source).includes('TRACKING_SESSION_KEY'),
      `${file} reads/writes AsyncStorage with TRACKING_SESSION_KEY`,
    );
  }
});

test('neither file addresses the session id through a string literal or a private constant', () => {
  for (const file of FILES) {
    const source = read(file);
    assert.doesNotMatch(source, /['"`]tracking_session_id['"`]/, `${file} has no 'tracking_session_id' literal`);
    assert.doesNotMatch(source, /\bconst\s+SESSION_KEY\b/, `${file} has no private SESSION_KEY constant`);
    for (const arg of asyncStorageKeyArguments(source)) {
      if (/^['"`]/.test(arg)) {
        assert.doesNotMatch(arg, /session/i, `${file}: AsyncStorage key literal ${arg} must not be a session key`);
      }
    }
  }
});

test('the two sides really are one write (start) and one read (task) of the same key', () => {
  const app = read('App.js');
  const task = read('locationTask.js');
  assert.match(app, /AsyncStorage\.setItem\(TRACKING_SESSION_KEY,\s*createSessionId\(\)\)/);
  assert.match(task, /AsyncStorage\.getItem\(TRACKING_SESSION_KEY\)/);
});
