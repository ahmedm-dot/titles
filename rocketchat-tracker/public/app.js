const COLUMNS = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'Doing' },
  { id: 'waiting', label: 'Waiting on others' },
  { id: 'done', label: 'Done' },
];
const REASON_LABEL = { mention: '@you', dm: 'DM', thread: 'Thread', group: '@all/@here', manual: 'Manual' };
const RANK = { high: 0, medium: 1, low: 2 };
const DONE_DAYS = 7;

let data = { cards: [] };
const ui = { search: '', filter: '', highOnly: false, showSnoozed: false, open: new Set() };
const $ = (s) => document.querySelector(s);

// ---------- API ----------
const api = (path, opts = {}) =>
  fetch(`/api/${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }).then((r) => r.json());
const patch = (id, body) => api(`cards/${id}`, { method: 'PATCH', body });

// ---------- live updates ----------
const events = new EventSource('/api/events');
events.addEventListener('state', (e) => {
  data = JSON.parse(e.data);
  safeRender();
});

// Don't re-render under the user's cursor while they type a note.
let pending = false;
function safeRender() {
  if (document.activeElement?.matches('#board textarea')) pending = true;
  else render();
}
document.addEventListener('focusout', () => {
  if (pending) setTimeout(() => {
    pending = false;
    safeRender();
  });
});
events.addEventListener('alert', (e) => notify(JSON.parse(e.data)));
events.onerror = () => ($('#sync').textContent = 'Disconnected from the local server, retrying…');

// ---------- browser notifications ----------
function setupNotifyButton() {
  const btn = $('#notifyBtn');
  if (!('Notification' in window) || Notification.permission === 'granted') return;
  btn.hidden = false;
  btn.onclick = async () => {
    if ((await Notification.requestPermission()) === 'granted') btn.hidden = true;
  };
}

function notify(alerts) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (alerts.length > 3) {
    new Notification(`${alerts.length} new items need you`, {
      body: alerts.slice(0, 3).map((a) => `• ${a.sender?.name}: ${a.title}`).join('\n'),
      tag: 'chat-tracker-batch',
    });
    return;
  }
  for (const a of alerts) {
    const n = new Notification(a.woke ? `⏰ Snooze over: ${a.title}` : `${a.sender?.name} in ${a.roomName}`, {
      body: a.title,
      tag: a.id,
    });
    n.onclick = () => {
      window.focus();
      ui.open.add(a.id);
      render();
      document.getElementById(a.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
  }
}

// ---------- rendering ----------
const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function visible(card) {
  const now = new Date().toISOString();
  if (!ui.showSnoozed && card.snoozedUntil && card.snoozedUntil > now) return false;
  if (card.status === 'done' && Date.now() - Date.parse(card.updatedAt) > DONE_DAYS * 864e5) return false;
  if (ui.highOnly && card.priority !== 'high') return false;
  if (ui.filter && !(card.reasons || []).includes(ui.filter) && card.type !== ui.filter) return false;
  if (ui.search) {
    const hay = [card.title, card.notes, card.roomName, card.sender?.name, card.sender?.username, ...(card.messages || []).map((m) => m.text)]
      .join(' ')
      .toLowerCase();
    if (!hay.includes(ui.search)) return false;
  }
  return true;
}

function render() {
  const now = new Date().toISOString();
  const open = data.cards.filter((c) => c.status !== 'done');
  const awake = open.filter((c) => !c.snoozedUntil || c.snoozedUntil <= now);

  const synced = data.lastPoll ? `Synced ${ago(data.lastPoll)}` : 'First sync in progress…';
  $('#sync').textContent = data.me ? `@${data.me.username} · ${synced} · every ${data.pollSeconds}s` : synced;
  $('#error').hidden = !data.error;
  $('#error').textContent = data.error ? `Rocket.Chat sync error: ${data.error}` : '';

  const count = (fn) => awake.filter(fn).length;
  const inbox = count((c) => c.status === 'inbox');
  const stats = [
    ['Inbox', inbox, inbox > 0],
    ['High priority', count((c) => c.priority === 'high'), count((c) => c.priority === 'high') > 0],
    ['@ mentions', count((c) => c.reasons?.includes('mention')), false],
    ['Requirements', count((c) => c.type === 'requirement'), false],
    ['Waiting on others', count((c) => c.status === 'waiting'), false],
    ['Snoozed', open.length - awake.length, false],
  ];
  $('#stats').innerHTML = stats.map(([l, n, hot]) => `<span class="stat ${hot ? 'hot' : ''}">${l} <b>${n}</b></span>`).join('');
  document.title = inbox ? `(${inbox}) Chat Tracker` : 'Chat Tracker';

  const cards = data.cards.filter(visible).sort(
    (a, b) => RANK[a.priority] - RANK[b.priority] || b.lastTs.localeCompare(a.lastTs)
  );

  $('#board').innerHTML = COLUMNS.map((col) => {
    const items = cards.filter((c) => c.status === col.id);
    return `<section class="col" data-status="${col.id}">
      <h2><span>${col.label}</span><span>${items.length}</span></h2>
      ${items.map(cardHtml).join('') || '<div class="empty">Nothing here</div>'}
    </section>`;
  }).join('');
}

function cardHtml(c) {
  const reasons = (c.reasons || [])
    .map((r) => (r.startsWith('keyword:') ? `#${r.slice(8)}` : REASON_LABEL[r] || r))
    .map((r, i) => `<span class="tag ${c.reasons[i]}">${esc(r)}</span>`)
    .join('');
  const snoozed = c.snoozedUntil && c.snoozedUntil > new Date().toISOString();
  const moves = COLUMNS.filter((col) => col.id !== c.status)
    .map((col) => `<option value="${col.id}">${col.label}</option>`)
    .join('');
  const msgs = (c.messages || [])
    .map((m) => `<div class="msg"><time>${new Date(m.ts).toLocaleString()}</time>${esc(m.text)}</div>`)
    .join('');

  return `<article class="card ${c.priority} ${c.woke ? 'woke' : ''}" id="${c.id}" draggable="true">
    <div class="meta">
      <span class="tag">${esc(c.type)}</span>${reasons}
      ${c.urgent ? '<span class="tag urgent">urgent</span>' : ''}
      ${c.replied ? '<span class="tag replied">✓ replied</span>' : ''}
      ${snoozed ? `<span class="tag">⏰ ${new Date(c.snoozedUntil).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>` : ''}
    </div>
    <div class="title" dir="auto">${esc(c.title)}</div>
    <div class="meta">
      ${c.sender?.name ? `<span>${esc(c.sender.name)}</span>` : ''}
      ${c.roomName ? `<span>· ${c.roomType === 'd' ? 'DM' : '#' + esc(c.roomName)}</span>` : ''}
      <span>· ${ago(c.lastTs)}</span>
      ${c.messages?.length > 1 ? `<span>· ${c.messages.length} msgs</span>` : ''}
    </div>
    <details ${ui.open.has(c.id) ? 'open' : ''} data-id="${c.id}">
      <summary>Details &amp; notes</summary>
      ${msgs}
      <textarea data-notes="${c.id}" placeholder="Your notes, next step, due date…">${esc(c.notes)}</textarea>
    </details>
    <div class="bar">
      ${c.link ? `<a class="open" href="${esc(c.link)}" target="_blank" rel="noopener">Open in chat ↗</a>` : ''}
      ${c.status !== 'done' ? `<button data-act="done" data-id="${c.id}">✓ Done</button>` : ''}
      <select data-move="${c.id}"><option value="">Move…</option>${moves}</select>
      <select data-snooze="${c.id}">
        <option value="">Snooze…</option>
        <option value="1h">1 hour</option>
        <option value="3h">3 hours</option>
        <option value="tomorrow">Tomorrow 9:00</option>
        <option value="monday">Monday 9:00</option>
        ${snoozed ? '<option value="clear">Unsnooze</option>' : ''}
      </select>
      <button data-act="delete" data-id="${c.id}" title="Delete">🗑</button>
    </div>
  </article>`;
}

function snoozeTime(choice) {
  const d = new Date();
  if (choice === '1h') d.setHours(d.getHours() + 1);
  else if (choice === '3h') d.setHours(d.getHours() + 3);
  else {
    d.setDate(d.getDate() + (choice === 'monday' ? ((8 - d.getDay()) % 7 || 7) : 1));
    d.setHours(9, 0, 0, 0);
  }
  return d.toISOString();
}

// ---------- interactions ----------
const board = $('#board');

board.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const { act, id } = btn.dataset;
  if (act === 'done') await patch(id, { status: 'done' });
  if (act === 'delete' && confirm('Delete this card?')) await api(`cards/${id}`, { method: 'DELETE' });
});

