// Ask Codex app-server what hooks it actually discovered, and their trust state.
const { spawn } = require('child_process');
const CODEX = 'C:/Users/USER/AppData/Local/OpenAI/Codex/bin/f71e347eb70b3d24/codex.exe';
const cwd = process.argv[2] || process.cwd();
const p = spawn(CODEX, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
p.stdout.on('data', d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { console.log('RAW:', line.slice(0, 300)); continue; }
    if (m.id === 1) {
      send(2, 'hooks/list', { cwds: [cwd] });
    } else if (m.id === 2) {
      console.log('=== hooks/list RESULT ===');
      console.log(JSON.stringify(m, null, 2).slice(0, 4000));
      p.kill(); process.exit(0);
    }
  }
});
p.stderr.on('data', d => process.stderr.write('[stderr] ' + d.toString().slice(0, 500)));
function send(id, method, params) {
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
}
send(1, 'initialize', { clientInfo: { name: 'agw-probe', version: '0.0.1' } });
setTimeout(() => { console.log('TIMEOUT'); p.kill(); process.exit(1); }, 60000);
