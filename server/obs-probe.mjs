// Probe OBS's obs-websocket server: is it up, does it demand auth?
// Reads the initial Hello (opcode 0) and prints its facts, then closes.
const url = process.env.OBS_WS_URL ?? 'ws://127.0.0.1:4455';
const ws = new WebSocket(url);
const timeout = setTimeout(() => {
    console.log(`PROBE: no response within 5s — websocket not reachable at ${url}`);
    process.exit(1);
}, 5000);
ws.addEventListener('message', (ev) => {
    clearTimeout(timeout);
    const hello = JSON.parse(ev.data);
    if (hello.op !== 0) {
        console.log(`PROBE: first message was op ${hello.op}, expected Hello(0)`);
        process.exit(1);
    }
    const d = hello.d;
    console.log(`PROBE: reachable — OBS ${d.obsStudioVersion}, obs-websocket ${d.obsWebSocketVersion}, rpc ${d.rpcVersion}, auth ${d.authentication ? 'REQUIRED (password set)' : 'NOT required'}`);
    ws.close();
    process.exit(0);
});
ws.addEventListener('error', () => {
    clearTimeout(timeout);
    console.log(`PROBE: cannot connect — websocket not reachable at ${url}. Enable it in OBS: Tools > WebSocket Server Settings.`);
    process.exit(1);
});
