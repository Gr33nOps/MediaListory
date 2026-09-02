// Release Calendar — upcoming releases across all four providers, grouped by
// month, plus (for signed-in users) what's still to come on their watchlist.
// Guests can browse the upcoming lists too.
(function () {
  'use strict';

  var PAGE_FOR = { movie: 'movies.html', series: 'series.html', anime: 'anime.html', game: 'home.html' };
  var CAT_LABEL = { movie: 'Movie', series: 'Show', anime: 'Anime', game: 'Game' };
  var ENDPOINTS = [
    { cat: 'movie', path: '/tmdb/movies' },
    { cat: 'series', path: '/tmdb/series' },
    { cat: 'anime', path: '/kitsu/anime' },
    { cat: 'game', path: '/igdb/games' }
  ];

  var upcoming = [];   // merged, normalized, future-dated
  var watchlist = [];  // user's own future-dated items
  var currentCat = 'all';

  function esc(s) { return (window.esc ? window.esc(s) : String(s == null ? '' : s)); }

  // Normalize IGDB's raw shape; TMDB/Kitsu already come back normalized.
  function normalize(cat, arr) {
    if (!Array.isArray(arr)) return [];
    if (cat === 'game') {
      return arr.map(function (g) {
        var url = g.cover && g.cover.url ? ('https:' + g.cover.url.replace('t_thumb', 't_cover_big')) : null;
        var released = g.first_release_date ? new Date(g.first_release_date * 1000).toISOString().slice(0, 10) : null;
        return { id: 'igdb_' + g.id, media_type: 'game', name: g.name, background_image: url, released: released };
      });
    }
    return arr.map(function (m) {
      return { id: m.id, media_type: m.media_type || cat, name: m.name, background_image: m.background_image || m.backdrop_image || null, released: m.released || null };
    });
  }

  function extractList(cat, data) {
    if (Array.isArray(data)) return data;
    return data.results || data.games || data.data || [];
  }

  function monthKey(d) { return d.slice(0, 7); }
  function monthLabel(key) {
    return new Date(key + '-01T00:00:00').toLocaleString('en', { month: 'long', year: 'numeric' });
  }
  function dayParts(d) {
    var dt = new Date(d + 'T00:00:00');
    return { day: dt.getDate(), mon: dt.toLocaleString('en', { month: 'short' }) };
  }

  function itemCard(it) {
    var page = PAGE_FOR[it.media_type] || 'home.html';
    var href = page + '?open=' + encodeURIComponent(it.id || '');
    var dp = dayParts(it.released);
    var thumb = it.background_image
      ? '<img class="cal-thumb" src="' + esc(it.background_image) + '" alt="" loading="lazy">'
      : '<span class="cal-thumb cal-thumb-empty"></span>';
    return '<a class="cal-item" href="' + href + '" data-cat="' + it.media_type + '">' +
      '<span class="cal-date"><span class="cal-date-day">' + dp.day + '</span><span class="cal-date-mon">' + dp.mon + '</span></span>' +
      thumb +
      '<span class="cal-item-main"><span class="cal-item-name">' + esc(it.name || 'Untitled') + '</span>' +
      '<span class="cal-badge cal-badge-' + it.media_type + '">' + (CAT_LABEL[it.media_type] || 'Title') + '</span></span></a>';
  }

  function render() {
    var body = document.getElementById('calBody');
    var items = upcoming.filter(function (i) { return currentCat === 'all' || i.media_type === currentCat; });

    if (!items.length) {
      body.innerHTML = '<div class="stats-empty-mini">No upcoming releases found' +
        (currentCat === 'all' ? '' : ' for ' + CAT_LABEL[currentCat].toLowerCase() + 's') + ' right now.</div>';
      return;
    }

    // Group by month
    var groups = {};
    items.forEach(function (i) {
      var k = monthKey(i.released);
      (groups[k] = groups[k] || []).push(i);
    });
    var keys = Object.keys(groups).sort();
    body.innerHTML = keys.map(function (k) {
      var rows = groups[k].sort(function (a, b) { return a.released < b.released ? -1 : 1; }).map(itemCard).join('');
      return '<section class="cal-month"><h2 class="cal-month-h">' + esc(monthLabel(k)) +
        '<span class="cal-month-n">' + groups[k].length + '</span></h2><div class="cal-list">' + rows + '</div></section>';
    }).join('');
  }

  function renderWatchlist() {
    var sec = document.getElementById('calWatchlist');
    if (!watchlist.length) { sec.hidden = true; return; }
    var items = watchlist.filter(function (i) { return currentCat === 'all' || i.media_type === currentCat; });
    if (!items.length) { sec.hidden = true; return; }
    sec.hidden = false;
    var rows = items.slice(0, 12).map(itemCard).join('');
    sec.innerHTML = '<h2 class="cal-month-h">On your watchlist<span class="cal-month-n">' + items.length + '</span></h2>' +
      '<div class="cal-list">' + rows + '</div>';
  }

  function wireFilters() {
    var row = document.getElementById('calFilters');
    row.querySelectorAll('.cal-chip').forEach(function (b) {
      b.addEventListener('click', function () {
        currentCat = b.getAttribute('data-cat');
        row.querySelectorAll('.cal-chip').forEach(function (x) { x.classList.remove('active'); x.setAttribute('aria-selected', 'false'); });
        b.classList.add('active'); b.setAttribute('aria-selected', 'true');
        renderWatchlist();
        render();
      });
    });
  }

  async function loadUpcoming() {
    var today = new Date().toISOString().slice(0, 10);
    var results = await Promise.all(ENDPOINTS.map(function (e) {
      return window.apiFetch(e.path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comingSoon: true, limit: 24 })
      }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { return normalize(e.cat, extractList(e.cat, d || [])); })
        .catch(function () { return []; });
    }));
    var merged = [];
    results.forEach(function (arr) { merged = merged.concat(arr); });
    // Keep future-dated only, within the next ~15 months, de-duped by id.
    var seen = {};
    var maxD = new Date(); maxD.setMonth(maxD.getMonth() + 15);
    var maxStr = maxD.toISOString().slice(0, 10);
    upcoming = merged.filter(function (i) {
      if (!i.released || !i.id) return false;
      if (i.released < today || i.released > maxStr) return false;
      if (seen[i.id]) return false;
      seen[i.id] = true;
      return true;
    }).sort(function (a, b) { return a.released < b.released ? -1 : 1; });
  }

  async function loadWatchlist() {
    if (!window.getToken || !window.getToken()) return;
    try {
      var res = await window.apiFetch('/user/games');
      if (!res.ok) return;
      var data = await res.json();
      var today = new Date().toISOString().slice(0, 10);
      watchlist = (data.games || []).filter(function (g) {
        var d = g.released ? String(g.released).slice(0, 10) : null;
        return d && d >= today;
      }).map(function (g) {
        return { id: g.media_ref, media_type: g.media_type || 'game', name: g.name, background_image: g.background_image || null, released: String(g.released).slice(0, 10) };
      }).sort(function (a, b) { return a.released < b.released ? -1 : 1; });
    } catch (e) { /* ignore */ }
  }

  async function init() {
    if (window.mountAppNav) window.mountAppNav();
    if (window.ensureSession) { try { await window.ensureSession(); } catch (e) {} }
    wireFilters();
    try {
      await Promise.all([loadUpcoming(), loadWatchlist()]);
      renderWatchlist();
      render();
    } catch (e) {
      document.getElementById('calBody').innerHTML =
        '<div class="stats-empty"><p>Could not load the calendar.</p>' +
        '<button class="btn btn-secondary" onclick="location.reload()">Try again</button></div>';
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
