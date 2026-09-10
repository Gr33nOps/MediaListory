/**
 * A profile for a name that appeared beside a title: a TMDB person, a Kitsu
 * character, or an IGDB studio. One layout for all three - the server hands
 * back one shape, and whatever a provider has nothing to say about is simply
 * absent rather than filled in with a placeholder.
 *
 * The credits are a list rather than a poster grid on purpose. A filmography is
 * read - who they played, in what, when - and a wall of covers answers none of
 * those. Posters are here to help you recognise a title, so they are small and
 * to the left of the words.
 */
(function () {
  'use strict';

  var CATEGORY = {
    movie:  { label: 'Movies' },
    series: { label: 'Shows' },
    anime:  { label: 'Anime' },
    game:   { label: 'Games' }
  };

  // Where a credit opens. Each browse page knows how to open one of its own.
  var BROWSE_PAGE = {
    movie: 'movies.html',
    series: 'series.html',
    anime: 'anime.html',
    game: 'home.html'
  };

  var CREDITS_HEADING = {
    person: 'Credits',
    character: 'Appears in',
    company: 'Games'
  };

  var byId = function (id) { return document.getElementById(id); };
  var profile = null;
  var activeCategory = 'all';

  function show(el, on) { if (el) el.hidden = !on; }

  function renderFacts(facts) {
    var dl = byId('personFacts');
    if (!facts || !facts.length) { dl.innerHTML = ''; show(dl, false); return; }
    show(dl, true);
    dl.innerHTML = facts.map(function (f) {
      return '<div class="person-fact"><dt>' + esc(f.label) + '</dt><dd>' + esc(f.value) + '</dd></div>';
    }).join('');
  }

  function renderBio(summary) {
    var box = byId('personBio');
    if (!summary) { show(box, false); return; }
    show(box, true);

    // Long biographies are clamped rather than truncated: nothing is lost, and
    // the credits stay reachable without scrolling past an essay.
    if (summary.length > 520) {
      box.innerHTML = '<p class="person-bio-text is-clamped" id="personBioText">' + esc(summary) + '</p>' +
        '<button type="button" class="link-btn" id="personBioToggle">Read more</button>';
      var toggle = byId('personBioToggle');
      toggle.addEventListener('click', function () {
        var text = byId('personBioText');
        var clamped = text.classList.toggle('is-clamped');
        toggle.textContent = clamped ? 'Read more' : 'Show less';
      });
    } else {
      box.innerHTML = '<p class="person-bio-text">' + esc(summary) + '</p>';
    }
  }

  function renderGallery(gallery) {
    var section = byId('personGallerySection');
    if (!gallery || gallery.length < 2) { show(section, false); return; }
    show(section, true);
    byId('personGallery').innerHTML = gallery.map(function (src) {
      return '<img src="' + esc(src) + '" alt="" loading="lazy" onerror="this.remove()">';
    }).join('');
  }

  function creditYear(credit) {
    return credit.released ? String(credit.released).slice(0, 4) : '';
  }

  function creditRowHtml(credit) {
    var page = BROWSE_PAGE[credit.media_type];
    var href = page ? 'title.html?ref=' + encodeURIComponent(credit.ref) : null;
    var year = creditYear(credit);

    var meta = [];
    if (credit.role) meta.push(esc(credit.role));
    if (credit.episodes > 1) meta.push(esc(credit.episodes + ' episodes'));

    var inner =
      '<img class="pc-poster" src="' + esc(credit.image || '/img/no-image.svg') + '" alt="" loading="lazy"' +
        ' onerror="this.src=\'/img/no-image.svg\'">' +
      '<span class="pc-text">' +
        '<span class="pc-title">' + esc(credit.name) + '</span>' +
        (meta.length ? '<span class="pc-role">' + meta.join(' · ') + '</span>' : '') +
      '</span>' +
      '<span class="pc-year">' + esc(year) + '</span>';

    return '<li class="person-credit" data-category="' + esc(credit.media_type) + '">' +
      (href
        ? '<a class="pc-link" href="' + esc(href) + '">' + inner + '</a>'
        : '<span class="pc-link">' + inner + '</span>') +
      '</li>';
  }

  function renderCreditTabs(credits) {
    var tabs = byId('personCreditTabs');
    var counts = {};
    credits.forEach(function (c) { counts[c.media_type] = (counts[c.media_type] || 0) + 1; });
    var present = Object.keys(CATEGORY).filter(function (k) { return counts[k]; });

    // One category means there is nothing to filter between.
    if (present.length < 2) { tabs.innerHTML = ''; show(tabs, false); return; }
    show(tabs, true);

    var all = [{ key: 'all', label: 'All', count: credits.length }].concat(
      present.map(function (k) { return { key: k, label: CATEGORY[k].label, count: counts[k] }; })
    );
    tabs.innerHTML = all.map(function (t) {
      var on = t.key === activeCategory;
      return '<button type="button" class="media-tab' + (on ? ' active' : '') + '" role="tab"' +
        ' aria-selected="' + (on ? 'true' : 'false') + '" data-category="' + esc(t.key) + '">' +
        esc(t.label) + ' <span class="pt-count">' + t.count + '</span></button>';
    }).join('');
  }

  function applyCategory() {
    var rows = document.querySelectorAll('.person-credit');
    for (var i = 0; i < rows.length; i++) {
      rows[i].hidden = activeCategory !== 'all' && rows[i].dataset.category !== activeCategory;
    }
    var tabs = document.querySelectorAll('#personCreditTabs .media-tab');
    for (var j = 0; j < tabs.length; j++) {
      var on = tabs[j].dataset.category === activeCategory;
      tabs[j].classList.toggle('active', on);
      tabs[j].setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  function renderCredits(data) {
    var section = byId('personCreditsSection');
    var credits = data.credits || [];
    if (!credits.length) { show(section, false); return; }
    show(section, true);

    byId('personCreditsTitle').textContent = CREDITS_HEADING[data.kind] || 'Credits';
    renderCreditTabs(credits);
    byId('personCredits').innerHTML = credits.map(creditRowHtml).join('');
    applyCategory();
  }

  function render(data) {
    profile = data;
    document.title = data.name + ' - MediaListory';

    var portrait = byId('personImage');
    portrait.src = data.image || '/img/no-image.svg';
    portrait.alt = data.name;
    portrait.classList.toggle('is-logo', data.kind === 'company');

    byId('personName').textContent = data.name;
    renderFacts(data.facts);
    renderBio(data.summary);
    renderGallery(data.gallery);
    renderCredits(data);

    var source = byId('personSource');
    if (data.source && data.source.url) {
      source.href = data.source.url;
      source.textContent = 'View on ' + data.source.name + ' ↗';
      show(source, true);
    } else {
      show(source, false);
    }

    show(byId('personState'), false);
    show(byId('personBody'), true);
  }

  function fail(message) {
    var state = byId('personState');
    state.textContent = message;
    show(state, true);
    show(byId('personBody'), false);
  }

  async function load() {
    var ref = new URLSearchParams(window.location.search).get('ref') || '';
    if (!ref) { fail('No profile was requested.'); return; }

    try {
      var r = await apiFetch('/people', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: ref })
      });
      if (r.status === 404) { fail('That profile could not be found.'); return; }
      if (!r.ok) { fail('Could not load that profile.'); return; }
      render(await r.json());
    } catch (e) {
      fail('Could not reach the server.');
    }
  }

  function bind() {
    var back = byId('personBack');
    back.addEventListener('click', function (e) {
      e.preventDefault();
      // Straight back to whatever they were looking at, if that was this site.
      if (document.referrer && document.referrer.indexOf(window.location.origin) === 0) history.back();
      else window.location.href = 'library.html';
    });

    byId('personCreditTabs').addEventListener('click', function (e) {
      var tab = e.target.closest('.media-tab');
      if (!tab) return;
      activeCategory = tab.dataset.category;
      applyCategory();
    });

    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
