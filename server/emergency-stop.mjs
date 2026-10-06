// Emergency stop: force StopRecord on OBS + close the capture door + kill
// the kiosk Chrome. Idempotent — safe to run when nothing is recording.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import dotenv from 'dotenv';
dotenv.config();
dotenv.config({ path: '.env.local', override: true });

const OBS_WS_URL = process.env.OBS_WS_URL ?? 'ws://127.0.0.1:4455';
const OBS_WS_PASSWORD = process.env.OBS_WS_PASSWORD;
if (!OBS_WS_PASSWORD) throw new Error('OBS_WS_PASSWORD missing');

const ws = new WebSocket(OBS_WS_URL);
ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.op === 0) {
        const d = { rpcVersion: 1, eventSubscriptions: 0 };
        if (msg.d.authentication) {
            const { challenge, salt } = msg.d.authentication;
            const sha = (s) => createHash('sha256').update(s).digest('base64');
            d.authentication = sha(sha(OBS_WS_PASSWORD + salt) + challenge);
        }
        ws.send(JSON.stringify({ op: 1, d }));
    } else if (msg.op === 2) {
        ws.send(JSON.stringify({ op: 6, d: { requestType: 'StopRecord', requestId: 'stop1', requestData: {} } }));
        setTimeout(async () => {
            ws.close();
            try {
                const out = execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='chrome.exe'\\" | Where-Object { $_.CommandLine -match 'chrome-profile' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`, { stdio: 'pipe' });
            } catch { /* none running */ }
            console.log('stopped: OBS recording + kiosk chrome');
        }, 1500);
    }
});
ws.addEventListener('error', () => { console.log('OBS websocket unreachable — nothing to stop there'); process.exit(0); });
fetch('http://localhost:3600/api/record/door', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"open":false}' }).catch(() => {});
