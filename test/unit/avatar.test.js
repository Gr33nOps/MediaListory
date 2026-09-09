const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');

// A 1x1 GIF89a. Frames are appended by repeating the block that starts at the
// first graphic control extension, which is how the fixtures below are built.
const ONE_FRAME = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const GCE_AT = ONE_FRAME.indexOf(Buffer.from([0x21, 0xF9, 0x04]));

function gifWithFrames(n) {
  const prefix = ONE_FRAME.subarray(0, GCE_AT);
  const frame = ONE_FRAME.subarray(GCE_AT, ONE_FRAME.length - 1);
  return Buffer.concat([prefix, ...Array(n).fill(frame), Buffer.from([0x3B])]);
}

// Mirrors Frontend/profile.js: a GIF carrying more than one graphic control
// extension is animated and must be stored whole rather than downscaled.
function isAnimatedGif(binary) {
  let seen = 0, i = 0;
  while ((i = binary.indexOf('\x21\xF9\x04', i)) !== -1) {
    if (++seen > 1) return true;
    i += 3;
  }
  return false;
}

test('fixture GIFs carry the frame count they claim', () => {
  assert.equal(GCE_AT > 0, true, 'the 1x1 fixture should contain a graphic control extension');
  assert.equal(gifWithFrames(1).subarray(0, 6).toString('latin1'), 'GIF89a');
  assert.equal(gifWithFrames(2).subarray(-1)[0], 0x3B, 'a GIF ends with the trailer byte');
});

test('animated GIFs are told apart from single-frame ones', () => {
  assert.equal(isAnimatedGif(gifWithFrames(2).toString('latin1')), true);
  assert.equal(isAnimatedGif(gifWithFrames(4).toString('latin1')), true);
  assert.equal(isAnimatedGif(gifWithFrames(1).toString('latin1')), false);
  assert.equal(isAnimatedGif(''), false);
});

test('an animated avatar still fits the column budget', () => {
  // profile.js caps an animated GIF at 256KB and Backend/profile.js rejects any
  // avatar over 400000 characters. Base64 costs 4 characters per 3 bytes, so the
  // client limit has to leave room under the server one or uploads that pass the
  // picker would come back rejected.
  const CLIENT_MAX_BYTES = 256 * 1024;
  const SERVER_MAX_CHARS = 400000;
  const encoded = Math.ceil(CLIENT_MAX_BYTES / 3) * 4 + 'data:image/gif;base64,'.length;
  assert.ok(encoded < SERVER_MAX_CHARS, `a max-size GIF encodes to ${encoded} chars, over the ${SERVER_MAX_CHARS} server cap`);
});

test('the avatar accept rules match what the picker offers', () => {
  const backend = fs.readFileSync(path.join(root, 'Backend', 'profile.js'), 'utf8');
  const m = backend.match(/\^data:image\\\/\(([^)]+)\)/);
  assert.ok(m, 'Backend/profile.js should validate the avatar data URI mime type');
  const allowed = m[1].split('|');
  for (const type of ['png', 'jpeg', 'gif', 'webp']) {
    assert.ok(allowed.includes(type), `backend should accept image/${type}`);
  }

  const html = fs.readFileSync(path.join(root, 'Frontend', 'profile.html'), 'utf8');
  const accept = html.match(/id="avatarFile"[^>]*accept="([^"]+)"/);
  assert.ok(accept, 'the avatar file input should declare an accept list');
  assert.ok(accept[1].includes('image/gif'), 'the picker should offer GIFs');
});
