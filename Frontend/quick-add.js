/* ── Quick add ───────────────────────────────────────────────────────────────
   The plus button on a browse card.

   Opening a title just to set "Completed, 8/10" meant a full detail request to
   IGDB, TMDB or Kitsu for information nobody read. The card already knows the
   title, the artwork and the date, and that is everything the catalogue needs
   to store it - so the plus saves straight from the grid and costs no upstream
   call at all. Clicking anywhere else on the card still opens the full page.

   One module for all four categories, so a game, a film, a show and an anime
   are all saved the same way and only one place has to be right. */

(function (global) {
  'use strict';

  var esc = global.esc || function (s) { return String(s == null ? '' : s); };
  var openFor = null;   // ref of the card whose panel is open
  var panelEl = null;
  var listsCache = null;   // the user's custom lists, fetched once and reused

  /* The "Add to" dropdown offers the main library plus every custom list, so a
     title can be filed straight from the grid. Fetched lazily the first time a
     panel opens and cached for the rest of the session. */
  function fetchLists() {
    if (listsCache) return Promise.resolve(listsCache);
    if (typeof global.apiFetch !== 'function') return Promise.resolve([]);
    return global.apiFetch('/user/lists')
      .then(function (r) { return r.ok ? r.json() : { lists: [] }; })
      .then(function (d) { listsCache = (d && d.lists) || []; return listsCache; })
      .catch(function () { listsCache = []; return listsCache; });
  }

  /* The catalogue row. Only fields the browse list already carries, which is
     why this needs no detail request. Games come from IGDB with a numeric id
     alongside the ref; the rest are addressed by ref alone. */
  function toGameData(item, kind) {
    if (!item) return null;
    var base = {
      name: item.name,
      background_image: item.background_image || null,
      description: item.description || '',
      released: item.released || null,
      rating: item.rating != null ? item.rating : null,
      metacritic_score: item.metacritic_score != null ? item.metacritic_score : null,
      genres: item.genres || [],
      platforms: item.platforms || [],
      publishers: item.publishers || [],
      developers: item.developers || []
    };
    if (kind === 'game') {
      base.igdb_id = item.igdb_id || item.id;
      base.playtime = item.playtime || 0;
    } else {
      base.media_type = item.media_type || kind;
      base.provider = item.provider || null;
      base.provider_id = item.provider_id || null;
      base.tmdb_id = item.tmdb_id || null;
      base.number_of_episodes = item.number_of_episodes || null;
    }
    return base;
  }

  /** The overlay control itself. Sits on the artwork, above the poster. */
  function buttonHtml(ref, owned) {
    var label = owned ? 'Edit your entry for this title' : 'Add this title to your library';
    return '<button type="button" class="card-quick-add' + (owned ? ' is-owned' : '') + '"' +
      ' data-quick-add="' + esc(ref) + '"' +
      ' title="' + esc(label) + '" aria-label="' + esc(label) + '">' +
      '<span aria-hidden="true">' + (owned ? '✓' : '+') + '</span></button>';
  }

  function close() {
    if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
    panelEl = null;
    openFor = null;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('click', onOutside, true);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      var btn = document.querySelector('[data-quick-add="' + cssEscape(openFor) + '"]');
      close();
      if (btn) btn.focus();
    }
  }

  function cssEscape(v) {
    return (global.CSS && CSS.escape) ? CSS.escape(String(v)) : String(v);
  }

  function onOutside(e) {
    if (!panelEl) return;
    if (panelEl.contains(e.target)) return;
    if (e.target.closest && e.target.closest('[data-quick-add]')) return;
    close();
  }

  function statusOptionsFor(kind, current) {
    if (typeof global.statusOptions === 'function') return global.statusOptions(kind, current);
    return '<option value="completed">Completed</option>';
  }

  function open(ref, item, kind, anchor) {
    if (openFor === ref) { close(); return; }
    close();

    // Signed out = no session token. isGuest() only exists on the games page,
    // so the token is checked directly and every category behaves the same.
    var signedOut = typeof global.getToken === 'function' ? !global.getToken() : true;
    if (signedOut) {
      // promptSignIn is page-local on some pages, so fall back to the same
      // behaviour here rather than letting the click do nothing.
      if (typeof global.promptSignIn === 'function') {
        global.promptSignIn('Create a free account to save this.');
      } else {
        if (typeof global.toast === 'function') global.toast('Create a free account to save this.', 'info');
        setTimeout(function () {
          global.location.href = typeof global.authUrlWithNext === 'function' ? global.authUrlWithNext() : 'auth.html';
        }, 900);
      }
      return;
    }

    var owned = (typeof global.libraryEntry === 'function') ? global.libraryEntry(ref) : null;

    panelEl = document.createElement('div');
    panelEl.className = 'quick-add-panel';
    panelEl.setAttribute('role', 'dialog');
    panelEl.setAttribute('aria-label', (owned ? 'Edit ' : 'Add ') + (item && item.name ? item.name : 'title'));
    // New adds default to Completed - the most common thing to log from a grid
    // is something you have already finished. An existing entry keeps its status.
    var statusSel = (owned && owned.status) || 'completed';

    panelEl.innerHTML =
      '<div class="qa-head">' +
        '<span class="qa-title">' + esc(item && item.name ? item.name : 'This title') + '</span>' +
        '<button type="button" class="qa-close" aria-label="Close">×</button>' +
      '</div>' +
      (owned ? '' :
      '<div class="qa-row">' +
        '<label for="qaTarget">Add to</label>' +
        '<select id="qaTarget" class="filter-select"><option value="">Your library</option></select>' +
      '</div>') +
      '<div class="qa-row">' +
        '<label for="qaStatus">Status</label>' +
        '<select id="qaStatus" class="filter-select">' + statusOptionsFor(kind, statusSel) + '</select>' +
      '</div>' +
      '<div class="qa-row">' +
        '<label for="qaScore">Score</label>' +
        '<input type="number" id="qaScore" class="score-input" min="1" max="10" placeholder="—"' +
          (owned && owned.score ? ' value="' + esc(String(owned.score)) + '"' : '') + '>' +
        '<span class="qa-score-hint">/ 10</span>' +
      '</div>' +
      '<div class="qa-actions">' +
        '<button type="button" class="btn btn-primary qa-save">' + (owned ? 'Save changes' : 'Add') + '</button>' +
        (owned ? '<button type="button" class="btn btn-danger qa-remove">Remove from library</button>' : '') +
      '</div>' +
      '<p class="qa-msg" role="status" aria-live="polite"></p>';

    document.body.appendChild(panelEl);
    position(anchor);

    // Fill the "Add to" dropdown with the user's custom lists once they load.
    var targetSel = panelEl.querySelector('#qaTarget');
    if (targetSel) {
      fetchLists().then(function (lists) {
        if (!panelEl || openFor !== ref || !targetSel.isConnected) return;
        lists.forEach(function (l) {
          var o = document.createElement('option');
          o.value = 'list:' + l.id;
          o.textContent = l.name;
          targetSel.appendChild(o);
        });
        position(anchor);
      });
    }

    panelEl.querySelector('.qa-close').addEventListener('click', function () {
      close();
      if (anchor) anchor.focus();
    });
    panelEl.querySelector('.qa-save').addEventListener('click', function () {
      save(ref, item, kind, owned);
    });
    var removeBtn = panelEl.querySelector('.qa-remove');
    if (removeBtn) removeBtn.addEventListener('click', function () { remove(ref, owned, anchor); });

    openFor = ref;
    // Capture phase so a card's own click handler never sees these.
    document.addEventListener('keydown', onKey, true);
    setTimeout(function () { document.addEventListener('click', onOutside, true); }, 0);

    var status = panelEl.querySelector('#qaStatus');
    if (status) status.focus();
  }

  /* Anchored to the button, then nudged back inside the viewport. On a phone
     it becomes a sheet at the bottom instead, which the stylesheet handles. */
  function position(anchor) {
    if (!panelEl || !anchor) return;
    if (global.matchMedia && global.matchMedia('(max-width: 560px)').matches) return;

    var r = anchor.getBoundingClientRect();
    var pw = panelEl.offsetWidth || 260;
    var ph = panelEl.offsetHeight || 220;
    var pad = 10;

    var left = r.right + 8;
    if (left + pw > global.innerWidth - pad) left = r.left - pw - 8;
    if (left < pad) left = pad;

    var top = r.top;
    if (top + ph > global.innerHeight - pad) top = global.innerHeight - ph - pad;
    if (top < pad) top = pad;

    panelEl.style.left = Math.round(left + global.scrollX) + 'px';
    panelEl.style.top = Math.round(top + global.scrollY) + 'px';
  }

  function message(text, kind) {
    if (!panelEl) return;
    var el = panelEl.querySelector('.qa-msg');
    if (!el) return;
    el.textContent = text;
    el.className = 'qa-msg' + (kind ? ' is-' + kind : '');
  }

  async function save(ref, item, kind, owned) {
    var statusEl = panelEl && panelEl.querySelector('#qaStatus');
    var scoreEl = panelEl && panelEl.querySelector('#qaScore');
    var saveBtn = panelEl && panelEl.querySelector('.qa-save');
    var status = statusEl ? statusEl.value : 'completed';
    var raw = scoreEl ? String(scoreEl.value).trim() : '';

    if (raw && (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 10)) {
      message('Score must be a whole number from 1 to 10.', 'error');
      if (scoreEl) scoreEl.focus();
      return;
    }
    var score = raw ? Number(raw) : null;

    var targetEl = panelEl && panelEl.querySelector('#qaTarget');
    var target = targetEl ? targetEl.value : '';
    var toList = target.indexOf('list:') === 0 ? target.slice(5) : null;
    var listName = toList && targetEl.options[targetEl.selectedIndex]
      ? targetEl.options[targetEl.selectedIndex].textContent : '';

    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

    try {
      var res, data;
      if (owned && owned.id) {
        res = await global.apiFetch('/user/games/' + encodeURIComponent(owned.id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: status, score: score })
        });
      } else if (toList) {
        res = await global.apiFetch('/user/lists/' + encodeURIComponent(toList) + '/games', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ game_id: ref, game_data: toGameData(item, kind), status: status, score: score })
        });
      } else {
        res = await global.apiFetch('/user/games', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            game_id: ref,
            game_data: toGameData(item, kind),
            status: status,
            score: score
          })
        });
      }
      data = await res.json().catch(function () { return {}; });

      if (!res.ok) {
        var already = data.error === 'Game already in your list' || data.error === 'Game already in this list';
        message(already ? (toList ? 'Already in that list.' : 'Already in your library.') : (data.error || 'Could not save that.'), already ? 'ok' : 'error');
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = owned ? 'Save changes' : 'Add'; }
        return;
      }

      // A title added only to a custom list is not in the main library, so the
      // card's owned state (the tick) is left alone in that case.
      if (!toList) {
        if (typeof global.setLibraryEntry === 'function' && !data.folded_into) {
          global.setLibraryEntry(ref, { id: owned && owned.id ? owned.id : data.game_id, status: status, score: score });
        }
        if (typeof global.refreshOwnedBadge === 'function') global.refreshOwnedBadge(ref);
        refreshButton(ref);
      }

      if (typeof global.toast === 'function') {
        var msg = data.folded_into ? data.message
          : owned ? 'Updated in your library.'
          : toList ? ('Added to “' + listName + '”.')
          : 'Added to your library.';
        global.toast(msg, 'success');
      }
      close();
    } catch (err) {
      message('Network error. Please try again.', 'error');
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = owned ? 'Save changes' : 'Add'; }
    }
  }

  /* Remove an owned title from the main library, straight from the card. */
  async function remove(ref, owned, anchor) {
    if (!owned || !owned.id) return;
    var btn = panelEl && panelEl.querySelector('.qa-remove');
    if (btn) { btn.disabled = true; btn.textContent = 'Removing…'; }
    try {
      var res = await global.apiFetch('/user/games/' + encodeURIComponent(owned.id), { method: 'DELETE' });
      if (!res.ok) {
        message('Could not remove that.', 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Remove from library'; }
        return;
      }
      if (typeof global.setLibraryEntry === 'function') global.setLibraryEntry(ref, null);
      if (typeof global.refreshOwnedBadge === 'function') global.refreshOwnedBadge(ref);
      refreshButton(ref);
      if (typeof global.toast === 'function') global.toast('Removed from your library.', 'success');
      close();
      if (anchor) anchor.focus();
    } catch (err) {
      message('Network error. Please try again.', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Remove from library'; }
    }
  }

  /** Swap + for a tick once a title is saved, without redrawing the grid. */
  function refreshButton(ref) {
    var owned = (typeof global.libraryEntry === 'function') ? global.libraryEntry(ref) : null;
    var buttons = document.querySelectorAll('[data-quick-add="' + cssEscape(ref) + '"]');
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      b.classList.toggle('is-owned', !!owned);
      var label = owned ? 'Edit your entry for this title' : 'Add this title to your library';
      b.title = label;
      b.setAttribute('aria-label', label);
      var span = b.querySelector('span');
      if (span) span.textContent = owned ? '✓' : '+';
    }
  }

  /**
   * Wire a grid up once. `getItem(ref)` hands back the row the card was drawn
   * from; `kind` is game | movie | series | anime.
   */
  function bind(container, getItem, kind) {
    if (!container || container.__quickAddBound) return;
    container.__quickAddBound = true;

    container.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('[data-quick-add]');
      if (!btn || !container.contains(btn)) return;
      // The card underneath navigates; the plus must not.
      e.preventDefault();
      e.stopPropagation();
      var ref = btn.getAttribute('data-quick-add');
      open(ref, getItem(ref), kind, btn);
    }, true);

    global.addEventListener('resize', function () {
      if (!panelEl || !openFor) return;
      position(document.querySelector('[data-quick-add="' + cssEscape(openFor) + '"]'));
    });
  }

  global.MGLQuickAdd = {
    buttonHtml: buttonHtml,
    bind: bind,
    close: close,
    refreshButton: refreshButton,
    toGameData: toGameData
  };
})(typeof window !== 'undefined' ? window : globalThis);
