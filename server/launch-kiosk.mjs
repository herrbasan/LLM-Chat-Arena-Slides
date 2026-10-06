// Launch the kiosk Chrome exactly as record-queue.mjs does — same spawn,
// same flags, same profile dir — so the OBS scene binds to the identical
// window the overnight run will produce. Stays attached and logs exit.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECORD_DIR = path.resolve(__dirname, process.env.RECORD_DIR ?? '../captures');
const RECORD_WIDTH = process.env.RECORD_WIDTH ?? '3840';
const RECORD_HEIGHT = process.env.RECORD_HEIGHT ?? '2160';
const APP_URL = process.env.APP_URL ?? 'http://localhost:3600';

const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
];
const exe = process.env.CHROME_PATH ?? candidates.find(c => fs.existsSync(c));
if (!exe) throw new Error('chrome.exe not found — set CHROME_PATH');

// Profile stays LOCAL even when RECORD_DIR points at a network mount —
// Chrome profile IO belongs on a local disk.
const profileDir = path.resolve(__dirname, '../captures/chrome-profile');
const url = `${APP_URL}/#page=render&recording=1`;
console.log(`launching kiosk (same flags/profile as the runner)`);
console.log(`exe: ${exe}`);
console.log(`profile: ${profileDir}`);
const proc = spawn(exe, [
    '--start-fullscreen',
    '--window-position=0,0',
    `--window-size=${RECORD_WIDTH},${RECORD_HEIGHT}`,
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run', '--no-default-browser-check',
    '--disable-session-crashed-bubble', '--hide-crash-restore-bubble',
    `--user-data-dir=${profileDir}`,
    url,
], { stdio: 'ignore' });
proc.on('exit', (code) => { console.log(`kiosk exited: code ${code}`); process.exit(0); });
// Keep the process attached so the window's lifetime is visible in the terminal.
setInterval(() => {}, 60000);
