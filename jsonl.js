/**
 * Append-only JSON-lines files (ledger, deferred list, history).
 * One appendFileSync of one line: O_APPEND never rewrites earlier bytes, so an
 * interruption can at worst leave THAT line torn; the next append starts on a fresh
 * line so a torn tail cannot swallow it, and readers skip lines that don't parse.
 */
const fs = require('fs');

/** Every parseable object in the file. Creates the file if missing. */
function readJsonl(file) {
  fs.closeSync(fs.openSync(file, 'a'));
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && typeof r === 'object') out.push(r); }
    catch (e) { /* torn or hand-mangled line: skip, never crash */ }
  }
  return out;
}

function appendJsonl(file, obj) {
  let lead = '';
  if (fs.existsSync(file)) {
    const { size } = fs.statSync(file);
    if (size) {
      const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(1);
      fs.readSync(fd, b, 0, 1, size - 1); fs.closeSync(fd);
      if (b[0] !== 10) lead = '\n';
    }
  }
  fs.appendFileSync(file, lead + JSON.stringify(obj) + '\n');
  return obj;
}

module.exports = { readJsonl, appendJsonl };
