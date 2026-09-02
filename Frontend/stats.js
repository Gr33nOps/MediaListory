// Your Stats / Year in Review — computed entirely client-side from the
// collection the API already returns (/user/games). No new backend needed.
(function () {
  'use strict';

  var CATS = ['movie', 'series', 'anime', 'game'];
  var CAT_LABEL = { movie: 'Movies', series: 'Shows', anime: 'Anime', game: 'Games' };
  var CAT_VAR = { movie: '--cat-movie', series: '--cat-series', anime: '--cat-anime', game: '--cat-game' };
  var STATUS_ORDER = ['completed', 'playing', 'plan_to_play', 'on_hold', 'dropped'];
  var STATUS_LABEL = { completed: 'Completed', playing: 'In progress', plan_to_play: 'Planned', on_hold: 'On hold', dropped: 'Dropped' };
  var STATUS_COLOR = { completed: '#10b981', playing: '#3b82f6', plan_to_play: '#8b5cf6', on_hold: '#f59e0b', dropped: '#ef4444' };

  var allItems = [];
  var currentYear = 'all';

  function esc(s) { return (window.esc ? window.esc(s) : String(s == null ? '' : s)); }
  function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim() || '#64748b'; }

  function yearOf(item) {
    var d = item.updated_at || item.created_at;
    if (!d) return null;
    var y = new Date(d).getFullYear();
    return Number.isFinite(y) ? y : null;
  }

  function genreNames(item) {
    var g = item.genres;
    if (!Array.isArray(g)) return [];
    return g.map(function (x) { return x && x.name ? x.name : (typeof x === 'string' ? x : null); }).filter(Boolean);
  }

  // Rough, clearly-labelled time estimate. Movies ~2h; episodes ~24m; games use
  // stored playtime (hours) or a modest default so the number stays honest.
  function hoursFor(item) {
    var mt = item.media_type || 'game';
    var st = item.status;
    if (mt === 'movie') return st === 'completed' ? 2 : 0;
    if (mt === 'series' || mt === 'anime') {
      var eps = 0;
      if (st === 'completed') eps = item.episode_count || item.progress || 12;
      else eps = item.progress || 0;
      return eps * 0.4;
    }
    // game
    var pt = Number(item.playtime) || 0;
    if (st === 'completed') return pt > 0 ? Math.min(pt, 400) : 20;
    if (st === 'playing') return pt > 0 ? Math.min(pt, 400) / 2 : 8;
    return 0;
  }

  function filtered() {
    if (currentYear === 'all') return allItems;
    return allItems.filter(function (i) { return yearOf(i) === currentYear; });
  }

  // ── Rendering helpers ───────────────────────────────────────────────────
  function tile(value, label, sub) {
    return '<div class="stat-tile"><span class="stat-tile-value">' + esc(value) + '</span>' +
      '<span class="stat-tile-label">' + esc(label) + '</span>' +
      (sub ? '<span class="stat-tile-sub">' + esc(sub) + '</span>' : '') + '</div>';
  }

  function barRow(label, count, max, color, pct) {
    var w = max > 0 ? Math.round((count / max) * 100) : 0;
    var meta = pct != null ? pct + '%' : String(count);
    return '<div class="st-bar-row">' +
      '<span class="st-bar-label">' + esc(label) + '</span>' +
      '<span class="st-bar-track"><span class="st-bar-fill" style="width:' + w + '%;background:' + color + '"></span></span>' +
      '<span class="st-bar-count">' + esc(meta) + '</span></div>';
  }

  function donut(segments, centerTop, centerSub) {
    var total = segments.reduce(function (s, x) { return s + x.value; }, 0);
    if (total <= 0) return '<div class="stats-empty-mini">No data yet</div>';
    var r = 52, c = 2 * Math.PI * r, off = 0;
    var circles = segments.filter(function (s) { return s.value > 0; }).map(function (s) {
      var frac = s.value / total, len = frac * c;
      var el = '<circle cx="70" cy="70" r="' + r + '" fill="none" stroke="' + s.color + '" stroke-width="16" ' +
        'stroke-dasharray="' + len.toFixed(2) + ' ' + (c - len).toFixed(2) + '" ' +
        'stroke-dashoffset="' + (-off).toFixed(2) + '" transform="rotate(-90 70 70)"></circle>';
      off += len;
      return el;
    }).join('');
    return '<svg viewBox="0 0 140 140" class="donut" role="img" aria-label="Breakdown">' + circles +
      '<text x="70" y="66" text-anchor="middle" class="donut-top">' + esc(centerTop) + '</text>' +
      '<text x="70" y="86" text-anchor="middle" class="donut-sub">' + esc(centerSub) + '</text></svg>';
  }

  function card(title, inner, cls) {
    return '<section class="stats-card ' + (cls || '') + '"><h2 class="stats-card-h">' + esc(title) + '</h2>' + inner + '</section>';
  }

  function render() {
    var items = filtered();
    var body = document.getElementById('statsBody');

    if (allItems.length === 0) {
      body.innerHTML = '<div class="stats-empty">' +
        '<p>Nothing tracked yet.</p>' +
        '<p class="stats-empty-sub">Add movies, shows, anime, or games and your stats will build up here.</p>' +
        '<a class="btn btn-primary" href="movies.html">Browse movies</a></div>';
      return;
    }
    if (items.length === 0) {
      body.innerHTML = card('Nothing here', '<div class="stats-empty-mini">No activity in ' + currentYear + '.</div>');
      return;
    }

    // Aggregate
    var byCat = {}, byStatus = {}, scoreHist = {}, genreTally = {}, monthTally = {};
    var totalHours = 0, scored = 0, scoreSum = 0, completed = 0;
    var top = null, recentDone = null;
    CATS.forEach(function (c) { byCat[c] = 0; });
    STATUS_ORDER.forEach(function (s) { byStatus[s] = 0; });
    for (var n = 1; n <= 10; n++) scoreHist[n] = 0;

    items.forEach(function (i) {
      var mt = i.media_type || 'game';
      if (byCat[mt] == null) byCat[mt] = 0;
      byCat[mt]++;
      if (byStatus[i.status] == null) byStatus[i.status] = 0;
      byStatus[i.status]++;
      if (i.status === 'completed') completed++;
      totalHours += hoursFor(i);
      if (i.score != null && i.score >= 1 && i.score <= 10) {
        scoreHist[i.score]++; scored++; scoreSum += Number(i.score);
        if (!top || Number(i.score) > Number(top.score)) top = i;
      }
      genreNames(i).forEach(function (g) { genreTally[g] = (genreTally[g] || 0) + 1; });
      var d = i.updated_at || i.created_at;
      if (d) {
        var key = new Date(d).toISOString().slice(0, 7); // YYYY-MM
        monthTally[key] = (monthTally[key] || 0) + 1;
      }
      if (i.status === 'completed') {
        if (!recentDone || new Date(i.updated_at || i.created_at) > new Date(recentDone.updated_at || recentDone.created_at)) recentDone = i;
      }
    });

    var mean = scored ? (scoreSum / scored) : 0;

    // ── Headline tiles ─────────────────────────────────────────────────
    var tiles = '<div class="stat-tiles">' +
      tile(items.length, 'Titles tracked') +
      tile(completed, 'Completed') +
      tile(Math.round(totalHours), 'Hours (est.)', 'movies · episodes · playtime') +
      tile(scored ? mean.toFixed(1) : '—', 'Mean score', scored ? scored + ' rated' : 'nothing rated yet') +
      '</div>';

    // ── Category breakdown ─────────────────────────────────────────────
    var catMax = Math.max.apply(null, CATS.map(function (c) { return byCat[c] || 0; }).concat([1]));
    var catBars = CATS.map(function (c) {
      return barRow(CAT_LABEL[c], byCat[c] || 0, catMax, css(CAT_VAR[c]));
    }).join('');
    var catDonut = donut(CATS.map(function (c) { return { value: byCat[c] || 0, color: css(CAT_VAR[c]) }; }),
      String(items.length), 'titles');
    var catCard = card('By category',
      '<div class="stats-split"><div class="stats-donut-wrap">' + catDonut + '</div><div class="stats-bars">' + catBars + '</div></div>');

    // ── Status breakdown ───────────────────────────────────────────────
    var stSegs = STATUS_ORDER.map(function (s) { return { value: byStatus[s] || 0, color: STATUS_COLOR[s] }; });
    var stMax = Math.max.apply(null, STATUS_ORDER.map(function (s) { return byStatus[s] || 0; }).concat([1]));
    var stBars = STATUS_ORDER.map(function (s) { return barRow(STATUS_LABEL[s], byStatus[s] || 0, stMax, STATUS_COLOR[s]); }).join('');
    var pctDone = items.length ? Math.round((completed / items.length) * 100) : 0;
    var statusCard = card('By status',
      '<div class="stats-split"><div class="stats-donut-wrap">' + donut(stSegs, pctDone + '%', 'completed') + '</div><div class="stats-bars">' + stBars + '</div></div>');

    // ── Score distribution ─────────────────────────────────────────────
    var scoreCard;
    if (scored) {
      var sMax = Math.max.apply(null, Object.keys(scoreHist).map(function (k) { return scoreHist[k]; }).concat([1]));
      var cols = '';
      for (var s = 1; s <= 10; s++) {
        var h = Math.round((scoreHist[s] / sMax) * 100);
        cols += '<div class="score-col" title="' + scoreHist[s] + ' rated ' + s + '">' +
          '<span class="score-bar" style="height:' + Math.max(h, 2) + '%"></span>' +
          '<span class="score-num">' + s + '</span></div>';
      }
      scoreCard = card('Score distribution', '<div class="score-hist">' + cols + '</div>');
    } else {
      scoreCard = card('Score distribution', '<div class="stats-empty-mini">Rate some titles to see this.</div>');
    }

    // ── Top genres ─────────────────────────────────────────────────────
    var genreList = Object.keys(genreTally).map(function (g) { return { name: g, n: genreTally[g] }; })
      .sort(function (a, b) { return b.n - a.n; }).slice(0, 8);
    var genreCard;
    if (genreList.length) {
      var gMax = genreList[0].n;
      genreCard = card('Top genres', '<div class="stats-bars">' + genreList.map(function (g) {
        return barRow(g.name, g.n, gMax, css('--accent'));
      }).join('') + '</div>');
    } else {
      genreCard = card('Top genres', '<div class="stats-empty-mini">No genre data yet.</div>');
    }

    // ── Activity timeline (last 12 months with data) ───────────────────
    var months = Object.keys(monthTally).sort();
    var timelineCard = '';
    if (months.length) {
      var recent = months.slice(-12);
      var mMax = Math.max.apply(null, recent.map(function (k) { return monthTally[k]; }).concat([1]));
      var tcols = recent.map(function (k) {
        var h = Math.round((monthTally[k] / mMax) * 100);
        var lbl = new Date(k + '-01').toLocaleString('en', { month: 'short' });
        return '<div class="tl-col" title="' + monthTally[k] + ' in ' + k + '">' +
          '<span class="tl-bar" style="height:' + Math.max(h, 3) + '%"></span>' +
          '<span class="tl-lab">' + lbl + '</span></div>';
      }).join('');
      timelineCard = card('Recent activity', '<div class="tl-hist">' + tcols + '</div>');
    }

    // ── Highlights ─────────────────────────────────────────────────────
    var hi = '';
    if (top) hi += highlight('Highest rated', top, top.score + '/10');
    if (recentDone && recentDone !== top) hi += highlight('Latest finish', recentDone, STATUS_LABEL.completed);
    var hiCard = hi ? card('Highlights', '<div class="stats-highlights">' + hi + '</div>') : '';

    body.innerHTML = tiles +
      '<div class="stats-grid">' + catCard + statusCard + scoreCard + genreCard + '</div>' +
      (timelineCard ? '<div class="stats-grid">' + timelineCard + (hiCard || '') + '</div>' : (hiCard ? '<div class="stats-grid">' + hiCard + '</div>' : ''));
  }

  function highlight(label, item, meta) {
    var mt = item.media_type || 'game';
    var page = { movie: 'movies.html', series: 'series.html', anime: 'anime.html', game: 'home.html' }[mt] || 'home.html';
    var href = page + '?open=' + encodeURIComponent(item.media_ref || '');
    var img = item.background_image || '';
    return '<a class="hl-item" href="' + href + '">' +
      (img ? '<img src="' + esc(img) + '" alt="" loading="lazy">' : '<span class="hl-noimg"></span>') +
      '<span class="hl-txt"><span class="hl-cap">' + esc(label) + '</span>' +
      '<span class="hl-name">' + esc(item.name || 'Untitled') + '</span>' +
      '<span class="hl-meta">' + esc(meta) + '</span></span></a>';
  }

  function renderYearRow() {
    var years = {};
    allItems.forEach(function (i) { var y = yearOf(i); if (y) years[y] = true; });
    var list = Object.keys(years).map(Number).sort(function (a, b) { return b - a; });
    if (list.length < 2) return; // only show the switcher when there's more than one year
    var row = document.getElementById('statsYearRow');
    row.hidden = false;
    var chips = ['all'].concat(list).map(function (y) {
      var active = (y === currentYear) ? ' active' : '';
      var label = y === 'all' ? 'All time' : y;
      return '<button type="button" class="year-chip' + active + '" data-year="' + y + '">' + label + '</button>';
    }).join('');
    row.innerHTML = chips;
    row.querySelectorAll('.year-chip').forEach(function (b) {
      b.addEventListener('click', function () {
        var y = b.getAttribute('data-year');
        currentYear = y === 'all' ? 'all' : Number(y);
        row.querySelectorAll('.year-chip').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        render();
      });
    });
  }

  async function init() {
    if (window.mountAppNav) window.mountAppNav();
    // Gate: guests get sent to sign-in.
    if (window.requireAuthAsync) { var ok = await window.requireAuthAsync(); if (!ok) return; }
    else if (window.getToken && !window.getToken()) { window.location.href = window.authUrlWithNext ? window.authUrlWithNext() : 'auth.html'; return; }

    try {
      var res = await window.apiFetch('/user/games');
      if (!res.ok) throw new Error('load failed');
      var data = await res.json();
      allItems = (data.games || []).map(function (g) {
        g.media_type = g.media_type || 'game';
        return g;
      });
      renderYearRow();
      render();
    } catch (e) {
      document.getElementById('statsBody').innerHTML =
        '<div class="stats-empty"><p>Could not load your stats.</p>' +
        '<button class="btn btn-secondary" onclick="location.reload()">Try again</button></div>';
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
