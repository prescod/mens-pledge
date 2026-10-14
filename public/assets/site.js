// Front-end for the Intervention Pledge.
//
// Talks to the Worker API under /api/*. Until the back end exists (for example
// on the GitHub Pages preview), any failed API call falls back to DEMO data so
// the pages can still be clicked through.

(function () {
  'use strict';

  var SCRIPT = document.currentScript;
  var ROOT = new URL('../', SCRIPT.src);            // site root, wherever it is hosted
  var API = new URL('api/', ROOT);

  var DEMO = {
    count: 2417,
    wall: [
      ['Marcus R.', 'Vancouver'], ['Daniel Okafor', 'Toronto'], ['Raj S.', 'Seattle'], ['Tom W.', ''],
      ['Ahmed K.', 'Calgary'], ['Luis Moreno', 'Portland'], ['Connor B.', 'Halifax'], ['Kenji T.', 'Victoria'],
      ['Graham A.', 'Ottawa'], ['Omar H.', 'Montréal'], ['Chris D.', ''], ['Sam L.', 'Winnipeg'],
      ['Noah F.', 'Burnaby'], ['Diego C.', 'Denver'], ['Andre J.', 'Chicago'], ['Viktor V.', 'Edmonton'],
      ['Jordan P.', ''], ['Farid Z.', 'Surrey'], ['Ben G.', 'Kelowna'], ['Miguel N.', 'San Diego'],
      ['Ethan Y.', 'Regina'], ['Liam M.', 'Boston'], ['Arjun D.', 'Mississauga'], ['Nathan E.', 'Saskatoon']
    ].map(function (r) { return { name: r[0], city: r[1] }; }),
    pending: [
      { id: 1, entered: 'Marcus Robinson', shown: 'Marcus R.', city: 'Vancouver', email: 'm•••@gmail.com', when: '4 min ago' },
      { id: 2, entered: 'Daniel Okafor', shown: 'Daniel Okafor', city: 'Toronto', email: 'd•••@outlook.com', when: '11 min ago' },
      { id: 3, entered: 'asdf asdf', shown: 'asdf a.', city: '', email: 'a•••@mail.com', when: '18 min ago' },
      { id: 4, entered: 'Raj Sharma', shown: 'Raj S.', city: 'Seattle', email: 'r•••@proton.me', when: '26 min ago' },
      { id: 5, entered: 'The Whole Internet', shown: 'The I.', city: 'Everywhere', email: 't•••@gmail.com', when: '40 min ago' },
      { id: 6, entered: 'Tom Walsh', shown: 'Tom W.', city: '', email: 't•••@yahoo.ca', when: '1 hr ago' },
      { id: 7, entered: 'Ahmed Khan', shown: 'Ahmed K.', city: 'Calgary', email: 'a•••@shaw.ca', when: '2 hr ago' }
    ]
  };

  // ---------- helpers ----------

  function $(sel, root) { return (root || document).querySelector(sel); }

  function formatCount(n) { return Number(n).toLocaleString('en-US'); }

  function store(kind) {
    try { return window[kind]; } catch (e) { return null; }
  }

  function remember(key, value) {
    var s = store('sessionStorage');
    try { if (s) s.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }

  function recall(key) {
    var s = store('sessionStorage');
    try { return s ? JSON.parse(s.getItem(key)) : null; } catch (e) { return null; }
  }

  // Returns parsed JSON, or throws { demo: true } when the API is not there.
  function api(path, options) {
    return fetch(new URL(path, API), options).then(function (res) {
      var type = res.headers.get('content-type') || '';
      if (type.indexOf('application/json') === -1) throw { demo: true };
      return res.json().then(function (body) {
        if (!res.ok) throw { status: res.status, body: body };
        return body;
      });
    }, function () { throw { demo: true }; });
  }

  function postJSON(path, data) {
    return api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data)
    });
  }

  // Same rule as the server: the full name if the signer opted in, otherwise
  // first word + initial of last word + "."
  function displayName(name, full) {
    var parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '';
    if (full || parts.length === 1) return parts.join(' ');
    return parts[0] + ' ' + parts[parts.length - 1].charAt(0).toUpperCase() + '.';
  }

  function getCount() {
    return api('count').then(function (b) { return b.count; }, function (err) {
      if (err && err.demo) return DEMO.count + (recall('signedCount') ? 1 : 0);
      throw err;
    });
  }

  function siteURL() { return ROOT.href; }

  // ---------- home ----------

  function initHome() {
    var countEl = $('#count');
    var form = $('#sign-form');
    var nameEl = $('#f-name');
    var cityEl = $('#f-city');
    var fullNameEl = $('#f-full-name');
    var previewName = $('#preview-name');
    var previewCity = $('#preview-city');
    var errorEl = $('#sign-error');
    var submit = $('#sign-submit');
    var signedBox = $('#signed');

    function setCount(n) { countEl.textContent = formatCount(n); }

    getCount().then(setCount, function () { /* keep server-rendered value */ });

    function updatePreview() {
      previewName.textContent = displayName(nameEl.value, fullNameEl.checked) ||
        (fullNameEl.checked ? 'Full name' : 'First name + last initial');
      var city = cityEl.value.trim();
      previewCity.textContent = city ? '· ' + city : '';
    }
    nameEl.addEventListener('input', updatePreview);
    cityEl.addEventListener('input', updatePreview);
    fullNameEl.addEventListener('change', updatePreview);
    updatePreview();

    function showSigned(count) {
      setCount(count);
      remember('signedCount', count);
      submit.hidden = true;
      signedBox.hidden = false;
      $('a', signedBox).focus();
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      errorEl.textContent = '';
      var data = {
        name: nameEl.value.trim(),
        email: $('#f-email').value.trim(),
        city: cityEl.value.trim(),
        wantsUpdates: $('#f-updates').checked,
        showFullName: fullNameEl.checked
      };
      if (!data.name) { nameEl.focus(); return; }
      submit.disabled = true;
      postJSON('sign', data).then(function (body) {
        showSigned(body.count);
      }, function (err) {
        if (err && err.demo) {
          showSigned(DEMO.count + 1);
          return;
        }
        var msg = err && err.body && err.body.error;
        if (err && err.status === 409) msg = msg || "You've already signed. Thank you.";
        if (err && err.status === 503) msg = msg || 'Signing is paused, please try again later.';
        errorEl.textContent = msg || 'Something went wrong. Please try again.';
        errorEl.focus();
      }).then(function () { submit.disabled = false; });
    });

    // Wall of names
    var list = $('#names');
    var more = $('#show-more');
    var cursor = null;

    function addNames(items) {
      items.forEach(function (p) {
        var li = document.createElement('li');
        var n = document.createElement('span');
        n.className = 'n';
        n.textContent = p.name;
        var c = document.createElement('span');
        c.className = 'c';
        c.textContent = p.city || '';
        li.appendChild(n);
        li.appendChild(c);
        list.appendChild(li);
      });
    }

    function loadWall() {
      more.disabled = true;
      api('wall' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : '')).then(function (body) {
        addNames(body.items || []);
        cursor = body.nextCursor || null;
      }, function (err) {
        if (err && err.demo && !list.children.length) addNames(DEMO.wall);
        cursor = null;
      }).then(function () {
        more.disabled = false;
        more.parentNode.hidden = !cursor;
      });
    }

    more.addEventListener('click', loadWall);
    loadWall();
  }

  // ---------- thanks ----------

  function initThanks() {
    var countEl = $('#count');
    var known = recall('signedCount');
    if (known) countEl.textContent = formatCount(known);
    else getCount().then(function (n) { countEl.textContent = formatCount(n); }, function () {});

    var url = siteURL();
    var message = 'I took the Intervention Pledge. Will you? ' + url;
    var input = $('#share-url');
    input.value = url;

    var copyBtn = $('#copy-link');
    var copyLabel = $('#copy-label');
    copyBtn.addEventListener('click', function () {
      function done() {
        copyLabel.textContent = 'Copied';
        setTimeout(function () { copyLabel.textContent = 'Copy link'; }, 2000);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, function () { input.select(); });
      } else {
        input.select();
        try { document.execCommand('copy'); done(); } catch (e) { /* user can copy manually */ }
      }
    });

    $('#share-sms').href = 'sms:?&body=' + encodeURIComponent(message);
    $('#share-email').href = 'mailto:?subject=' + encodeURIComponent('Take the Intervention Pledge') +
      '&body=' + encodeURIComponent(message);

    var moreBtn = $('#share-more');
    if (navigator.share) {
      moreBtn.addEventListener('click', function () {
        navigator.share({ title: 'The Intervention Pledge', text: message, url: url }).catch(function () {});
      });
    } else {
      moreBtn.hidden = true;
    }
  }

  // ---------- privacy ----------

  function initPrivacy() {
    var form = $('#remove-form');
    var status = $('#remove-status');
    var btn = $('button', form);
    var SAME = "Thanks. If that email has signed, we'll be in touch to confirm the removal.";
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      btn.disabled = true;
      status.textContent = '';
      postJSON('remove-request', { email: $('#r-email').value.trim() }).then(function () {
        status.textContent = SAME;
      }, function (err) {
        status.textContent = err && err.demo ? SAME : 'Something went wrong. Please try again.';
      }).then(function () { btn.disabled = false; });
    });
  }

  // ---------- admin ----------

  function initAdmin() {
    var tbody = $('#review-rows');
    var pendingEl = $('#pending-count');
    var rows = [];
    var demo = false;

    var CHECK = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>';
    var CROSS = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4A4F57" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12"></path><path d="M18 6L6 18"></path></svg>';

    function cell(tag, text, cls) {
      var el = document.createElement(tag);
      if (cls) el.className = cls;
      el.textContent = text;
      return el;
    }

    function button(label, cls, aria, onClick) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = label;
      if (aria) b.setAttribute('aria-label', aria);
      b.addEventListener('click', onClick);
      return b;
    }

    function decide(row, status) {
      var previous = row.status;
      row.status = status;
      render(row.id);
      if (demo) return;
      var action = status === 'pending' ? 'undo' : status === 'approved' ? 'approve' : 'reject';
      postJSON('admin/' + action, { id: row.id }).catch(function () {
        row.status = previous;
        render(row.id);
        alert('Could not save that decision. Please try again.');
      });
    }

    function render(focusId) {
      tbody.textContent = '';
      var pending = 0;
      rows.forEach(function (r) {
        if (r.status === 'pending') pending += 1;
        var tr = document.createElement('tr');
        if (r.status !== 'pending') tr.className = 'decided';
        var th = cell('th', r.entered);
        th.scope = 'row';
        tr.appendChild(th);
        tr.appendChild(cell('td', r.shown, 'shown'));
        tr.appendChild(cell('td', r.city || '—'));
        tr.appendChild(cell('td', r.email));
        tr.appendChild(cell('td', r.when, 'when'));
        var td = document.createElement('td');
        td.className = 'decision';
        var wrap = document.createElement('div');
        wrap.className = 'decision-cell';
        var focusTarget;
        if (r.status === 'pending') {
          focusTarget = button('Approve', 'btn btn-primary', 'Approve ' + r.entered, function () { decide(r, 'approved'); });
          wrap.appendChild(focusTarget);
          wrap.appendChild(button('Reject', 'btn', 'Reject ' + r.entered, function () { decide(r, 'rejected'); }));
        } else {
          var tag = document.createElement('span');
          tag.className = r.status === 'approved' ? 'tag tag-on' : 'tag tag-hidden';
          tag.innerHTML = r.status === 'approved' ? CHECK : CROSS;
          tag.appendChild(document.createTextNode(r.status === 'approved' ? 'On the wall' : 'Hidden'));
          wrap.appendChild(tag);
          focusTarget = button('Undo', 'undo', 'Undo decision for ' + r.entered, function () { decide(r, 'pending'); });
          wrap.appendChild(focusTarget);
        }
        td.appendChild(wrap);
        tr.appendChild(td);
        tbody.appendChild(tr);
        if (focusId === r.id) focusTarget.focus();
      });
      pendingEl.textContent = pending;
    }

    api('admin/pending').then(function (body) {
      rows = (body.items || []).map(function (r) { r.status = r.status || 'pending'; return r; });
      render();
    }, function (err) {
      if (err && err.demo) {
        demo = true;
        rows = DEMO.pending.map(function (r) { return Object.assign({ status: 'pending' }, r); });
        render();
      }
    });

    $('#sign-out').addEventListener('click', function () {
      window.location.href = new URL('cdn-cgi/access/logout', ROOT).href;
    });
  }

  var page = document.body.getAttribute('data-page');
  var init = { home: initHome, thanks: initThanks, privacy: initPrivacy, admin: initAdmin }[page];
  if (init) init();
})();
