/**
 * One detail page for all four categories.
 *
 * This replaces the modal that used to sit over the grid. A title is a place
 * you go to, not a layer over where you were: it can be linked, shared, opened
 * in a tab and reached with the back button, and on a phone it is a page rather
 * than a scrolling box inside a page. The cast pages already worked this way,
 * so this makes the rest of the app match them.
 *
 * The ref decides everything - igdb_233, tmdb_movie_1234, tmdb_series_1396,
 * kitsu_1 - which is why a single page can serve every category.
 */
(function () {
  'use strict';

  var KINDS = {
    game:   { endpoint: '/igdb/games',   noun: 'game',  page: 'games',  back: 'home.html',   label: 'Games'  },
    movie:  { endpoint: '/tmdb/movies',  noun: 'movie', page: 'movies', back: 'movies.html', label: 'Movies' },
    series: { endpoint: '/tmdb/series',  noun: 'show',  page: 'series', back: 'series.html', label: 'Shows'  },
    anime:  { endpoint: '/kitsu/anime',  noun: 'anime', page: 'anime',  back: 'anime.html',  label: 'Anime'  }
  };

  var ANIME_STATUS_LABEL = {
    current: 'Airing', finished: 'Finished', tba: 'To be announced',
    unreleased: 'Unreleased', upcoming: 'Upcoming'
  };

  function byId(id) { return document.getElementById(id); }
  function esc(s) { return (typeof window.esc === 'function') ? window.esc(s) : String(s == null ? '' : s); }
  // Signed out = no session token. isGuest() only exists on the games page.
  function guest() { return typeof getToken === 'function' ? !getToken() : true; }

  /** igdb_233 -> {kind:'game', id:233}. The prefix is the category. */
  function parseRef(ref) {
    var r = String(ref || '');
    var m;
    if ((m = r.match(/^igdb_(\d+)$/)))        return { kind: 'game',   id: Number(m[1]) };
    if ((m = r.match(/^tmdb_movie_(\d+)$/)))  return { kind: 'movie',  id: Number(m[1]) };
    if ((m = r.match(/^tmdb_series_(\d+)$/))) return { kind: 'series', id: Number(m[1]) };
    if ((m = r.match(/^kitsu_(\d+)$/)))       return { kind: 'anime',  id: Number(m[1]) };
    return null;
  }

  /* IGDB answers in its own shape; everything else arrives normalised already.
     Flattening it here means the renderer below only knows one shape. */
  function normalizeGame(g, ref) {
    var publishers = [], developers = [];
    (g.involved_companies || []).forEach(function (ic) {
      if (!ic || !ic.company) return;
      var entry = { name: ic.company.name, ref: ic.company.id ? 'igdb_company_' + ic.company.id : null };
      if (ic.publisher) publishers.push(entry);
      if (ic.developer) developers.push(entry);
    });

    var rating = null, score = null;
    if (g.total_rating && g.total_rating_count >= 5) {
      rating = (g.total_rating / 20).toFixed(1); score = Math.round(g.total_rating);
    } else if (g.aggregated_rating && g.aggregated_rating_count >= 3) {
      rating = (g.aggregated_rating / 20).toFixed(1); score = Math.round(g.aggregated_rating);
    }

    var vids = g.videos || [];
    var vid = vids.find(function (v) { return /trailer/i.test(v.name || ''); }) || vids[0];
    var cover = g.cover && g.cover.url;
    // A wide banner wants a wide picture. The cover is portrait, so stretched
    // across the page it turns into a blurry close-up of a logo; the first
    // screenshot is the right shape and actually shows the game.
    var firstShot = g.screenshots && g.screenshots[0] && g.screenshots[0].url;

    return {
      id: ref,
      igdb_id: g.id,
      name: g.name,
      background_image: cover ? 'https:' + cover.replace('t_thumb', 't_cover_big') : null,
      backdrop_image: firstShot
        ? 'https:' + firstShot.replace('t_thumb', 't_screenshot_huge')
        : (cover ? 'https:' + cover.replace('t_thumb', 't_screenshot_big') : null),
      description: g.summary || '',
      released: g.first_release_date
        ? new Date(g.first_release_date * 1000).toISOString().slice(0, 10) : null,
      rating: rating,
      metacritic_score: score,
      genres: g.genres || [],
      platforms: g.platforms || [],
      publishers: publishers,
      developers: developers,
      game_modes: (g.game_modes || []).map(function (m) { return m.name; }).filter(Boolean),
      perspectives: (g.player_perspectives || []).map(function (p) { return p.name; }).filter(Boolean),
      trailer: vid && vid.video_id ? { key: vid.video_id } : null,
      screenshots: (g.screenshots || []).slice(0, 8).map(function (s) {
        return 'https:' + s.url.replace('t_thumb', 't_screenshot_big');
      }),
      similar: (g.similar_games || []).filter(function (s) { return s.cover; }).slice(0, 12).map(function (s) {
        return { id: 'igdb_' + s.id, name: s.name, background_image: 'https:' + s.cover.url.replace('t_thumb', 't_cover_big') };
      }),
      relations: (g.relations || []).map(function (r) {
        return { id: 'igdb_' + r.id, name: r.name, released: r.released, image: r.image, relation: r.relation };
      })
    };
  }

  // ── section builders ───────────────────────────────────────────────────────

  function sectionHtml(title, inner, extraClass) {
    if (!inner) return '';
    return '<section class="detail-section' + (extraClass ? ' ' + extraClass : '') + '">' +
      '<h2 class="detail-h">' + esc(title) + '</h2>' + inner + '</section>';
  }

  function genresHtml(item) {
    var list = item.genres || [];
    if (!list.length) return '';
    return '<div class="game-detail-genres">' + list.map(function (g) {
      return '<span class="game-detail-genre-tag">' + esc(g.name || g) + '</span>';
    }).join('') + '</div>';
  }

  function infoGridHtml(item, kind) {
    var creditLabel = kind === 'series' ? 'Creator' : kind === 'game' ? 'Developer' : 'Director';
    var studioLabel = kind === 'series' ? 'Network' : kind === 'game' ? 'Publisher' : 'Studio';

    var items = [
      (item.developers && item.developers.length)
        ? { label: creditLabel, value: item.developers, people: true } : null,
      (item.publishers && item.publishers.length)
        ? { label: studioLabel, value: item.publishers, people: true } : null,
      (item.platforms && item.platforms.length)
        ? { label: 'Platforms', value: item.platforms.map(function (p) { return p.name || p; }).join(', ') } : null,
      (kind === 'series' && item.number_of_seasons) ? { label: 'Seasons', value: String(item.number_of_seasons) } : null,
      ((kind === 'series' || kind === 'anime') && item.number_of_episodes)
        ? { label: 'Episodes', value: String(item.number_of_episodes) } : null,
      (kind === 'anime' && item.subtype) ? { label: 'Type', value: String(item.subtype) } : null,
      (kind === 'anime' && item.episode_length) ? { label: 'Episode length', value: item.episode_length + ' min' } : null,
      (kind === 'anime' && item.status) ? { label: 'Status', value: ANIME_STATUS_LABEL[item.status] || item.status } : null,
      (kind === 'movie' && item.runtime) ? { label: 'Runtime', value: item.runtime + ' min' } : null,
      (item.game_modes && item.game_modes.length) ? { label: 'Modes', value: item.game_modes.join(', ') } : null
    ].filter(Boolean);

    if (!items.length) return '';
    return '<div class="game-detail-info-grid">' + items.map(function (it) {
      var value;
      if (it.people) {
        value = it.value.map(function (p) {
          var name = p.name || p;
          return p.ref
            ? '<a class="detail-credit-link" href="person.html?ref=' + esc(p.ref) + '">' + esc(name) + '</a>'
            : esc(name);
        }).join(', ');
      } else {
        value = esc(it.value);
      }
      return '<div class="game-detail-info-item">' +
        '<div class="game-detail-info-label">' + esc(it.label) + '</div>' +
        '<div class="game-detail-info-value">' + value + '</div></div>';
    }).join('') + '</div>';
  }

  function descriptionHtml(item) {
    var d = item.description || '';
    if (!d) return '';
    if (d.length > 420) {
      return '<div class="game-detail-desc"><span class="desc-short">' + esc(d.slice(0, 420)) + '…</span>' +
        '<span class="desc-full" hidden>' + esc(d) + '</span> ' +
        '<button type="button" class="link-btn desc-toggle">Read more</button></div>';
    }
    return '<p class="game-detail-desc">' + esc(d) + '</p>';
  }

  function trailerHtml(item) {
    if (!item.trailer || !item.trailer.key) return '';
    var k = esc(item.trailer.key);
    return sectionHtml('Trailer',
      '<div class="detail-trailer" data-yt="' + k + '">' +
        '<img src="https://i.ytimg.com/vi/' + k + '/hqdefault.jpg" alt="Play trailer" loading="lazy">' +
        '<span class="detail-trailer-play" aria-hidden="true"></span>' +
      '</div>' +
      '<a class="detail-trailer-fallback" href="https://www.youtube.com/watch?v=' + k + '" target="_blank" rel="noopener noreferrer">Trouble playing? Watch on YouTube ↗</a>');
  }

  function providersHtml(item) {
    if (!item.providers) return '';
    function row(label, arr) {
      if (!arr || !arr.length) return '';
      return '<div class="detail-prov-row"><span class="detail-prov-label">' + esc(label) + '</span>' +
        '<div class="detail-prov-logos">' + arr.map(function (p) {
          return '<img src="' + esc(p.logo) + '" alt="' + esc(p.name) + '" title="' + esc(p.name) + '" loading="lazy">';
        }).join('') + '</div></div>';
    }
    var body = row('Stream', item.providers.flatrate) + row('Rent', item.providers.rent) + row('Buy', item.providers.buy);
    if (!body) return '';
    return sectionHtml('Where to watch',
      '<div class="detail-providers">' + body + '</div>' +
      (item.providers.link ? '<a class="link-btn" href="' + esc(item.providers.link) + '" target="_blank" rel="noopener noreferrer">More options ↗</a>' : ''));
  }

  /* The run a title belongs to. Deliberately not another "More like this"
     strip: it is a position in a sequence, so each entry says where it sits
     and the title you are on is marked and not clickable. */
  var RELATION_WORD = {
    prequel: 'Prequel', sequel: 'Sequel', earlier: 'Earlier', later: 'Later', current: 'You are here'
  };

  function seriesHtml(item) {
    var rel = item.relations || [];
    if (!rel.length || !rel.some(function (r) { return r.relation !== 'current'; })) return '';
    var items = rel.map(function (r) {
      var here = r.relation === 'current';
      var year = r.released ? String(r.released).slice(0, 4) : '';
      var img = '<img src="' + esc(r.image || '/img/no-image.svg') + '" alt="" loading="lazy"' +
        ' onerror="this.src=\'/img/no-image.svg\'">';
      var caption =
        '<span class="dsr-rel">' + esc(RELATION_WORD[r.relation] || '') +
          (year && !here ? ' · ' + esc(year) : '') + '</span>' +
        '<span class="ds-name">' + esc(r.name) + '</span>';
      if (here) return '<div class="detail-series-item is-here" aria-current="true">' + img + caption + '</div>';
      return '<a class="detail-series-item" href="title.html?ref=' + esc(r.id) + '" title="' + esc(r.name) + '">' +
        img + caption + '</a>';
    }).join('');
    return sectionHtml('In this series', '<div class="detail-series">' + items + '</div>');
  }

  /* Entries the provider gave no id for stay as plain text rather than
     becoming links that go nowhere. */
  function castHtml(item) {
    var cast = item.cast || [];
    if (!cast.length) return '';
    var items = cast.map(function (c) {
      var inner =
        '<img src="' + esc(c.image || '/img/no-image.svg') + '" alt="' + esc(c.name) + '" loading="lazy"' +
          ' onerror="this.src=\'/img/no-image.svg\'">' +
        '<div class="dc-name">' + esc(c.name) + '</div>' +
        (c.character ? '<div class="dc-char">' + esc(c.character) + '</div>' : '');
      return c.ref
        ? '<a class="detail-cast-card is-linked" href="person.html?ref=' + esc(c.ref) + '">' + inner + '</a>'
        : '<div class="detail-cast-card">' + inner + '</div>';
    }).join('');
    return sectionHtml('Cast', '<div class="detail-cast">' + items + '</div>');
  }

  function shotsHtml(item) {
    var shots = item.screenshots || [];
    if (!shots.length) return '';
    return sectionHtml('Screenshots', '<div class="detail-shots">' + shots.map(function (u) {
      return '<a class="detail-shot" href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' +
        '<img src="' + esc(u) + '" alt="Screenshot" loading="lazy"' +
        ' onerror="this.closest(\'.detail-shot\').style.display=\'none\'"></a>';
    }).join('') + '</div>');
  }

  function similarHtml(item) {
    var sim = item.similar || [];
    if (!sim.length) return '';
    return sectionHtml('More like this', '<div class="detail-similar">' + sim.map(function (s) {
      return '<a class="detail-similar-card" href="title.html?ref=' + esc(s.id) + '" title="' + esc(s.name) + '">' +
        '<img src="' + esc(s.background_image || '/img/no-image.svg') + '" alt="' + esc(s.name) + '" loading="lazy"' +
          ' onerror="this.src=\'/img/no-image.svg\'">' +
        '<span class="ds-name">' + esc(s.name) + '</span></a>';
    }).join('') + '</div>');
  }

  function libraryPanelHtml(item, kind, owned, lists) {
    var defaults = { game: 'My Game Library', movie: 'My Movie Library', series: 'My Shows Library', anime: 'My Anime Library' };
    var options = '<option value="default">' + esc(defaults[kind] + ' (Default)') + '</option>' +
      (lists || []).map(function (l) {
        return '<option value="custom_' + esc(String(l.id)) + '">' + esc(l.name) + '</option>';
      }).join('');

    if (guest()) {
      return '<section class="add-to-list" id="libraryPanel">' +
        '<h2>Keep track of this</h2>' +
        '<p class="atl-owned-note">Create a free account to save this ' + esc(KINDS[kind].noun) +
        ', rate it and track your progress.</p>' +
        '<a class="btn btn-primary" href="auth.html">Create a free account</a></section>';
    }

    return '<section class="add-to-list" id="libraryPanel">' +
      '<h2>' + (owned ? 'In your library' : 'Add to your library') + '</h2>' +
      (owned ? '<p class="atl-owned-note">Saved as <strong>' +
        esc(typeof statusLabel === 'function' ? statusLabel(owned.status, kind) : (owned.status || '')) + '</strong>' +
        (owned.score != null ? ', rated <strong>' + esc(String(owned.score)) + '/10</strong>' : ', not rated yet') +
        '. Change it below.</p>' : '') +
      '<div class="atl-list-row">' +
        '<label for="gameListSelect">Add to list</label>' +
        '<select id="gameListSelect" class="filter-select">' + options + '</select>' +
      '</div>' +
      '<div class="atl-score-row">' +
        '<label for="gameScore">Your score</label>' +
        scoreMeterHTML('gameScore', owned && owned.score != null ? owned.score : null) +
      '</div>' +
      '<div class="atl-controls">' +
        '<div class="atl-field atl-field-status">' +
          '<label for="gameStatus">Status</label>' +
          '<select id="gameStatus" class="filter-select">' +
            (typeof statusOptions === 'function' ? statusOptions(kind, (owned && owned.status) || 'completed') : '') +
          '</select>' +
        '</div>' +
        '<button type="button" class="btn btn-primary atl-add" id="titleSaveBtn">' +
          (owned ? 'Save changes' : 'Add to library') + '</button>' +
      '</div>' +
      '<div class="atl-note">' +
        '<label for="gameNote">Review or note <span class="atl-optional">optional</span></label>' +
        '<textarea id="gameNote" class="atl-note-input" rows="3" maxlength="2000" placeholder="Write a quick review or note, or leave it blank."></textarea>' +
      '</div>' +
      '<span id="addGameMessage" class="atl-msg" role="status" aria-live="polite"></span>' +
      '</section>';
  }

  // ── page ───────────────────────────────────────────────────────────────────

  var state = { ref: null, kind: null, item: null, lists: [] };

  function render() {
    var item = state.item, kind = state.kind;
    var owned = typeof libraryEntry === 'function' ? libraryEntry(state.ref) : null;

    var hero = item.backdrop_image || item.background_image;
    var cover = item.background_image || hero || '/img/no-image.svg';

    var released = item.released
      ? '<span class="game-detail-date">' +
        esc(new Date(item.released).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })) +
        '</span>' : '';
    var rating = item.rating
      ? '<span class="detail-rating" title="Average rating">★ ' + esc(Number(item.rating).toFixed(1)) +
        '<span class="dr-sub">/5</span></span>' : '';

    /* Poster-anchored two-column hero: the artwork carries the page (it is the
       one thing a visitor recognises at a glance), title/meta sit beside it, and
       the facts + synopsis fill the column under the title. The poster spans both
       right-hand rows on desktop; on a phone it tucks next to the title and the
       details drop full-width below. Everything after the hero stays full width. */
    byId('titleBody').innerHTML =
      '<div class="game-detail-body">' +
        '<div class="title-hero">' +
          '<img src="' + esc(cover) + '" alt="' + esc(item.name) + ' cover" class="game-detail-cover title-hero-poster" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
          '<div class="title-hero-head">' +
            '<h1 class="game-detail-title">' + esc(item.name) + '</h1>' +
            '<div class="game-detail-badges">' + released + rating + '</div>' +
            genresHtml(item) +
          '</div>' +
          '<div class="title-hero-detail">' +
            infoGridHtml(item, kind) +
            descriptionHtml(item) +
          '</div>' +
        '</div>' +
        libraryPanelHtml(item, kind, owned, state.lists) +
        trailerHtml(item) +
        providersHtml(item) +
        seriesHtml(item, state.ref) +
        castHtml(item) +
        shotsHtml(item) +
        similarHtml(item) +
      '</div>';

    byId('titleState').hidden = true;
    byId('titleBody').hidden = false;

    document.title = item.name + ' - MediaListory';
    wire();

    if (typeof window.enhanceScrollers === 'function') window.enhanceScrollers(byId('titleBody'));
    if (typeof window.mountEnrichment === 'function') {
      var p = parseRef(state.ref);
      if (p && (p.kind === 'game' || p.kind === 'anime' || p.kind === 'series')) {
        window.mountEnrichment(byId('titleBody'), p.kind, String(p.id));
      }
    }
  }

  function wire() {
    var body = byId('titleBody');

    var toggle = body.querySelector('.desc-toggle');
    if (toggle) {
      toggle.addEventListener('click', function () {
        var wrap = toggle.closest('.game-detail-desc');
        var short = wrap.querySelector('.desc-short');
        var full = wrap.querySelector('.desc-full');
        var open = !full.hidden;
        full.hidden = open;
        short.hidden = !open;
        toggle.textContent = open ? 'Read more' : 'Show less';
      });
    }

    var trailer = body.querySelector('.detail-trailer');
    if (trailer && trailer.dataset.yt) {
      trailer.addEventListener('click', function () {
        trailer.innerHTML = '<iframe src="https://www.youtube-nocookie.com/embed/' +
          encodeURIComponent(trailer.dataset.yt) +
          '?autoplay=1&rel=0&modestbranding=1&playsinline=1" title="Trailer" frameborder="0" ' +
          'allow="autoplay; encrypted-media; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" ' +
          'allowfullscreen loading="lazy"></iframe>';
        trailer.classList.add('playing');
      });
    }

    if (typeof bindScoreMeter === 'function') bindScoreMeter('gameScore');
    var save = byId('titleSaveBtn');
    if (save) save.addEventListener('click', saveToLibrary);
  }

  var MSG_ICON_OK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>';
  var MSG_ICON_ERR = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5"/></svg>';
  function showMsg(text, type) {
    var el = byId('addGameMessage');
    if (!el) return;
    var ok = type !== 'error';
    el.innerHTML = '<span class="atl-msg-icon">' + (ok ? MSG_ICON_OK : MSG_ICON_ERR) + '</span><span>' + esc(text) + '</span>';
    el.style.color = ok ? 'var(--green-light)' : 'var(--red-light)';
    // Restart the pop-in animation even when the same message class repeats.
    el.classList.remove('is-shown'); void el.offsetWidth; el.classList.add('is-shown');
  }

  async function saveToLibrary() {
    if (guest()) { if (typeof promptSignIn === 'function') promptSignIn('Create a free account to build your library.'); return; }

    var status = byId('gameStatus') ? byId('gameStatus').value : 'completed';
    var raw = byId('gameScore') ? String(byId('gameScore').value).trim() : '';
    var note = byId('gameNote') ? byId('gameNote').value.trim() : '';
    var listValue = byId('gameListSelect') ? byId('gameListSelect').value : 'default';

    if (raw && (!/^\d+$/.test(raw) || Number(raw) < 0 || Number(raw) > 10)) {
      showMsg('Score must be a whole number from 0 to 10.', 'error');
      return;
    }
    var score = raw ? Number(raw) : null;
    var gameData = window.MGLQuickAdd.toGameData(state.item, state.kind);
    var owned = typeof libraryEntry === 'function' ? libraryEntry(state.ref) : null;
    var saveBtn = byId('titleSaveBtn');
    if (typeof setBtnLoading === 'function') setBtnLoading(saveBtn, true, owned ? 'Saving…' : 'Adding…');

    try {
      if (listValue === 'default' && owned && owned.id) {
        var patch = { status: status, score: score };
        if (note) patch.notes = note;
        var up = await apiFetch('/user/games/' + encodeURIComponent(owned.id), {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch)
        });
        var upData = await up.json().catch(function () { return {}; });
        if (!up.ok) { showMsg(upData.error || 'Could not save that.', 'error'); return; }
        if (typeof setLibraryEntry === 'function') setLibraryEntry(state.ref, { id: owned.id, status: status, score: score });
        showMsg('Updated in your library.', 'success');
        return;
      }

      if (listValue === 'default') {
        var add = await apiFetch('/user/games', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ game_id: state.ref, game_data: gameData, status: status, score: score, notes: note || undefined })
        });
        var addData = await add.json().catch(function () { return {}; });
        if (!add.ok) {
          var already = addData.error === 'Game already in your list';
          showMsg(already ? 'Already in your library.' : (addData.error || 'Failed to add.'), already ? 'success' : 'error');
          return;
        }
        if (typeof setLibraryEntry === 'function' && !addData.folded_into) {
          setLibraryEntry(state.ref, { id: addData.game_id, status: status, score: score });
        }
        showMsg(addData.folded_into ? addData.message : 'Added to your library.', 'success');
        return;
      }

      var listId = listValue.replace('custom_', '');
      var lr = await apiFetch('/user/lists/' + listId + '/games', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game_data: gameData, status: status, score: score, note: note || undefined })
      });
      var ld = await lr.json().catch(function () { return {}; });
      if (!lr.ok) {
        var dup = ld.error === 'Game already in this list';
        showMsg(dup ? 'Already in that list.' : ('Failed: ' + (ld.error || 'error')), dup ? 'success' : 'error');
        return;
      }
      showMsg('Added to that list.', 'success');
    } catch (err) {
      showMsg('Network error. Please try again.', 'error');
    } finally {
      if (typeof setBtnLoading === 'function') setBtnLoading(saveBtn, false);
    }
  }

  function fail(message) {
    var el = byId('titleState');
    el.hidden = false;
    el.textContent = message;
    byId('titleBody').hidden = true;
  }

  async function boot() {
    if (typeof ensureSession === 'function') { try { await ensureSession(); } catch (_) {} }

    // Wired before the ref is even checked, so a bad or missing ref below
    // still leaves a working way out instead of a dead "Back" link.
    var back = byId('titleBack');
    var cameFromApp = document.referrer && document.referrer.indexOf(location.origin) === 0;
    if (back) {
      back.setAttribute('href', cameFromApp ? '#' : 'dashboard.html');
      if (cameFromApp) back.addEventListener('click', function (e) { e.preventDefault(); history.back(); });
    }

    var ref = new URLSearchParams(location.search).get('ref');
    var parsed = parseRef(ref);
    if (!parsed) { fail('That link does not point at a title we can open.'); return; }

    state.ref = ref;
    state.kind = parsed.kind;
    var cfg = KINDS[parsed.kind];

    document.body.setAttribute('data-page', cfg.page);

    if (back) {
      // Prefer real history, so Back returns to the exact grid position the
      // visitor came from rather than the top of the category.
      back.setAttribute('href', cfg.back);
      back.textContent = cameFromApp ? 'Back' : ('Back to ' + cfg.label);
    }

    if (typeof loadLibraryIndex === 'function') { try { await loadLibraryIndex(); } catch (_) {} }

    try {
      var res = await apiFetch(cfg.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: parsed.id })
      });
      var rows = await res.json();
      if (!res.ok || !Array.isArray(rows) || !rows.length) {
        fail('We could not load this ' + cfg.noun + ' right now. Please try again.');
        return;
      }
      state.item = parsed.kind === 'game' ? normalizeGame(rows[0], ref) : rows[0];
    } catch (err) {
      fail('We could not reach the server. Please check your connection and try again.');
      return;
    }

    if (!guest()) {
      try {
        var lr = await apiFetch('/user/lists');
        if (lr.ok) {
          var lists = await lr.json();
          state.lists = Array.isArray(lists) ? lists : (lists && lists.lists) || [];
        }
      } catch (_) { /* Custom lists are optional; the default list still works. */ }
    }

    render();
  }

  boot();
})();
