// List import - bring a collection in from a CSV (e.g. Letterboxd, a MAL/Trakt
// CSV export) or from a MediaListory JSON export. Everything runs client-side:
// each row is matched against the right provider, previewed, then added through
// the normal POST /user/games endpoint. No new backend surface.
//
// Anime needs one extra step. MyAnimeList has no concept of a franchise: every
// season is its own entry with its own score, so an export carries six separate
// Attack on Titan rows. Importing those as six library entries would fight the
// rest of the app, which shows a franchise as one title - and would let one show
// eat six slots of a Top 10 and count as six shared titles in Similar Taste.
//
// So anime rows are matched individually (the search is asked NOT to collapse,
// or the seasons could not be found at all), then grouped by the franchise key
// the server puts on every anime. Each group becomes one library entry plus a
// season rating per row, which is exactly what the rest of the app expects.
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
  function rawScore(v) {
    if (v == null || v === '') return null;
    var n = parseFloat(String(v).replace(',', '.'));
    return (Number.isFinite(n) && n > 0) ? n : null;
  }

  /* Which scale a file is written in, decided from the file as a whole rather
     than row by row.

     Row by row is ambiguous and gets it wrong: a 5 is full marks on Letterboxd
     and a middling score on MyAnimeList, and doubling it turns "this was okay"
     into "this was perfect". Looking at the highest score in the file settles
     it - nobody exports a list where nothing scored above 5 out of 10. */
  function detectScale(values) {
    var max = 0;
    values.forEach(function (v) { if (v != null && v > max) max = v; });
    if (max > 10) return 100;
    if (max > 5) return 10;
    return 5;
  }

  function scaleScore(n, scale) {
    if (n == null) return null;
    var out = scale === 100 ? Math.round(n / 10)
      : scale === 5 ? Math.round(n * 2)
        : Math.round(n);
    return Math.max(1, Math.min(10, out));
  }

  /* Second pass over parsed rows: `score` is the raw number until now. */
  function applyScoreScale(rows) {
    var scale = detectScale(rows.map(function (r) { return r.score; }));
    rows.forEach(function (r) { r.score = scaleScore(r.score, scale); });
    return rows;
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
        score: rawScore(iScore >= 0 ? cols[iScore] : null)
      });
    }
    return applyScoreScale(out);
  }

  function rowsFromJSON(obj, defaultType) {
    var out = [];
    function pushEntry(e) {
      if (!e || !e.name) return;
      out.push({
        title: e.name,
        type: (defaultType === 'auto') ? normType(e.media_type, 'movie') : defaultType,
        status: normStatus(e.status),
        score: rawScore(e.score),
        ref: e.game_id || null // our own export carries the catalog ref
      });
    }
    if (Array.isArray(obj.collection)) obj.collection.forEach(pushEntry);
    if (Array.isArray(obj.custom_lists)) obj.custom_lists.forEach(function (l) {
      (l.games || []).forEach(pushEntry);
    });
    if (!out.length && Array.isArray(obj)) obj.forEach(pushEntry);
    return applyScoreScale(out);
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

  async function searchMany(type, title, limit) {
    try {
      var body = { search: title, limit: limit || 5 };
      // The anime grid folds a franchise into one result. Here we are matching
      // one title at a time and specifically need the individual seasons back.
      if (type === 'anime') body.collapse = false;
      var res = await global.apiFetch(SEARCH_PATH[type], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
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

  // ── Picking the right candidate ─────────────────────────────────────────
  // Search ranks on the catalog title, which is the right call for someone
  // browsing. Importing is the opposite situation: the row already names a
  // specific title, so an exact hit on any of that entry's names is the answer.
  // A MyAnimeList export is entirely romanized Japanese - "Shingeki no Kyojin"
  // for a show the catalog calls "Attack on Titan" - and without checking the
  // other names the closest thing to a match is a 360° theatre exhibit whose
  // catalog title happens to start with the same words.

  function normTitle(v) {
    return String(v == null ? '' : v)
      .toLowerCase()
      .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function titleDistance(query, name) {
    if (!name) return 9;
    if (name === query) return 0;
    if (name.indexOf(query + ' ') === 0) return 1;
    if (name.indexOf(query) === 0) return 2;
    if ((' ' + name + ' ').indexOf(' ' + query + ' ') !== -1) return 3;
    if (name.indexOf(query) !== -1) return 4;
    return 9;
  }

  function candidateDistance(query, c) {
    if (!c) return 9;
    var names = [c.name].concat(c.alt_titles || []).filter(Boolean).map(normTitle);
    var best = 9;
    for (var i = 0; i < names.length; i++) best = Math.min(best, titleDistance(query, names[i]));
    return best;
  }

  /* Index of the best candidate. Ties keep the provider's own order, so when
     nothing matches by name the search's ranking still decides. */
  function bestCandidate(title, cands) {
    var query = normTitle(title);
    var bestIdx = 0, best = 10;
    for (var i = 0; i < cands.length; i++) {
      var d = candidateDistance(query, cands[i]);
      if (d < best) { best = d; bestIdx = i; }
    }
    return bestIdx;
  }

  async function runMatching() {
    matches = [];
    var progress = document.getElementById('imp-match-progress');
    for (var i = 0; i < parsedRows.length; i++) {
      var row = parsedRows[i];
      if (progress) progress.textContent = 'Matching ' + (i + 1) + ' of ' + parsedRows.length + '…';
      if (row.ref) {
        // Trusted MediaListory ref - no search needed.
        matches.push({ row: row, candidates: [], selected: 0, match: { name: row.title }, gameData: { media_type: row.type, name: row.title, game_id: row.ref } });
      } else {
        var cands = await searchMany(row.type, row.title);
        var pick = cands.length ? bestCandidate(row.title, cands) : 0;
        matches.push({
          row: row, candidates: cands, selected: pick,
          match: cands[pick] || null,
          gameData: cands[pick] ? buildGameData(row.type, cands[pick]) : null
        });
        await sleep(140); // stay friendly to the provider rate limiter
      }
    }
  }

  // ── Anime franchise grouping ────────────────────────────────────────────
  // Turns several matched season rows into one parent row that carries the
  // others as `seasons`. Rows that get folded are marked `foldedInto` so the
  // preview and the add step both skip them.

  function releasedTime(m) {
    var t = Date.parse((m && m.match && m.match.released) || '');
    return isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
  }

  // The franchise key is the parent's own title, normalized, so it doubles as a
  // way to go and find the parent when the list never mentioned it.
  async function findFranchiseParent(key) {
    var cands = await searchMany('anime', key, 10);
    for (var i = 0; i < cands.length; i++) {
      if (cands[i].franchise_key === key && !cands[i].franchise_sequel) return cands[i];
    }
    return null;
  }

  async function groupAnimeFranchises() {
    var groups = {};
    matches.forEach(function (m, idx) {
      if (!m.gameData || m.row.type !== 'anime') return;
      var key = m.match && m.match.franchise_key;
      if (!key) return;
      (groups[key] = groups[key] || []).push(idx);
    });

    for (var key in groups) {
      var idxs = groups[key];
      if (idxs.length < 2) continue;

      // Prefer the entry that is nobody's sequel; that is the franchise itself.
      var parentIdx = -1;
      for (var i = 0; i < idxs.length; i++) {
        if (!matches[idxs[i]].match.franchise_sequel) { parentIdx = idxs[i]; break; }
      }

      var parent = matches[parentIdx];
      if (parentIdx === -1) {
        /* The list had seasons 2 and 3 but never season 1. Rather than filing
           the whole run under "Season 2", go and fetch the real parent and add
           that, so the library entry is the show and not a fragment of it. */
        var found = await findFranchiseParent(key);
        await sleep(140);
        var earliest = idxs.slice().sort(function (a, b) { return releasedTime(matches[a]) - releasedTime(matches[b]); })[0];
        if (!found) { parentIdx = earliest; parent = matches[parentIdx]; }
        else {
          parent = {
            row: { title: found.name, type: 'anime', status: null, score: null },
            candidates: [], selected: 0, match: found, gameData: buildGameData('anime', found),
            addedForFranchise: true
          };
          matches.push(parent);
          parentIdx = matches.length - 1;
          idxs = idxs.concat([parentIdx]);
        }
      }

      parent.seasons = [];
      idxs.forEach(function (idx) {
        if (idx === parentIdx) return;
        matches[idx].foldedInto = parentIdx;
        parent.seasons.push(matches[idx]);
      });
      /* A parent that came from the user's own list is a season in its own
         right, so its score belongs on season 1 as much as on the title. */
      if (!parent.addedForFranchise) parent.seasons.push(parent);
      parent.seasons.sort(function (a, b) { return releasedTime(a) - releasedTime(b); });
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
            '<p class="imp-help" style="margin-top:-4px;">Importing from a single-category site (Letterboxd → Movies, MAL → Anime, a games export → Games)? Pick that category. A mixed export (e.g. movies + shows, or a MediaListory backup) can use Auto-detect, and each title still lands in its own category.</p>' +
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
    await groupAnimeFranchises();
    renderPreview();
  }

  function renderPreview() {
    var visible = matches.filter(function (m) { return m.foldedInto == null; });
    var matched = visible.filter(function (m) { return m.gameData; });
    var folded = matches.filter(function (m) { return m.foldedInto != null; }).length;
    var fromList = matches.filter(function (m) { return !m.addedForFranchise; }).length;
    var progress = document.getElementById('imp-match-progress');
    if (progress) progress.textContent = '';
    var missed = visible.length - matched.length;
    overlay.querySelector('#impPreviewSummary').innerHTML =
      '<strong>' + matched.length + '</strong> of ' + fromList + ' rows matched. ' +
      (missed ? missed + ' could not be found and will be skipped. ' : '') +
      (folded ? folded + ' anime ' + (folded === 1 ? 'row was a season' : 'rows were seasons') +
        ' of a show already listed here, and will come in as season ratings rather than separate entries.' : '');
    overlay.querySelector('#impPreviewRows').innerHTML = matches.map(function (m, idx) {
      if (m.foldedInto != null) return '';
      var ok = !!m.gameData;
      var cat = m.row.type;
      // Match cell: a picker when there's a choice, else the single matched title.
      var matchCell;
      if (m.seasons) {
        /* No picker on a franchise: the grouping already settled which entry
           this is, and letting it be changed here would leave the seasons
           hanging off a title they do not belong to. */
        matchCell = '<span class="imp-title-match">→ ' + esc(m.match.name) + '</span>' +
          '<span class="imp-title-sub">' + m.seasons.length + ' seasons from your list</span>';
      } else if (ok && m.candidates && m.candidates.length > 1) {
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
        '<td class="imp-c-status">' + (ok ? '<span class="imp-ok">✓</span>' : '<span class="imp-miss">-</span>') + '</td>' +
        '<td class="imp-c-title"><span class="imp-title-in">' + esc(m.row.title) + '</span>' + matchCell + '</td>' +
        '<td><span class="cal-badge cal-badge-' + cat + '">' + (CAT_LABEL[cat] || '') + '</span></td>' +
        '<td class="imp-c-meta">' + (m.addedForFranchise
          ? '<span class="imp-title-sub">from your season rows</span>'
          : esc(global.statusLabel ? global.statusLabel(m.row.status, cat) : m.row.status) +
            (m.row.score ? ' · ' + m.row.score + '/10' : '')) + '</td></tr>';
    }).join('');
    var addBtn = overlay.querySelector('#impAddBtn');
    addBtn.disabled = matched.length === 0;
    addBtn.textContent = matched.length ? ('Add ' + matched.length + ' matched title' + (matched.length === 1 ? '' : 's')) : 'Nothing to add';
  }

  /* Places each folded row on the right season of the parent that just landed.
     Seasons are matched by catalog ref, not by name: both sides come from the
     same provider, so the ref is exact and survives a rename. Anything the
     season list does not know about is added as its own entry instead, because
     losing a title the user actually rated is the one unacceptable outcome. */
  /* Every season of every anime added so far, as ref -> {parent, number}.

     Grouping by title cannot see a franchise whose seasons are named by arc
     rather than numbered - Demon Slayer's "Yuukaku-hen" and "Katanakaji no
     Sato-hen" share no stem to strip. But the season list the server builds for
     the first of them walks Kitsu's sequel chain and comes back with the whole
     run, which names the second one. So each added anime teaches us its
     siblings, and a later row that turns out to be one of them becomes a season
     rating instead of a second library entry for the same show.

     That matters beyond tidiness: two entries for one franchise would take two
     slots in a Top 10 and count twice in Similar Taste. */
  var seasonIndex = {};

  async function loadSeasonIndex(parentRef) {
    var seasons = [];
    try {
      var r = await global.apiFetch('/user/games/' + encodeURIComponent(parentRef) + '/seasons');
      if (r.ok) seasons = (await r.json()).seasons || [];
    } catch (e) { /* no index: rows simply stay separate entries */ }
    seasons.forEach(function (s) {
      if (s.external_ref && !seasonIndex[s.external_ref]) {
        seasonIndex[s.external_ref] = { parent: parentRef, number: s.season_number };
      }
    });
    return seasons;
  }

  async function rateSeason(parentRef, number, row) {
    try {
      var put = await global.apiFetch('/user/games/' + encodeURIComponent(parentRef) + '/seasons/' + number, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: row.status || null, score: row.score })
      });
      return put.ok;
    } catch (e) { return false; }
  }

  /* Places each folded row on the right season of the parent that just landed.
     Seasons are matched by catalog ref, not by name: both sides come from the
     same provider, so the ref is exact and survives a rename. Anything the
     season list does not know about is added as its own entry instead, because
     losing a title the user actually rated is the one unacceptable outcome. */
  async function applySeasons(parent) {
    var ref = parent.gameData && parent.gameData.game_id;
    if (!ref) return { rated: 0, leftover: [] };

    await loadSeasonIndex(ref);

    var rated = 0, leftover = [];
    var members = parent.seasons || [];
    for (var i = 0; i < members.length; i++) {
      var member = members[i];
      var memberRef = member.gameData && member.gameData.game_id;
      var slot = seasonIndex[memberRef];
      if (!slot || slot.parent !== ref) { if (member !== parent) leftover.push(member); continue; }
      if (await rateSeason(ref, slot.number, member.row)) rated++;
      await sleep(90);
    }
    return { rated: rated, leftover: leftover };
  }

  async function onAdd() {
    var toAdd = matches.filter(function (m) { return m.gameData && m.foldedInto == null; });
    if (!toAdd.length) return;
    show('run');
    var fill = overlay.querySelector('#impRunFill');
    var msg = overlay.querySelector('#impRunMsg');
    var added = 0, dupe = 0, failed = 0, rated = 0;
    async function addOne(m) {
      try {
        var res = await global.apiFetch('/user/games', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ game_data: m.gameData, status: m.row.status, score: m.row.score })
        });
        if (res.ok) { added++; return true; }
        if (res.status === 400) {
          var d = await res.json().catch(function () { return {}; });
          if (/already/i.test(d.error || '')) { dupe++; return true; }
        }
        failed++;
      } catch (e) { failed++; }
      return false;
    }

    seasonIndex = {};
    for (var i = 0; i < toAdd.length; i++) {
      var m = toAdd[i];
      var ref = m.gameData.game_id;

      /* Already known as a season of something added a moment ago: rate it
         there instead of giving the same show a second library entry. */
      var known = m.row.type === 'anime' ? seasonIndex[ref] : null;
      if (known) {
        if (await rateSeason(known.parent, known.number, m.row)) rated++;
        fill.style.width = Math.round(((i + 1) / toAdd.length) * 100) + '%';
        await sleep(90);
        continue;
      }

      var landed = await addOne(m);
      if (landed && m.row.type === 'anime') {
        if (m.seasons) {
          msg.textContent = 'Adding seasons for ' + m.match.name + '…';
          var result = await applySeasons(m);
          rated += result.rated;
          // A season the provider does not list is still a title the user rated.
          for (var j = 0; j < result.leftover.length; j++) await addOne(result.leftover[j]);
        } else {
          /* Not part of a group by title, but it may still front a franchise -
             learn its siblings so later rows can land on it. */
          await loadSeasonIndex(ref);
          /* If it turns out to be one of its own seasons, its score has to be
             recorded there too. Otherwise the first sibling to fold in becomes
             the only rated season, and the overall is rewritten from that one
             row - quietly replacing the score the user actually gave. */
          var own = seasonIndex[ref];
          if (own && own.parent === ref && m.row.score != null) {
            if (await rateSeason(ref, own.number, m.row)) rated++;
          }
        }
      }
      fill.style.width = Math.round(((i + 1) / toAdd.length) * 100) + '%';
      msg.textContent = 'Adding ' + (i + 1) + ' of ' + toAdd.length + '… (' + added + ' added, ' + dupe + ' already there, ' + failed + ' failed)';
      await sleep(90);
    }
    msg.innerHTML = '<strong>Done.</strong> ' + added + ' added, ' + dupe + ' already in your library' +
      (rated ? ', ' + rated + ' season rating' + (rated === 1 ? '' : 's') + ' kept' : '') +
      (failed ? ', ' + failed + ' failed' : '') + '.';
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
