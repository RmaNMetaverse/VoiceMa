/** DOM rendering. Cards and rows are created once and then mutated in place —
 *  level meters update ~20 times a second and must not thrash the DOM. */

export const $ = (id) => document.getElementById(id);

const svg = (paths, extra = '') =>
  `<svg viewBox="0 0 24 24" class="ico" ${extra}>${paths}</svg>`;

export const ICONS = {
  speaker: svg('<path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>'),
  micOff: svg(
    '<path d="M9 9V6a3 3 0 0 1 5.9-.7M5.5 11.5a6.5 6.5 0 0 0 10.2 5.3M12 18v3M8.5 21h7M3 3l18 18"/>'
  ),
  deaf: svg('<path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7"/>'),
  hash: svg('<path d="M5 9h14M5 15h14M10 4l-1 16M16 4l-1 16"/>'),
  lock: svg('<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>'),
  check: svg('<path d="M4 12.5l5 5L20 6.5"/>'),
  alert: svg('<path d="M12 8v5M12 17h.01"/><circle cx="12" cy="12" r="9"/>')
};

export const initials = (name) =>
  (name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

/* ============================================================
   Toasts
   ============================================================ */

let toastSeq = 0;
export function toast(text, kind = '') {
  const host = $('toasts');
  const node = document.createElement('div');
  node.className = `toast ${kind ? 'toast-' + kind : ''}`;
  node.innerHTML =
    (kind === 'good' ? ICONS.check : kind === 'bad' ? ICONS.alert : '') +
    `<span>${escapeHTML(text)}</span>`;
  const id = ++toastSeq;
  node.dataset.id = String(id);
  host.appendChild(node);

  setTimeout(() => {
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 320);
  }, 3400);
  return node;
}

export function escapeHTML(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

/* ============================================================
   Channel list
   ============================================================ */

export function renderChannels({ channels, users, currentId, selfId, onJoin, onDelete }) {
  const list = $('channel-list');
  const frag = document.createDocumentFragment();

  for (const ch of channels) {
    const members = users.filter((u) => u.channel === ch.id);
    const li = document.createElement('li');
    li.className = 'channel';
    if (ch.id === currentId) li.classList.add('is-current');
    if (members.length >= (ch.limit || 99)) li.classList.add('is-full');

    const btn = document.createElement('button');
    btn.className = 'channel-btn';
    btn.type = 'button';
    btn.innerHTML = `
      <span class="channel-ico">${ch.locked ? ICONS.lock : ICONS.speaker}</span>
      <span class="channel-body">
        <span class="channel-name">${escapeHTML(ch.name)}</span>
        ${ch.description ? `<span class="channel-desc">${escapeHTML(ch.description)}</span>` : ''}
      </span>
      <span class="channel-count">${members.length}${ch.limit ? '/' + ch.limit : ''}</span>`;
    if (ch.locked) btn.title = `${ch.name} — password required`;
    btn.addEventListener('click', () => onJoin(ch.id));
    li.appendChild(btn);

    if (members.length) {
      const ul = document.createElement('ul');
      ul.className = 'channel-members';
      for (const m of members) {
        const row = document.createElement('li');
        row.className = 'member' + (m.speaking ? ' is-speaking' : '');
        row.innerHTML = `
          <span class="avatar" style="--hue:${m.hue}">${escapeHTML(initials(m.name))}</span>
          <span class="member-name">${escapeHTML(m.name)}${m.id === selfId ? ' (you)' : ''}</span>
          <span class="member-flags">
            ${m.mic === 'muted' ? `<span class="flag-muted">${ICONS.micOff}</span>` : ''}
            ${m.deaf ? `<span class="flag-muted">${ICONS.deaf}</span>` : ''}
          </span>`;
        ul.appendChild(row);
      }
      li.appendChild(ul);
    } else if (!ch.permanent && onDelete) {
      const del = document.createElement('button');
      del.className = 'btn btn-ghost';
      del.style.cssText = 'margin:2px 0 6px 26px;padding:4px 12px;font-size:12px';
      del.textContent = 'Delete channel';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        onDelete(ch.id);
      });
      li.appendChild(del);
    }

    frag.appendChild(li);
  }

  list.replaceChildren(frag);
}

/* ============================================================
   Participant cards
   ============================================================ */

export class Participants {
  constructor(host, { onVolume }) {
    this.host = host;
    this.onVolume = onVolume;
    this.cards = new Map();
  }

