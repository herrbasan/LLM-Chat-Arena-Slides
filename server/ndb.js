'use strict';
// Single entry point for the nDB native driver.
//
// Every process that touches the database requires THIS module, never
// `../modules/nDB/napi` directly. The native binary is a hard requirement, and
// resolving it is part of loading it: when the committed win32-x64 build is not
// the one this platform needs, `napi/vendor.js` fetches the matching release
// asset and refuses to write it unless it matches the release's SHA-256
// sidecar. One place means one boot path — no consumer can skip the check, and
// nothing can load a different binary than the one that was verified.
//
// vendor.js is spawned rather than required because it calls process.exit() on
// failure, and a required module must not be able to kill its host. Delegating
// to it also keeps the platform/arch matrix in one place; duplicating that
// logic here is how the two copies drift.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const NAPI_DIR = path.join(__dirname, '..', 'modules', 'nDB', 'napi');
const VENDOR = path.join(NAPI_DIR, 'vendor.js');

if (!fs.existsSync(VENDOR)) {
    throw new Error(
        `nDB vendor script missing: ${VENDOR}\n` +
        `The modules/nDB submodule is not checked out. Run: git submodule update --init --recursive`
    );
}

const vendored = spawnSync(process.execPath, [VENDOR], { encoding: 'utf8' });
if (vendored.status !== 0) {
    throw new Error(
        `nDB native binary could not be vendored (vendor.js exited ${vendored.status}):\n` +
        `${(vendored.stderr || vendored.stdout || '').trim()}`
    );
}
console.log(`[nDB] ${vendored.stdout.trim()}`);

module.exports = require(path.join(NAPI_DIR, 'index.js'));
