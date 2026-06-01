/**
 * Global recent notes box — fetches the 7 most recent Nostroots channel notes
 * from Trustroots relays and renders them into #recent-notes-list when present.
 */
const MAP_NOTE_KINDS = [30397, 42, 1];
const TRUSTROOTS_PROFILE_KIND = 10390;
const TRUSTROOTS_USERNAME_LABEL_NAMESPACE = 'org.trustroots:username';
const RELAYS = [
  'wss://relay.trustroots.org',
  'wss://relay.nomadwiki.org'
];
const LIMIT = 80;
const SHOW_COUNT = 7;
const EOSE_TIMEOUT_MS = 8000;
const REQUIRED_CHANNEL_TAGS = ['nostroots', 'wanttomeet'];

/** Ignore notes from these authors (npub prefix match). */
const IGNORED_NPUB_PREFIXES = ['npub1ld69y3d'];

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

function isAuthorIgnored(pubkey, nip19) {
  if (!pubkey || !nip19 || typeof nip19.npubEncode !== 'function') return false;
  try {
    const npub = nip19.npubEncode(pubkey);
    return IGNORED_NPUB_PREFIXES.some(function (prefix) { return npub.startsWith(prefix); });
  } catch (_) {
    return false;
  }
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

function normalizeHashtag(tag) {
  if (!tag || typeof tag !== 'string') return null;
  const cleaned = tag.trim().replace(/^#+/, '').toLowerCase();
  if (!cleaned) return null;
  if (!/^[a-z0-9_-]+$/i.test(cleaned)) return null;
  return cleaned;
}

function getHashtagsFromEvent(event) {
  if (!event || !Array.isArray(event.tags)) return [];
  const tags = [];
  const seen = new Set();
  for (let i = 0; i < event.tags.length; i++) {
    const tag = event.tags[i];
    if (!Array.isArray(tag) || tag.length < 2 || tag[0] !== 't') continue;
    const normalized = normalizeHashtag(tag[1]);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(normalized);
  }
  return tags;
}

function createChatTagLink(tag) {
  const a = document.createElement('a');
  a.href = 'https://nos.trustroots.org/chat.html#' + encodeURIComponent(tag);
  a.textContent = '#' + tag;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function appendContentWithHashtagLinks(container, text) {
  const content = text || '';
  const regex = /(^|\s)#([a-z0-9_-]+)/gi;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const full = match[0];
    const prefix = match[1] || '';
    const rawTag = match[2] || '';
    const normalized = normalizeHashtag(rawTag);
    if (!normalized) continue;
    const fullStart = match.index;
    const hashStart = fullStart + prefix.length;
    if (hashStart > lastIndex) {
      container.appendChild(document.createTextNode(content.slice(lastIndex, hashStart)));
    }
    container.appendChild(createChatTagLink(normalized));
    lastIndex = fullStart + full.length;
  }
  if (lastIndex < content.length) {
    container.appendChild(document.createTextNode(content.slice(lastIndex)));
  }
}

function contentHasRequiredTag(text, requiredTag) {
  if (!text || !requiredTag) return false;
  const escapedTag = requiredTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(^|\\s)#' + escapedTag + '(?=$|\\s|[.,!?;:])', 'i');
  return re.test(text);
}

function eventHasRequiredTag(event, requiredTag) {
  if (!requiredTag) return true;
  const required = normalizeHashtag(requiredTag);
  if (!required) return false;
  if (getHashtagsFromEvent(event).indexOf(required) !== -1) return true;
  if (event && Array.isArray(event.tags)) {
    for (let i = 0; i < event.tags.length; i++) {
      const tag = event.tags[i];
      if (!Array.isArray(tag)) continue;
      for (let j = 1; j < tag.length; j++) {
        const value = tag[j];
        if (typeof value !== 'string') continue;
        const normalizedValue = normalizeHashtag(value);
        if (normalizedValue === required) return true;
        if (value.toLowerCase().indexOf(required) !== -1) return true;
      }
    }
  }
  return contentHasRequiredTag(event && event.content, required);
}

function eventHasAnyRequiredTag(event, requiredTags) {
  if (!Array.isArray(requiredTags) || requiredTags.length === 0) return true;
  for (let i = 0; i < requiredTags.length; i++) {
    if (eventHasRequiredTag(event, requiredTags[i])) return true;
  }
  return false;
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

    item.appendChild(metaRow);

    const content = document.createElement('div');
    content.className = 'note-content';
    appendContentWithHashtagLinks(content, event.content || '');

    const hashtags = getHashtagsFromEvent(event);
    if (hashtags.length > 0) {
      const contentText = event.content || '';
      const lowerContent = contentText.toLowerCase();
      const extraTags = hashtags.filter(function (tag) {
        return lowerContent.indexOf('#' + tag) === -1;
      });
      if (extraTags.length > 0) {
        content.appendChild(document.createTextNode(' '));
        extraTags.forEach(function (tag, tagIndex) {
          if (tagIndex > 0) content.appendChild(document.createTextNode(' '));
          content.appendChild(createChatTagLink(tag));
        });
      }
    }

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
    if (MAP_NOTE_KINDS.indexOf(event.kind) === -1) return;
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
      .filter(function (e) { return eventHasAnyRequiredTag(e, REQUIRED_CHANNEL_TAGS); })
      .sort(function (a, b) { return a.created_at - b.created_at; });
    renderNotes(container, list.slice(-SHOW_COUNT), nip19, pubkeyToUsername);
  }

  const mapNotesFilter = {
    kinds: MAP_NOTE_KINDS,
    limit: 500
  };
  const profilesFilter = { kinds: [TRUSTROOTS_PROFILE_KIND], limit: 200 };

  RELAYS.forEach(function (url) {
    Relay.connect(url).then(function (relay) {
      const sub = relay.subscribe([mapNotesFilter, profilesFilter], {
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