board.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.move && t.value) await patch(t.dataset.move, { status: t.value });
  if (t.dataset.snooze && t.value) {
    await patch(t.dataset.snooze, { snoozedUntil: t.value === 'clear' ? null : snoozeTime(t.value) });
  }
  if (t.dataset.notes) await patch(t.dataset.notes, { notes: t.value });
});

board.addEventListener('toggle', (e) => {
  const id = e.target.dataset?.id;
  if (id) e.target.open ? ui.open.add(id) : ui.open.delete(id);
}, true);

// drag & drop between columns
board.addEventListener('dragstart', (e) => {
  const card = e.target.closest('.card');
  if (card) e.dataTransfer.setData('text/plain', card.id);
});
board.addEventListener('dragover', (e) => {
  const col = e.target.closest('.col');
  if (!col) return;
  e.preventDefault();
  document.querySelectorAll('.col.drop').forEach((c) => c !== col && c.classList.remove('drop'));
  col.classList.add('drop');
});
board.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget || !e.target.closest('.col')?.contains(e.relatedTarget)) {
    e.target.closest('.col')?.classList.remove('drop');
  }
});
board.addEventListener('drop', async (e) => {
  const col = e.target.closest('.col');
  if (!col) return;
  e.preventDefault();
  col.classList.remove('drop');
  const id = e.dataTransfer.getData('text/plain');
  if (id) await patch(id, { status: col.dataset.status });
});

// filters
$('#search').addEventListener('input', (e) => {
  ui.search = e.target.value.trim().toLowerCase();
  render();
});
$('#typeFilter').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  ui.filter = b.dataset.type;
  document.querySelectorAll('#typeFilter button').forEach((x) => x.classList.toggle('on', x === b));
  render();
});
$('#highOnly').addEventListener('change', (e) => {
  ui.highOnly = e.target.checked;
  render();
});
$('#showSnoozed').addEventListener('change', (e) => {
  ui.showSnoozed = e.target.checked;
  render();
});

// header actions
$('#refreshBtn').onclick = () => {
  $('#sync').textContent = 'Syncing…';
  api('poll', { method: 'POST' });
};
$('#addBtn').onclick = () => $('#addDialog').showModal();
$('#addForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  const f = new FormData(e.target);
  await api('cards', { method: 'POST', body: Object.fromEntries(f) });
  e.target.reset();
});

setupNotifyButton();
setInterval(safeRender, 60000); // keep "x min ago" fresh
