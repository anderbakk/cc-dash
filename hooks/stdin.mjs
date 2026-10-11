// Reads all of stdin synchronously. `fs.readFileSync(0)` is the short version,
// but it is unreliable for pipes: on Windows the last read raises EOF instead
// of returning 0, and on Unix a non-blocking tty raises EAGAIN. Claude Code
// pipes the hook payload in, so hooks need the loop.
import fs from 'node:fs';
import { stripBom } from '../server/paths.js';

export function readStdin() {
  const chunks = [];
  const buf = Buffer.alloc(1 << 16);
  for (;;) {
    let n;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if (e.code === 'EAGAIN') continue; // not ready yet, try again
      if (e.code === 'EOF' || e.code === 'ENXIO') break; // Windows end of pipe
      throw e;
    }
    if (n <= 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  // The hooks swallow their own errors, so a BOM in front of the payload
  // would just mean the status quietly stops updating.
  return stripBom(Buffer.concat(chunks).toString('utf8'));
}
