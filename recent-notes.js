/**
 * Global recent notes box — fetches the 7 most recent Nostroots map notes (kind 30397)
 * from Trustroots relays and renders them into #recent-notes-list when present.
 */
const MAP_NOTE_KIND = 30397;
const TRUSTROOTS_PROFILE_KIND = 10390;
const TRUSTROOTS_USERNAME_LABEL_NAMESPACE = 'org.trustroots:username';
const RELAYS = [
  'wss://relay.trustroots.org',
  'wss://relay.nomadwiki.org'
];
const LIMIT = 80;
const SHOW_COUNT = 7;
const EOSE_TIMEOUT_MS = 8000;

function formatDate(timestamp) {
  const date = new Date(timestamp * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return year + '-' + month + '-' + day + ' ' + hours + ':' + minutes;
}

function formatRelativeTime(timestamp) {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;
  if (diff < 60) return 'now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h';
  if (diff < 2592000) return Math.floor(diff / 86400) + 'd';
  if (diff < 31536000) return Math.floor(diff / 2592000) + 'd';
  return Math.floor(diff / 31536000) + 'y';
}

function isEventExpired(event) {
  if (!event.tags || !Array.isArray(event.tags)) return false;
  for (let i = 0; i < event.tags.length; i++) {
    const tag = event.tags[i];
    if (tag && tag.length >= 2 && tag[0] === 'expiration') {
      const expirationTimestamp = parseInt(tag[1], 10);
      if (!isNaN(expirationTimestamp) && expirationTimestamp <= Math.floor(Date.now() / 1000)) {
        return true;
      }
    }
  }
  return false;
}

function shortNoteId(id) {
  if (!id || typeof id !== 'string') return '—';
  return id.substring(0, 8) + '+';
}

function getPlusCodeFromEvent(event) {
  if (!event.tags || !Array.isArray(event.tags)) return null;
  for (let i = 0; i < event.tags.length; i++) {
    const tag = event.tags[i];
    if (tag && tag.length >= 3 && tag[0] === 'l' && tag[2] === 'open-location-code') {
      return tag[1] || null;
    }
  }
  return null;
}

function getTrustrootsUsernameFromProfileEvent(event) {
  if (!event.tags || !Array.isArray(event.tags)) return null;
  for (let i = 0; i < event.tags.length; i++) {
    const tag = event.tags[i];
    if (tag && tag.length >= 3 && tag[0] === 'l' && tag[2] === TRUSTROOTS_USERNAME_LABEL_NAMESPACE) {
      return tag[1] || null;
    }
  }
  return null;
}

function authorDisplay(pubkey, nip19, pubkeyToUsername) {
  if (!pubkey) return '—';
  const username = pubkeyToUsername && pubkeyToUsername.get(pubkey);
  if (username) return '@' + username;
  try {
    if (nip19 && typeof nip19.npubEncode === 'function') {
      const npub = nip19.npubEncode(pubkey);
      return npub.substring(0, 12) + '…';
    }
  } catch (_) {}
  return pubkey.substring(0, 12) + '…';
}

function escapeHtml(text) {
  if (text == null) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function setLoading(container, message) {
  container.innerHTML = '<p class="recent-notes-loading">' + escapeHtml(message) + '</p>';
}

function setError(container, message) {
  container.innerHTML = '<p class="recent-notes-error">' + escapeHtml(message) + '</p>';
}

function renderNotes(container, events, nip19, pubkeyToUsername) {
  container.innerHTML = '';
  if (!events || events.length === 0) {
    container.innerHTML = '<p class="recent-notes-empty">No notes yet.</p>';
    return;
  }
  events.forEach(function (event, index) {
    const item = document.createElement('div');
    item.className = 'recent-note-item';

    const metaRow = document.createElement('div');
    metaRow.className = 'note-meta-row';

    const meta = document.createElement('span');
    meta.className = 'note-meta';
    meta.textContent = formatDate(event.created_at);
    metaRow.appendChild(meta);
    metaRow.appendChild(document.createTextNode(' '));

    const author = document.createElement('span');
    author.className = 'note-author';
    author.textContent = authorDisplay(event.pubkey, nip19, pubkeyToUsername);
    metaRow.appendChild(author);
    metaRow.appendChild(document.createTextNode(' '));

    const relSpan = document.createElement('span');
    relSpan.className = 'note-relative-time';
    relSpan.setAttribute('aria-hidden', 'true');
    relSpan.textContent = '\u23F1 ' + formatRelativeTime(event.created_at);
    metaRow.appendChild(relSpan);

    const plusCode = getPlusCodeFromEvent(event);
    const rightLabel = plusCode || shortNoteId(event.id);
    const idSpan = document.createElement('span');
    idSpan.className = 'note-id';
    idSpan.textContent = rightLabel;
    idSpan.title = plusCode ? (event.id || '') : (event.id || '');
    metaRow.appendChild(idSpan);

    item.appendChild(metaRow);

    const content = document.createElement('div');
    content.className = 'note-content';
    content.textContent = event.content || '';
    item.appendChild(content);

    container.appendChild(item);
    if (index < events.length - 1) {
      const sep = document.createElement('img');
      sep.className = 'recent-note-separator';
      sep.src = 'images/notes-separator.svg';
      sep.alt = '';
      sep.setAttribute('aria-hidden', 'true');
      container.appendChild(sep);
    }
  });
}

function run(Relay, nip19) {
  const container = document.getElementById('recent-notes-list');
  if (!container) return;

  const byId = new Map();
  const pubkeyToUsername = new Map();

  function onEvent(event) {
    if (event.kind === TRUSTROOTS_PROFILE_KIND) {
      const username = getTrustrootsUsernameFromProfileEvent(event);
      if (username && event.pubkey) {
        pubkeyToUsername.set(event.pubkey, username);
      }
      return;
    }
    if (event.kind !== MAP_NOTE_KIND) return;
    if (byId.has(event.id)) return;
    byId.set(event.id, event);
  }

  setLoading(container, 'Loading recent notes…');

  let eoseCount = 0;
  const totalRelays = RELAYS.length;

  function maybeDone() {
    if (eoseCount < totalRelays) return;
    const list = Array.from(byId.values())
      .filter(function (e) { return !isEventExpired(e); })
      .sort(function (a, b) { return a.created_at - b.created_at; });
    renderNotes(container, list.slice(-SHOW_COUNT), nip19, pubkeyToUsername);
  }

  const filter = { kinds: [MAP_NOTE_KIND, TRUSTROOTS_PROFILE_KIND], limit: 200 };

  RELAYS.forEach(function (url) {
    Relay.connect(url).then(function (relay) {
      const sub = relay.subscribe([filter], {
        onevent: function (event) {
          onEvent(event);
        },
        oneose: function () {
          eoseCount++;
          maybeDone();
          try { sub.unsubscribe(); } catch (_) {}
          try { relay.close(); } catch (_) {}
        }
      });
      setTimeout(function () {
        eoseCount++;
        maybeDone();
        try { sub.unsubscribe(); } catch (_) {}
        try { relay.close(); } catch (_) {}
      }, EOSE_TIMEOUT_MS);
    }).catch(function () {
      eoseCount++;
      maybeDone();
    });
  });
}

function init() {
  const container = document.getElementById('recent-notes-list');
  if (!container) return;

  import('https://cdn.jsdelivr.net/npm/nostr-tools@2.23.1/+esm')
    .then(function (m) {
      const mod = m.default || m;
      const Relay = mod.Relay || m.Relay;
      const nip19 = mod.nip19 || m.nip19;
      if (Relay) {
        run(Relay, nip19);
      } else {
        throw new Error('Relay not found');
      }
    })
    .catch(function (err) {
      setError(container, 'Could not load notes. Try again later.');
      console.warn('recent-notes:', err);
    });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
