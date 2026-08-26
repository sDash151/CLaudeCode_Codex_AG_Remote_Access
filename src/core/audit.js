'use strict';
/**
 * Append-only audit log (JSONL). One line per event, fsync'd on write so a
 * crash cannot silently lose a decision record.
 *
 * The log is the source of truth for "who approved what, when". It is never
 * rewritten or compacted by the gateway.
 */
const fs = require('node:fs');
const path = require('node:path');

class AuditLog {
  /** @param {string} filePath */
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  /**
   * @param {string} event  Event name, e.g. "request.created", "request.approved".
   * @param {object} fields Structured detail. Never include secrets.
   */
  append(event, fields = {}) {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + '\n';
    // Open/append/fsync/close per record: slow but durable, and the volume here
    // is a handful of records per approval.
    const fd = fs.openSync(this.filePath, 'a');
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return line;
  }

  /**
   * Read the most recent `limit` entries, newest first.
   * @param {number} limit
   */
  tail(limit = 100) {
    if (!fs.existsSync(this.filePath)) return [];
    const text = fs.readFileSync(this.filePath, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]));
      } catch {
        // A truncated final line (crash mid-write) is skipped rather than
        // failing the whole history view.
      }
    }
    return out;
  }
}

module.exports = { AuditLog };