  sync(users, selfId, volumeFor) {
    const seen = new Set();

    for (const u of users) {
      seen.add(u.id);
      let card = this.cards.get(u.id);
      if (!card) {
        card = this.create(u, selfId, volumeFor(u));
        this.cards.set(u.id, card);
        this.host.appendChild(card.root);
      }
      this.update(card, u, selfId);
    }

    for (const [id, card] of this.cards) {
      if (seen.has(id)) continue;
      card.root.style.animation = 'card-in 0.3s var(--ease) reverse forwards';
      setTimeout(() => card.root.remove(), 260);
      this.cards.delete(id);
    }
  }

  create(u, selfId, volume) {
    const root = document.createElement('article');
    root.className = 'card';
    root.dataset.id = u.id;

    const isSelf = u.id === selfId;
    root.innerHTML = `
      <div class="card-badges"></div>
      <div class="avatar-wrap">
        <span class="avatar" style="--hue:${u.hue}"></span>
      </div>
      <div class="card-name"></div>
      <div class="card-sub"></div>
      <span class="meter meter-sm" style="width:100%"><i></i></span>
      ${
        isSelf
          ? ''
          : `<div class="card-volume">
               <input class="range" type="range" min="0" max="200" step="5" value="${Math.round(volume * 100)}" aria-label="Volume for ${escapeHTML(u.name)}">
             </div>`
      }`;

    const card = {
      root,
      avatar: root.querySelector('.avatar'),
      name: root.querySelector('.card-name'),
      sub: root.querySelector('.card-sub'),
      badges: root.querySelector('.card-badges'),
      meter: root.querySelector('.meter i'),
      range: root.querySelector('.range'),
      state: {}
    };

    card.range?.addEventListener('input', () => {
      this.onVolume(u.id, Number(card.range.value) / 100);
    });

    return card;
  }

  update(card, u, selfId) {
    const s = card.state;

    if (s.name !== u.name) {
      card.name.textContent = u.name + (u.id === selfId ? ' (you)' : '');
      card.avatar.textContent = initials(u.name);
      s.name = u.name;
    }
    if (s.hue !== u.hue) {
      card.avatar.style.setProperty('--hue', u.hue);
      s.hue = u.hue;
    }

    const speaking = !!u.speaking && u.mic !== 'muted';
    if (s.speaking !== speaking) {
      card.root.classList.toggle('is-speaking', speaking);
      s.speaking = speaking;
    }

    const flags = `${u.mic}|${u.deaf}|${u.id === selfId}`;
    if (s.flags !== flags) {
      card.badges.innerHTML =
        (u.id === selfId ? '<span class="badge badge-you">you</span>' : '') +
        (u.mic === 'muted' ? `<span class="badge badge-bad">${ICONS.micOff}</span>` : '') +
        (u.deaf ? `<span class="badge badge-bad">${ICONS.deaf}</span>` : '');
      s.flags = flags;
    }
  }

  setLevel(id, value) {
    const card = this.cards.get(id);
    if (!card) return;
    card.meter.style.width = Math.round(Math.min(1, value) * 100) + '%';
  }

  setSub(id, text) {
    const card = this.cards.get(id);
    if (!card || card.state.sub === text) return;
    card.sub.textContent = text;
    card.state.sub = text;
  }

  clear() {
    this.cards.clear();
    this.host.replaceChildren();
  }
}

/* ============================================================
   Chat
   ============================================================ */

const time = (ts) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function appendMessage(msg, selfId) {
  const log = $('chat-log');
  const node = document.createElement('div');
  node.className = 'msg' + (msg.from === selfId ? ' is-self' : '');
  node.innerHTML = `
    <div class="msg-head">
      <span class="avatar" style="--hue:${msg.hue ?? 250}">${escapeHTML(initials(msg.name))}</span>
      <span class="msg-author">${escapeHTML(msg.name)}</span>
      <span class="msg-time">${time(msg.ts)}</span>
    </div>
    <div class="msg-text">${linkify(msg.text)}</div>`;

  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  log.appendChild(node);
  if (atBottom) log.scrollTop = log.scrollHeight;
  return node;
}

export function systemMessage(text) {
  const log = $('chat-log');
  const node = document.createElement('div');
  node.className = 'msg msg-system';
  node.textContent = text;
  log.appendChild(node);
  log.scrollTop = log.scrollHeight;
}

/** Escapes first, then re-introduces only anchors we built ourselves. */
function linkify(text) {
  return escapeHTML(text).replace(/\b(https?:\/\/[^\s<]+)/g, (url) => {
    const safe = url.replace(/"/g, '%22');
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });
}

export function clearChat() {
  $('chat-log').replaceChildren();
}
