// List import — bring a collection in from a CSV (e.g. Letterboxd, a MAL/Trakt
// CSV export) or from a MediaListory JSON export. Everything runs client-side:
// each row is matched against the right provider, previewed, then added through
// the normal POST /user/games endpoint. No new backend surface.
(function (global) {
  'use strict';

  var CAT_LABEL = { movie: 'Movie', series: 'Show', anime: 'Anime', game: 'Game' };
  var SEARCH_PATH = { movie: '/tmdb/movies', series: '/tmdb/series', anime: '/kitsu/anime', game: '/igdb/games' };

  var built = false;
  var overlay, phaseInput, phasePreview, phaseRun;
  var parsedRows = [];   // {title, type, status, score}
  var matches = [];      // {row, match|null, gameData|null}

  function esc(s) { return (global.esc ? global.esc(s) : String(s == null ? '' : s)); }

  // ── Normalization helpers ───────────────────────────────────────────────
  function normType(v, fallback) {
    var t = String(v || '').trim().toLowerCase();
    if (/film|movie/.test(t)) return 'movie';
    if (/show|series|\btv\b/.test(t)) return 'series';
    if (/anime/.test(t)) return 'anime';
    if (/game/.test(t)) return 'game';
    return fallback || 'movie';
  }
  function normStatus(v) {
    var s = String(v || '').trim().toLowerCase();
    if (/complet|watched|finish|\bplayed\b|\bseen\b/.test(s)) return 'completed';
    if (/watching|playing|current|in.?progress/.test(s)) return 'playing';
    if (/hold|paus/.test(s)) return 'on_hold';
    if (/drop/.test(s)) return 'dropped';
    if (/plan|watchlist|want|backlog|wish/.test(s)) return 'plan_to_play';
    return 'plan_to_play';
  }
  function normScore(v) {
    if (v == null || v === '') return null;
    var n = parseFloat(String(v).replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n <= 5) n = Math.round(n * 2);        // 5-star (incl. halves) -> /10
    else if (n > 10) n = Math.round(n / 10);  // /100 -> /10
    else n = Math.round(n);
    return Math.max(1, Math.min(10, n));
  }

  // ── Minimal CSV parser (quotes, commas, CRLF) ───────────────────────────
  function parseCSV(text) {
    var rows = [], row = [], field = '', i = 0, inQ = false;
    while (i < text.length) {
      var c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (c === '\r') { /* skip */ }
        else field += c;
      }
      i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (x) { return String(x).trim() !== ''; }); });
  }

  function indexOfHeader(headers, keys) {
    for (var k = 0; k < keys.length; k++) {
      for (var h = 0; h < headers.length; h++) {
        if (headers[h].indexOf(keys[k]) !== -1) return h;
      }
    }
    return -1;
  }

  function rowsFromCSV(text, defaultType) {
    var raw = parseCSV(text);
    if (!raw.length) return [];
    var first = raw[0].map(function (x) { return String(x).trim().toLowerCase(); });
    var hasHeader = first.some(function (h) { return /title|name|type|status|score|rating|category/.test(h); });
    var iTitle = 0, iType = -1, iStatus = -1, iScore = -1, start = 0;
    if (hasHeader) {
      iTitle = indexOfHeader(first, ['title', 'name']); if (iTitle < 0) iTitle = 0;
      iType = indexOfHeader(first, ['type', 'category', 'media']);
      iStatus = indexOfHeader(first, ['status', 'state']);
      iScore = indexOfHeader(first, ['score', 'rating', 'my rating']);
      start = 1;
    } else { iTitle = 0; iType = 1; iStatus = 2; iScore = 3; }
    var out = [];
    for (var r = start; r < raw.length; r++) {
      var cols = raw[r];
      var title = (cols[iTitle] || '').trim();
      if (!title) continue;
      out.push({
        title: title,
        type: (defaultType === 'auto') ? normType(iType >= 0 ? cols[iType] : '', 'movie') : defaultType,
        status: normStatus(iStatus >= 0 ? cols[iStatus] : ''),
        score: normScore(iScore >= 0 ? cols[iScore] : null)
      });
    }
    return out;
  }

  function rowsFromJSON(obj, defaultType) {
    var out = [];
    function pushEntry(e) {
      if (!e || !e.name) return;
      out.push({
        title: e.name,
        type: (defaultType === 'auto') ? normType(e.media_type, 'movie') : defaultType,
        status: normStatus(e.status),
        score: normScore(e.score),
        ref: e.game_id || null // our own export carries the catalog ref
      });
    }
    if (Array.isArray(obj.collection)) obj.collection.forEach(pushEntry);
    if (Array.isArray(obj.custom_lists)) obj.custom_lists.forEach(function (l) {
      (l.games || []).forEach(pushEntry);
    });
    if (!out.length && Array.isArray(obj)) obj.forEach(pushEntry);
    return out;
  }

  // ── Matching ────────────────────────────────────────────────────────────
  function buildGameData(type, m, rawRef) {
    if (type === 'game') {
      var url = m.cover && m.cover.url ? ('https:' + m.cover.url.replace('t_thumb', 't_cover_big')) : null;
      var released = m.first_release_date ? new Date(m.first_release_date * 1000).toISOString().slice(0, 10) : null;
      return {
        media_type: 'game', provider: 'igdb', provider_id: String(m.id), igdb_id: m.id,
        game_id: 'igdb_' + m.id, name: m.name, background_image: url, released: released,
        genres: m.genres || []
      };
    }
    return {
      media_type: m.media_type || type, provider: m.provider, provider_id: m.provider_id,
      tmdb_id: m.tmdb_id, game_id: m.id || rawRef, name: m.name,
      background_image: m.background_image || null, released: m.released || null,
      number_of_episodes: m.number_of_episodes, genres: m.genres || []
    };
  }

  async function searchMany(type, title) {
    try {
      var res = await global.apiFetch(SEARCH_PATH[type], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ search: title, limit: 5 })
      });
      if (!res.ok) return [];
      var data = await res.json();
      var arr = Array.isArray(data) ? data : (data.results || data.games || data.data || []);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function candidateName(type, c) {
    if (!c) return '';
    var yr = '';
    if (type === 'game' && c.first_release_date) yr = ' (' + new Date(c.first_release_date * 1000).getFullYear() + ')';
    else if (c.released) yr = ' (' + String(c.released).slice(0, 4) + ')';
    return (c.name || 'Untitled') + yr;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function runMatching() {
    matches = [];
    var progress = document.getElementById('imp-match-progress');
    for (var i = 0; i < parsedRows.length; i++) {
      var row = parsedRows[i];
      if (progress) progress.textContent = 'Matching ' + (i + 1) + ' of ' + parsedRows.length + '…';
      if (row.ref) {
        // Trusted MediaListory ref — no search needed.
        matches.push({ row: row, candidates: [], selected: 0, match: { name: row.title }, gameData: { media_type: row.type, name: row.title, game_id: row.ref } });
      } else {
        var cands = await searchMany(row.type, row.title);
        matches.push({
          row: row, candidates: cands, selected: 0,
          match: cands[0] || null,
          gameData: cands[0] ? buildGameData(row.type, cands[0]) : null
        });
        await sleep(140); // stay friendly to the provider rate limiter
      }
    }
  }

  // ── UI ──────────────────────────────────────────────────────────────────
  function build() {
    if (built) return;
    built = true;
    overlay = document.createElement('div');
    overlay.className = 'imp-overlay';
    overlay.id = 'importOverlay';
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="imp-box" role="dialog" aria-modal="true" aria-labelledby="impTitle">' +
        '<div class="imp-head"><h3 id="impTitle">Import a list</h3>' +
          '<button type="button" class="imp-close" id="impClose" aria-label="Close">&times;</button></div>' +
        '<div class="imp-body">' +
          '<div id="impPhaseInput">' +
            '<p class="imp-help">Paste a <strong>CSV</strong> (e.g. a Letterboxd, MAL or Trakt export) or a MediaListory JSON export, or choose a file. ' +
            'CSV columns we look for: <em>title, type, status, score</em>.</p>' +
            '<label class="imp-field"><span>What are you importing?</span>' +
              '<select id="impDefaultType" class="form-input">' +
                '<option value="auto" selected>Auto-detect from the file</option>' +
                '<option value="movie">Movies only</option><option value="series">Shows only</option>' +
                '<option value="anime">Anime only</option><option value="game">Games only</option>' +
              '</select></label>' +
            '<p class="imp-help" style="margin-top:-4px;">Importing from a single-category site (Letterboxd → Movies, MAL → Anime, a games export → Games)? Pick that category. A mixed export (e.g. movies + shows, or a MediaListory backup) can use Auto-detect — each title still lands in its own category.</p>' +
            '<textarea id="impText" class="form-input imp-textarea" placeholder="Paste CSV or JSON here…"></textarea>' +
            '<div class="imp-orfile"><input type="file" id="impFile" accept=".csv,.json,.txt"></div>' +
            '<div id="impInputMsg" class="imp-msg"></div>' +
            '<div class="imp-actions"><button type="button" class="btn btn-primary" id="impParseBtn">Preview matches</button></div>' +
          '</div>' +
          '<div id="impPhasePreview" hidden>' +
            '<div id="imp-match-progress" class="imp-msg"></div>' +
            '<div class="imp-summary" id="impPreviewSummary"></div>' +
            '<div class="imp-table-wrap"><table class="imp-table"><tbody id="impPreviewRows"></tbody></table></div>' +
            '<div class="imp-actions">' +
              '<button type="button" class="btn btn-secondary" id="impBackBtn">Back</button>' +
              '<button type="button" class="btn btn-primary" id="impAddBtn">Add matched titles</button>' +
            '</div>' +
          '</div>' +
          '<div id="impPhaseRun" hidden>' +
            '<div class="imp-run-bar"><span id="impRunFill" class="imp-run-fill"></span></div>' +
            '<div id="impRunMsg" class="imp-msg"></div>' +
            '<div class="imp-actions"><button type="button" class="btn btn-primary" id="impDoneBtn" hidden>Done</button></div>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    phaseInput = overlay.querySelector('#impPhaseInput');
    phasePreview = overlay.querySelector('#impPhasePreview');
    phaseRun = overlay.querySelector('#impPhaseRun');

    overlay.querySelector('#impClose').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    overlay.querySelector('#impFile').addEventListener('change', onFile);
    overlay.querySelector('#impParseBtn').addEventListener('click', onParse);
    overlay.querySelector('#impBackBtn').addEventListener('click', function () { show('input'); });
    overlay.querySelector('#impPreviewRows').addEventListener('change', function (e) {
      var sel = e.target.closest('.imp-pick');
      if (!sel) return;
      var idx = parseInt(sel.getAttribute('data-idx'), 10);
      var m = matches[idx];
      if (!m) return;
      m.selected = parseInt(sel.value, 10) || 0;
      m.match = m.candidates[m.selected] || null;
      m.gameData = m.match ? buildGameData(m.row.type, m.match) : null;
    });
    overlay.querySelector('#impAddBtn').addEventListener('click', onAdd);
    overlay.querySelector('#impDoneBtn').addEventListener('click', close);
    document.addEventListener('keydown', function (e) { if (!overlay.hidden && e.key === 'Escape') close(); });
  }

  function show(phase) {
    phaseInput.hidden = phase !== 'input';
    phasePreview.hidden = phase !== 'preview';
    phaseRun.hidden = phase !== 'run';
  }

  function open() {
    build();
    show('input');
    overlay.hidden = false;
    document.body.classList.add('imp-open');
    var ta = overlay.querySelector('#impText'); if (ta) ta.focus();
  }
  function close() {
    if (overlay) { overlay.hidden = true; document.body.classList.remove('imp-open'); }
  }

  function onFile(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () { overlay.querySelector('#impText').value = String(reader.result || ''); };
    reader.readAsText(file);
  }

  async function onParse() {
    var text = overlay.querySelector('#impText').value.trim();
    var msg = overlay.querySelector('#impInputMsg');
    var defaultType = overlay.querySelector('#impDefaultType').value;
    if (!text) { msg.textContent = 'Paste some CSV or JSON first, or choose a file.'; msg.className = 'imp-msg error'; return; }

    try {
      if (text[0] === '{' || text[0] === '[') {
        parsedRows = rowsFromJSON(JSON.parse(text), defaultType);
      } else {
        parsedRows = rowsFromCSV(text, defaultType);
      }
    } catch (err) {
      msg.textContent = 'Could not read that. If it is CSV, make sure it is comma-separated.'; msg.className = 'imp-msg error'; return;
    }
    if (!parsedRows.length) { msg.textContent = 'No rows found to import.'; msg.className = 'imp-msg error'; return; }
    if (parsedRows.length > 100) parsedRows = parsedRows.slice(0, 100);

    msg.textContent = '';
    show('preview');
    overlay.querySelector('#impAddBtn').disabled = true;
    overlay.querySelector('#impPreviewRows').innerHTML = '';
    overlay.querySelector('#impPreviewSummary').textContent = '';
    await runMatching();
    renderPreview();
  }

  function renderPreview() {
    var matched = matches.filter(function (m) { return m.gameData; });
    var progress = document.getElementById('imp-match-progress');
    if (progress) progress.textContent = '';
    overlay.querySelector('#impPreviewSummary').innerHTML =
      '<strong>' + matched.length + '</strong> of ' + matches.length + ' rows matched. ' +
      (matches.length - matched.length ? (matches.length - matched.length) + ' could not be found and will be skipped.' : '');
    overlay.querySelector('#impPreviewRows').innerHTML = matches.map(function (m, idx) {
      var ok = !!m.gameData;
      var cat = m.row.type;
      // Match cell: a picker when there's a choice, else the single matched title.
      var matchCell;
      if (ok && m.candidates && m.candidates.length > 1) {
        var opts = m.candidates.map(function (c, i) {
          return '<option value="' + i + '"' + (i === m.selected ? ' selected' : '') + '>' + esc(candidateName(cat, c)) + '</option>';
        }).join('');
        matchCell = '<select class="imp-pick" data-idx="' + idx + '" aria-label="Choose the match for ' + esc(m.row.title) + '">' + opts + '</select>';
      } else if (ok && m.match && m.match.name && m.match.name !== m.row.title) {
        matchCell = '<span class="imp-title-match">→ ' + esc(m.match.name) + '</span>';
      } else {
        matchCell = '';
      }
      return '<tr class="' + (ok ? '' : 'imp-row-miss') + '" data-idx="' + idx + '">' +
        '<td class="imp-c-status">' + (ok ? '<span class="imp-ok">✓</span>' : '<span class="imp-miss">—</span>') + '</td>' +
        '<td class="imp-c-title"><span class="imp-title-in">' + esc(m.row.title) + '</span>' + matchCell + '</td>' +
        '<td><span class="cal-badge cal-badge-' + cat + '">' + (CAT_LABEL[cat] || '') + '</span></td>' +
        '<td class="imp-c-meta">' + esc(global.statusLabel ? global.statusLabel(m.row.status, cat) : m.row.status) +
          (m.row.score ? ' · ' + m.row.score + '/10' : '') + '</td></tr>';
    }).join('');
    var addBtn = overlay.querySelector('#impAddBtn');
    addBtn.disabled = matched.length === 0;
    addBtn.textContent = matched.length ? ('Add ' + matched.length + ' matched title' + (matched.length === 1 ? '' : 's')) : 'Nothing to add';
  }

  async function onAdd() {
    var toAdd = matches.filter(function (m) { return m.gameData; });
    if (!toAdd.length) return;
    show('run');
    var fill = overlay.querySelector('#impRunFill');
    var msg = overlay.querySelector('#impRunMsg');
    var added = 0, dupe = 0, failed = 0;
    for (var i = 0; i < toAdd.length; i++) {
      var m = toAdd[i];
      try {
        var res = await global.apiFetch('/user/games', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ game_data: m.gameData, status: m.row.status, score: m.row.score })
        });
        if (res.ok) added++;
        else if (res.status === 400) { var d = await res.json().catch(function () { return {}; }); (/already/i.test(d.error || '') ? dupe++ : failed++); }
        else failed++;
      } catch (e) { failed++; }
      fill.style.width = Math.round(((i + 1) / toAdd.length) * 100) + '%';
      msg.textContent = 'Adding ' + (i + 1) + ' of ' + toAdd.length + '… (' + added + ' added, ' + dupe + ' already there, ' + failed + ' failed)';
      await sleep(90);
    }
    msg.innerHTML = '<strong>Done.</strong> ' + added + ' added, ' + dupe + ' already in your library' + (failed ? ', ' + failed + ' failed' : '') + '.';
    overlay.querySelector('#impDoneBtn').hidden = false;
    if (global.toast) global.toast(added + ' title' + (added === 1 ? '' : 's') + ' imported', added ? 'success' : 'info');
  }

  function bind() {
    var btn = document.getElementById('importDataBtn');
    if (btn) btn.addEventListener('click', open);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})(typeof window !== 'undefined' ? window : this);
