const $ = (id) => document.getElementById(id);

let currentParsed = null;
let currentFileBase = 'export';

function setStatus(msg, isError) {
  const el = $('status');
  el.textContent = msg || '';
  el.classList.toggle('error', !!isError);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function handleFile(file) {
  $('fname').textContent = file.name;
  currentFileBase = (file.name || 'export').replace(/\.reg$/i, '');
  setStatus('Reading and parsing…');
  $('summaryCard').style.display = 'none';
  $('resultsCard').style.display = 'none';
  $('warningsCard').style.display = 'none';
  $('exportRow').style.display = 'none';
  currentParsed = null;
  try {
    const buf = await file.arrayBuffer();
    const parsed = RegParser.parseRegBuffer(buf);
    currentParsed = parsed;
    render(parsed);
    setStatus(`Parsed ${parsed.format === 'REGEDIT4' ? 'a legacy REGEDIT4' : 'a Windows Registry Editor 5.00'} file with ${parsed.keys.length} key section(s).`);
  } catch (err) {
    setStatus((err && err.message) || String(err), true);
  }
}

function render(parsed) {
  const summary = RegParser.summarize(parsed);
  $('summaryCard').style.display = '';
  $('summaryBadge').textContent = parsed.format === 'REGEDIT4' ? 'REGEDIT4 (legacy)' : 'Registry Editor 5.00';
  const bits = [];
  if (summary.keysCreated) bits.push(`${summary.keysCreated} key${summary.keysCreated === 1 ? '' : 's'} created or updated`);
  if (summary.keysDeleted) bits.push(`${summary.keysDeleted} key${summary.keysDeleted === 1 ? '' : 's'} marked for deletion`);
  if (summary.valuesSet) bits.push(`${summary.valuesSet} value${summary.valuesSet === 1 ? '' : 's'} set`);
  if (summary.valuesDeleted) bits.push(`${summary.valuesDeleted} value${summary.valuesDeleted === 1 ? '' : 's'} marked for deletion`);
  $('summaryText').textContent = bits.length ? `This file will: ${bits.join(', ')}.` : 'This file defines no changes.';

  $('resultsCard').style.display = parsed.keys.length ? '' : 'none';
  $('results').innerHTML = parsed.keys.map(renderKey).join('');

  if (parsed.warnings.length) {
    $('warningsCard').style.display = '';
    $('warningsList').innerHTML = parsed.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
  }

  $('exportRow').style.display = parsed.keys.length ? 'flex' : 'none';
}

function renderKey(key) {
  const badge = key.deleted
    ? '<span class="badge badge-del">will be deleted</span>'
    : '<span class="badge">created / updated</span>';
  let rows;
  if (key.deleted) {
    rows = '<p class="note">This key and everything under it will be removed.</p>';
  } else if (key.values.length === 0) {
    rows = '<p class="note">No values listed (the key itself will still be created if missing).</p>';
  } else {
    rows = '<table><tbody>' + key.values.map(renderValueRow).join('') + '</tbody></table>';
  }
  return `<div class="entry"><h2>${escapeHtml(key.path)} ${badge}</h2>${rows}</div>`;
}

function renderValueRow(v) {
  const name = v.isDefault ? '(Default)' : v.name;
  if (v.deleted) {
    return `<tr class="del-row"><td>${escapeHtml(name)}</td><td colspan="2">value will be deleted</td></tr>`;
  }
  const data = RegParser.formatValueData(v);
  return `<tr><td>${escapeHtml(name)}</td><td class="type-cell">${escapeHtml(v.type)}</td><td>${escapeHtml(data)}</td></tr>`;
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportJson() {
  if (!currentParsed) return;
  const rows = RegParser.toRows(currentParsed);
  download(`${currentFileBase}.json`, JSON.stringify(rows, null, 2), 'application/json');
}

function csvEscape(s) {
  const str = s == null ? '' : String(s);
  if (/[",\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

function exportCsv() {
  if (!currentParsed) return;
  const rows = RegParser.toRows(currentParsed);
  const header = ['key', 'keyDeleted', 'name', 'type', 'data', 'valueDeleted'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.key, r.keyDeleted, r.name, r.type, r.data, r.valueDeleted].map(csvEscape).join(','));
  }
  download(`${currentFileBase}.csv`, lines.join('\r\n') + '\r\n', 'text/csv');
}

function bindDrop() {
  const dz = $('dropzone');
  const input = $('fileInput');
  const setDrag = (on) => dz.classList.toggle('drag', on);
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); setDrag(true); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); setDrag(false); }));
  dz.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => {
    if (input.files && input.files[0]) handleFile(input.files[0]);
    input.value = '';
  });
}

bindDrop();
$('exportJsonBtn').addEventListener('click', exportJson);
$('exportCsvBtn').addEventListener('click', exportCsv);
