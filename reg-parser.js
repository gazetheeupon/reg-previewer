/*
 * Parser for Windows .reg (Registry Editor export) files.
 *
 * Format background (both variants handled):
 *  - "REGEDIT4": legacy format, ANSI/Windows-1252 text, no BOM, first line
 *    is literally "REGEDIT4".
 *  - "Windows Registry Editor Version 5.00": modern format, UTF-16LE text
 *    with a 0xFF 0xFE byte-order mark, first line is that exact string.
 *
 * Body syntax, line by line (CRLF-terminated in practice, but we accept
 * bare LF too):
 *   [KEY\PATH]            -- create/select this key
 *   [-KEY\PATH]           -- delete this key (and everything under it)
 *   "Name"=<value>        -- set a named value under the current key
 *   @=<value>             -- set the current key's unnamed (default) value
 *   "Name"=-              -- delete this named value
 *   @=-                   -- delete the default value
 *
 * <value> is one of:
 *   "quoted string"        REG_SZ, with \" and \\ escaping
 *   dword:XXXXXXXX          REG_DWORD, 8 hex digits, big-endian-looking text
 *                            but represents the value in normal (non-swapped)
 *                            byte order once parsed as a plain hex integer
 *   hex:b1,b2,b3,...         REG_BINARY, comma-separated hex bytes
 *   hex(N):b1,b2,...         a typed value, N is a hex type code:
 *     0  REG_NONE
 *     1  REG_SZ           (UTF-16LE bytes, NUL-terminated)
 *     2  REG_EXPAND_SZ    (UTF-16LE bytes, NUL-terminated, %ENV% refs)
 *     3  REG_BINARY       (same as bare hex:)
 *     4  REG_DWORD        (4 bytes, little-endian)
 *     5  REG_DWORD_BIG_ENDIAN (4 bytes, big-endian)
 *     7  REG_MULTI_SZ     (UTF-16LE bytes, NUL-separated strings, double-NUL end)
 *     8  REG_RESOURCE_LIST (opaque binary)
 *     b  REG_QWORD        (8 bytes, little-endian)
 *   -                       delete this value
 *
 * A long hex:/hex(N): value line can be wrapped across multiple physical
 * lines: every line except the last ends with a backslash, and the
 * continuation line is joined onto it verbatim (regedit's own exporter
 * indents the continuation with a single space, but that's convention,
 * not something a reader may rely on).
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RegParser = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class RegParseError extends Error {}

  const TYPE_NAMES = {
    0: 'REG_NONE',
    1: 'REG_SZ',
    2: 'REG_EXPAND_SZ',
    3: 'REG_BINARY',
    4: 'REG_DWORD',
    5: 'REG_DWORD_BIG_ENDIAN',
    6: 'REG_LINK',
    7: 'REG_MULTI_SZ',
    8: 'REG_RESOURCE_LIST',
    9: 'REG_FULL_RESOURCE_DESCRIPTOR',
    10: 'REG_RESOURCE_REQUIREMENTS_LIST',
    11: 'REG_QWORD',
  };

  // ---- encoding detection & decoding ----

  function detectAndDecode(buf) {
    const bytes = new Uint8Array(buf);
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      const text = new TextDecoder('utf-16le').decode(bytes.subarray(2));
      return { text, encoding: 'utf-16le' };
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      throw new RegParseError('This file is UTF-16 big-endian, which regedit itself never writes. It may not be a genuine .reg export.');
    }
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      const text = new TextDecoder('utf-8').decode(bytes.subarray(3));
      return { text, encoding: 'utf-8' };
    }
    // No BOM: legacy REGEDIT4 files are ANSI (Windows-1252). Decode with
    // windows-1252 when available; fall back to latin1 (a byte-for-byte
    // superset for the printable range this format actually uses).
    let text;
    try {
      text = new TextDecoder('windows-1252').decode(bytes);
    } catch (e) {
      text = new TextDecoder('latin1').decode(bytes);
    }
    return { text, encoding: 'windows-1252' };
  }

  // ---- line joining (backslash continuation) ----

  function splitLogicalLines(text) {
    const raw = text.split(/\r\n|\r|\n/);
    const out = [];
    let pending = null;
    for (let line of raw) {
      if (pending !== null) {
        line = pending + line.replace(/^\s+/, '');
        pending = null;
      }
      if (/\\\s*$/.test(line) && !isCommentOrHeader(line)) {
        pending = line.replace(/\\\s*$/, '');
        continue;
      }
      out.push(line);
    }
    if (pending !== null) out.push(pending); // dangling continuation, keep it (will surface as an error)
    return out;
  }

  function isCommentOrHeader(line) {
    const t = line.trim();
    return t.startsWith(';') || t === 'REGEDIT4' || /^Windows Registry Editor Version \d+\.\d+$/.test(t);
  }

  // ---- quoted-string parsing (names and REG_SZ literals) ----

  // Parses a double-quoted, backslash-escaped string starting at
  // text[start] (which must be '"'). Returns { value, next } where next is
  // the index just past the closing quote.
  function parseQuoted(text, start) {
    if (text[start] !== '"') throw new RegParseError('Expected a quoted string at: ' + text.slice(start));
    let i = start + 1;
    let out = '';
    while (i < text.length) {
      const c = text[i];
      if (c === '\\' && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') {
        return { value: out, next: i + 1 };
      }
      out += c;
      i += 1;
    }
    throw new RegParseError('Unterminated quoted string: ' + text.slice(start));
  }

  // ---- hex byte-list parsing ----

  function parseHexBytes(s) {
    const cleaned = s.replace(/\s+/g, '');
    if (cleaned === '') return new Uint8Array(0);
    const parts = cleaned.split(',').filter((p) => p.length > 0);
    const bytes = new Uint8Array(parts.length);
    for (let i = 0; i < parts.length; i++) {
      if (!/^[0-9a-fA-F]{1,2}$/.test(parts[i])) {
        throw new RegParseError('Invalid hex byte "' + parts[i] + '"');
      }
      bytes[i] = parseInt(parts[i], 16);
    }
    return bytes;
  }

  function utf16leToString(bytes, stopAtNul) {
    let len = bytes.length - (bytes.length % 2);
    if (stopAtNul) {
      for (let i = 0; i + 1 < len; i += 2) {
        if (bytes[i] === 0 && bytes[i + 1] === 0) { len = i; break; }
      }
    } else if (len >= 2 && bytes[len - 2] === 0 && bytes[len - 1] === 0) {
      len -= 2; // drop a single trailing NUL terminator
    }
    return new TextDecoder('utf-16le').decode(bytes.subarray(0, len));
  }

  function multiSzFromBytes(bytes) {
    // NUL-separated UTF-16LE strings, terminated by an extra NUL (i.e. two
    // consecutive UTF-16 NUL code units at the very end). Trailing empty
    // strings produced by that terminator are dropped.
    const full = utf16leToString(bytes, false);
    const parts = full.split('\u0000');
    while (parts.length && parts[parts.length - 1] === '') parts.pop();
    return parts;
  }

  function bytesToHexPreview(bytes, maxBytes) {
    const n = Math.min(bytes.length, maxBytes == null ? bytes.length : maxBytes);
    const hex = [];
    for (let i = 0; i < n; i++) hex.push(bytes[i].toString(16).padStart(2, '0'));
    let s = hex.join(' ');
    if (n < bytes.length) s += ` … (${bytes.length} bytes total)`;
    return s;
  }

  function readUint32(bytes, bigEndian) {
    if (bytes.length < 4) throw new RegParseError('Expected 4 bytes for a DWORD, got ' + bytes.length);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return dv.getUint32(0, !bigEndian);
  }

  function readUint64(bytes) {
    if (bytes.length < 8) throw new RegParseError('Expected 8 bytes for a QWORD, got ' + bytes.length);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return dv.getBigUint64(0, true);
  }

  function decodeTyped(typeCode, bytes) {
    const type = TYPE_NAMES[typeCode] || `REG_UNKNOWN(0x${typeCode.toString(16)})`;
    switch (typeCode) {
      case 1: // REG_SZ
        return { type, data: utf16leToString(bytes, true) };
      case 2: // REG_EXPAND_SZ
        return { type, data: utf16leToString(bytes, true) };
      case 4: // REG_DWORD (LE)
        return { type, data: readUint32(bytes, false) };
      case 5: // REG_DWORD_BIG_ENDIAN
        return { type, data: readUint32(bytes, true) };
      case 7: // REG_MULTI_SZ
        return { type, data: multiSzFromBytes(bytes) };
      case 11: // REG_QWORD
        return { type, data: readUint64(bytes) };
      case 0: // REG_NONE
      case 3: // REG_BINARY
      case 8:
      case 9:
      case 10:
      case 6: // REG_LINK — rare, treat as opaque bytes rather than guessing
      default:
        return { type, data: bytes, bytes: true };
    }
  }

  // ---- value-line parsing ----

  function parseValueLine(line, lineNo, warnings) {
    let name, isDefault, rest;
    if (line.startsWith('@=')) {
      isDefault = true;
      name = null;
      rest = line.slice(2);
    } else if (line.startsWith('"')) {
      const { value, next } = parseQuoted(line, 0);
      if (line[next] !== '=') {
        warnings.push(`Line ${lineNo}: expected "=" after value name, skipping: ${line}`);
        return null;
      }
      isDefault = false;
      name = value;
      rest = line.slice(next + 1);
    } else {
      warnings.push(`Line ${lineNo}: not a recognized key, value, or comment line, skipping: ${line}`);
      return null;
    }

    if (rest === '-') {
      return { name, isDefault, deleted: true };
    }
    if (rest.startsWith('"')) {
      const { value } = parseQuoted(rest, 0);
      return { name, isDefault, type: 'REG_SZ', typeCode: 1, data: value };
    }
    let m = /^dword:\s*([0-9a-fA-F]{1,8})\s*$/i.exec(rest);
    if (m) {
      return { name, isDefault, type: 'REG_DWORD', typeCode: 4, data: parseInt(m[1], 16) >>> 0 };
    }
    m = /^hex\(([0-9a-fA-F]+)\):(.*)$/i.exec(rest);
    if (m) {
      const typeCode = parseInt(m[1], 16);
      let bytes;
      try {
        bytes = parseHexBytes(m[2]);
      } catch (e) {
        warnings.push(`Line ${lineNo}: ${e.message}`);
        return { name, isDefault, type: `REG_UNKNOWN(0x${m[1]})`, error: e.message };
      }
      const decoded = decodeTyped(typeCode, bytes);
      return { name, isDefault, typeCode, ...decoded };
    }
    m = /^hex:(.*)$/i.exec(rest);
    if (m) {
      let bytes;
      try {
        bytes = parseHexBytes(m[1]);
      } catch (e) {
        warnings.push(`Line ${lineNo}: ${e.message}`);
        return { name, isDefault, type: 'REG_BINARY', error: e.message };
      }
      return { name, isDefault, type: 'REG_BINARY', typeCode: 3, data: bytes, bytes: true };
    }
    warnings.push(`Line ${lineNo}: unrecognized value syntax, skipping: ${line}`);
    return null;
  }

  // ---- top-level parse ----

  function parseRegBuffer(arrayBuffer) {
    const { text, encoding } = detectAndDecode(arrayBuffer);
    const lines = splitLogicalLines(text);

    // Find and validate the header on the first non-blank line.
    let format = null;
    let firstContentIdx = 0;
    for (; firstContentIdx < lines.length; firstContentIdx++) {
      const t = lines[firstContentIdx].trim();
      if (t === '') continue;
      if (t === 'REGEDIT4') { format = 'REGEDIT4'; firstContentIdx++; break; }
      const m = /^Windows Registry Editor Version (\d+\.\d+)$/.exec(t);
      if (m) { format = 'Windows Registry Editor Version ' + m[1]; firstContentIdx++; break; }
      break; // first non-blank line isn't a recognized header
    }
    if (!format) {
      throw new RegParseError(
        'This doesn’t look like a .reg file: it should start with "Windows Registry Editor Version 5.00" or "REGEDIT4". ' +
        'It may be a different kind of file, or corrupted.'
      );
    }

    const warnings = [];
    const keys = [];
    let current = null;

    for (let i = firstContentIdx; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.trim();
      const lineNo = i + 1;
      if (line === '' || line.startsWith(';')) continue;

      const keyMatch = /^\[(-?)(.+)\]$/.exec(line);
      if (keyMatch) {
        const deleted = keyMatch[1] === '-';
        const path = keyMatch[2];
        current = { path, deleted, values: [] };
        keys.push(current);
        continue;
      }

      if (!current) {
        warnings.push(`Line ${lineNo}: value line appears before any [key] section, skipping: ${line}`);
        continue;
      }
      const v = parseValueLine(line, lineNo, warnings);
      if (v) current.values.push(v);
    }

    if (keys.length === 0) {
      warnings.push('This file has a valid header but defines no registry keys.');
    }

    return { format, encoding, keys, warnings };
  }

  // ---- rendering helpers for the UI ----

  function formatValueData(v) {
    if (v.deleted) return '(value deleted)';
    if (v.error) return `(could not decode: ${v.error})`;
    switch (v.type) {
      case 'REG_SZ':
      case 'REG_EXPAND_SZ':
        return v.data;
      case 'REG_DWORD':
      case 'REG_DWORD_BIG_ENDIAN':
        return `0x${v.data.toString(16).padStart(8, '0')} (${v.data})`;
      case 'REG_QWORD':
        return `0x${v.data.toString(16).padStart(16, '0')} (${v.data.toString()})`;
      case 'REG_MULTI_SZ':
        return v.data.join('\n');
      default:
        if (v.bytes) return bytesToHexPreview(v.data, 64);
        return String(v.data);
    }
  }

  function summarize(parsed) {
    let keysCreated = 0, keysDeleted = 0, valuesSet = 0, valuesDeleted = 0;
    for (const k of parsed.keys) {
      if (k.deleted) keysDeleted++; else keysCreated++;
      for (const v of k.values) {
        if (v.deleted) valuesDeleted++; else valuesSet++;
      }
    }
    return { keysCreated, keysDeleted, valuesSet, valuesDeleted };
  }

  // Flattens the parsed structure into rows suitable for CSV/JSON export.
  function toRows(parsed) {
    const rows = [];
    for (const k of parsed.keys) {
      if (k.values.length === 0) {
        rows.push({ key: k.path, keyDeleted: k.deleted, name: null, isDefault: false, type: null, data: null, valueDeleted: null });
        continue;
      }
      for (const v of k.values) {
        rows.push({
          key: k.path,
          keyDeleted: k.deleted,
          name: v.isDefault ? '(Default)' : v.name,
          isDefault: !!v.isDefault,
          type: v.deleted ? null : v.type,
          data: v.deleted ? null : formatValueData(v),
          valueDeleted: !!v.deleted,
        });
      }
    }
    return rows;
  }

  return {
    RegParseError,
    parseRegBuffer,
    formatValueData,
    summarize,
    toRows,
    bytesToHexPreview,
    // exposed for testing
    _internal: { detectAndDecode, splitLogicalLines, parseQuoted, parseHexBytes, parseValueLine, utf16leToString, multiSzFromBytes },
  };
});
