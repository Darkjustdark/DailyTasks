'use strict';
/* DopaminApp — offline task & reward tracker */
(() => {
  const STORE_KEY = 'dopaminapp.v1';
  const XP_FLOOR = -50;                       // XP may never drop below this
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];   // Monday first
  const EMOJIS = ['🎬', '🍕', '🎮', '🛋️', '🛍️', '🍦', '🍔', '☕', '🍺', '🎧', '📺', '🎢', '💆', '🍰', '✈️', '🎁'];

  const $ = (s, r = document) => r.querySelector(s);
  const view = $('#view');

  /* ---------- Dates & periods ---------- */
  const pad = n => String(n).padStart(2, '0');
  const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseDay = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  function weekStart(d = new Date()) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return x;
  }
  const weekKey = (d = new Date()) => 'W' + dayKey(weekStart(d));
  const monthKey = (d = new Date()) => `M${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const periodKey = (type, d = new Date()) => type === 'daily' ? dayKey(d) : type === 'weekly' ? weekKey(d) : monthKey(d);
  function prevPeriod(type, d) {
    if (type === 'daily') { const x = new Date(d); x.setDate(x.getDate() - 1); return x; }
    if (type === 'weekly') { const x = weekStart(d); x.setDate(x.getDate() - 7); return x; }
    return new Date(d.getFullYear(), d.getMonth() - 1, 1);
  }
  function nextReset(type) {
    const n = new Date();
    if (type === 'daily') return new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1);
    if (type === 'weekly') { const w = weekStart(n); w.setDate(w.getDate() + 7); return w; }
    return new Date(n.getFullYear(), n.getMonth() + 1, 1);
  }
  function resetsIn(type) {
    const ms = nextReset(type) - new Date();
    const h = Math.floor(ms / 3.6e6);
    if (h < 1) return '< 1 hour';
    if (h < 24) return `${h} hour${h > 1 ? 's' : ''}`;
    const d = Math.floor(ms / 8.64e7);
    return `${d} day${d > 1 ? 's' : ''}`;
  }

  /* ---------- State ---------- */
  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

  function defaultState() {
    const today = dayKey();
    const t = (type, name, xp, extra) => ({ id: uid(), type, name, xp, created: today, ...extra });
    const s = (name, price, icon) => ({ id: uid(), name, price, icon });
    return {
      version: 1,
      xp: 0,
      tasks: [
        t('daily', 'Apply for a job', 25, { days: [1, 2, 3, 4, 5] }),
        t('daily', 'Read for 20 minutes', 10, { days: EVERY_DAY.slice() }),
        t('daily', 'Drink 2 L of water', 5, { days: EVERY_DAY.slice() }),
        t('daily', 'Tidy up for 10 minutes', 10, { days: EVERY_DAY.slice() }),
        t('weekly', 'Go bouldering', 50, { target: 1 }),
        t('weekly', 'Do sports', 80, { target: 3 }),
        t('weekly', 'Call family or a friend', 30, { target: 1 }),
        t('monthly', 'Deep-clean the apartment', 120, { target: 1 }),
        t('monthly', 'Finish a book', 150, { target: 1 }),
        t('monthly', 'Meet friends', 200, { target: 4 }),
      ],
      shop: [
        s('Cinema', 150, '🎬'),
        s('Order takeaway', 120, '🍕'),
        s('1 hour of gaming', 40, '🎮'),
        s('Lazy day', 300, '🛋️'),
        s('Buy something nice', 250, '🛍️'),
        s('Ice cream', 30, '🍦'),
      ],
      progress: {},   // taskId -> periodKey -> { count, done, awarded }
      history: [],    // newest first
    };
  }
  const isValid = s => s && typeof s.xp === 'number' && Array.isArray(s.tasks) && Array.isArray(s.shop)
    && s.progress && typeof s.progress === 'object' && Array.isArray(s.history);

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) { const s = JSON.parse(raw); if (isValid(s)) return s; }
    } catch (e) { /* fall through */ }
    const s = defaultState();
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
    return s;
  }
  let state = load();
  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) { toast('Could not save — storage full?'); }
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  const findTask = id => state.tasks.find(t => t.id === id);
  const target = t => t.type === 'daily' ? 1 : Math.max(1, t.target | 0);
  const getProg = (t, key = periodKey(t.type)) => ({ count: 0, done: false, awarded: 0, ...((state.progress[t.id] || {})[key] || {}) });
  const setProg = (t, p, key = periodKey(t.type)) => { (state.progress[t.id] = state.progress[t.id] || {})[key] = p; };
  const isDue = (t, d) => t.type !== 'daily' || t.days.includes(d.getDay());

  // Streak: consecutive due periods completed. The current period only adds if done;
  // it never breaks the streak while still open. Non-due days are skipped.
  function streakOf(t) {
    const createdKey = periodKey(t.type, parseDay(t.created || dayKey()));
    const prog = state.progress[t.id] || {};
    let d = new Date(), s = 0;
    for (let i = 0; i < 4000; i++) {
      const k = periodKey(t.type, d);
      if (k < createdKey) break;
      if (isDue(t, d)) {
        if (prog[k] && prog[k].done) s++;
        else if (i > 0) break;
      }
      d = prevPeriod(t.type, d);
    }
    return s;
  }

  /* ---------- Helpers ---------- */
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => (n < 0 ? '−' : '') + Math.abs(n).toLocaleString('en-US');
  function daysLabel(days) {
    const s = WEEK_ORDER.filter(d => days.includes(d));
    if (s.length === 7) return 'Every day';
    const k = s.join(',');
    if (k === '1,2,3,4,5') return 'Mon–Fri';
    if (k === '6,0') return 'Weekends';
    return s.map(d => DAY_NAMES[d]).join(', ');
  }
  const ICON_CHECK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const ICON_TRASH = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
  const ICON_EDIT = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/></svg>';
  const ICON_BACK = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>';

  /* ---------- Sound & haptics ---------- */
  let actx = null;
  function audio() {
    if (!actx) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return null; actx = new C(); }
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }
  function tone(freq, start, dur, type = 'sine', gain = 0.15) {
    const c = audio(); if (!c) return;
    const o = c.createOscillator(), g = c.createGain();
    const t = c.currentTime + start;
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t); o.stop(t + dur + 0.05);
  }
  const sfx = {
    complete() { [[784, 0], [988, 0.07], [1319, 0.14]].forEach(([f, s]) => { tone(f, s, 0.4, 'triangle', 0.16); tone(f * 2, s, 0.25, 'sine', 0.035); }); },
    big() { [523, 659, 784, 1047, 1319].forEach((f, i) => { tone(f, i * 0.075, 0.5, 'triangle', 0.15); tone(f * 2, i * 0.075, 0.3, 'sine', 0.03); }); tone(1568, 0.42, 0.7, 'sine', 0.06); },
    step() { tone(880, 0, 0.14, 'triangle', 0.13); tone(1320, 0.05, 0.12, 'sine', 0.05); },
    coin() { tone(988, 0, 0.09, 'square', 0.05); tone(1319, 0.08, 0.4, 'square', 0.05); },
    undo() { tone(523, 0, 0.12, 'sine', 0.11); tone(392, 0.08, 0.18, 'sine', 0.09); },
    error() { tone(180, 0, 0.2, 'sawtooth', 0.05); },
  };
  const buzz = p => { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* ignore */ } };

  /* ---------- FX ---------- */
  const fxLayer = $('#fx');
  function floatText(x, y, text, cls = '') {
    const el = document.createElement('div');
    el.className = 'float-xp ' + cls;
    el.textContent = text;
    el.style.left = x + 'px'; el.style.top = y + 'px';
    fxLayer.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  }
  function burst(x, y, n = 16) {
    const colors = ['#f7c948', '#ffe08a', '#ffffff', '#e9a21a'];
    for (let i = 0; i < n; i++) {
      const s = document.createElement('i');
      s.className = 'spark';
      s.style.left = x + 'px'; s.style.top = y + 'px';
      s.style.background = colors[i % colors.length];
      const size = 4 + Math.random() * 5; s.style.width = s.style.height = size + 'px';
      fxLayer.appendChild(s);
      const a = Math.random() * Math.PI * 2, d = 35 + Math.random() * 75;
      const anim = s.animate([
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
        { transform: `translate(calc(-50% + ${Math.cos(a) * d}px), calc(-50% + ${Math.sin(a) * d}px)) scale(.2)`, opacity: 0 },
      ], { duration: 550 + Math.random() * 400, easing: 'cubic-bezier(.2,.8,.3,1)' });
      anim.onfinish = () => s.remove();
    }
  }
  function bumpBadge() {
    const b = $('#xpBadge');
    b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump');
  }
  function flashCard(id) {
    const c = view.querySelector(`.card[data-id="${id}"]`);
    if (c) { c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash'); }
  }
  const rectOf = el => el ? el.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };

  function celebrate(rect, amount, big, id) {
    (big ? sfx.big : sfx.complete)();
    buzz(big ? [30, 40, 30, 40, 90] : [25, 30, 50]);
    const x = big ? rect.left + rect.width / 2 : rect.left + 31, y = rect.top + rect.height / 2;
    floatText(x, y, `+${fmt(amount)} XP`);
    burst(x, y, big ? 30 : 16);
    setTimeout(bumpBadge, 250);
    flashCard(id);
  }
  function undoFx(rect, amount) {
    sfx.undo(); buzz(15);
    if (amount) floatText(rect.left + rect.width / 2, rect.top + rect.height / 2, `−${fmt(amount)} XP`, 'minus small');
  }
  function blocked() {
    sfx.error(); buzz([40, 40, 40]);
    toast(`Can't undo — your XP can't go below ${fmt(XP_FLOOR)}`);
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  /* ---------- XP badge ---------- */
  let shownXP = state.xp, xpRaf = 0;
  function renderXP(animate = true) {
    const el = $('#xpValue');
    $('#xpBadge').classList.toggle('neg', state.xp < 0);
    cancelAnimationFrame(xpRaf);
    if (!animate) { shownXP = state.xp; el.textContent = fmt(shownXP); return; }
    const from = shownXP, to = state.xp, t0 = performance.now(), dur = 700;
    const step = now => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      shownXP = Math.round(from + (to - from) * e);
      el.textContent = fmt(shownXP);
      if (k < 1) xpRaf = requestAnimationFrame(step);
    };
    xpRaf = requestAnimationFrame(step);
  }

  /* ---------- Rendering ---------- */
  let tab = 'daily', editMode = false, histTab = 'tasks';
  const TITLES = { daily: 'Today', weekly: 'This week', monthly: 'This month', shop: 'Shop' };

  function subtitle() {
    const now = new Date();
    if (tab === 'daily') return now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    if (tab === 'weekly') {
      const s = weekStart(now), e = new Date(s); e.setDate(e.getDate() + 6);
      const f = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      return `${f(s)} – ${f(e)}`;
    }
    if (tab === 'monthly') return now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    return 'Treat yourself — you earned it';
  }

  function render() {
    $('#title').textContent = TITLES[tab];
    $('#subtitle').textContent = editMode ? 'Editing' : subtitle();
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $('#btnEdit').classList.toggle('on', editMode);
    let html = editMode ? editBanner() : '';
    if (tab === 'shop') html += editMode ? shopEdit() : shopView();
    else html += editMode ? tasksEdit(tab) : tasksView(tab);
    view.innerHTML = html;
  }

  function summary(type, doneN, total) {
    const pct = total ? Math.round((doneN / total) * 100) : 0;
    const complete = total > 0 && doneN >= total;
    const label = complete ? 'All done — great job! 🎉'
      : type === 'daily' ? `${doneN} of ${total} task${total === 1 ? '' : 's'} done`
      : `${doneN} of ${total} done`;
    return `<section class="summary ${complete ? 'complete' : ''}">
      <div class="sum-top">
        <div><div class="sum-pct">${pct}<span>%</span></div><div class="sum-label">${label}</div></div>
        <div class="sum-reset">Resets in<br><b>${resetsIn(type)}</b></div>
      </div>
      <div class="bar"><i style="width:${pct}%"></i></div>
    </section>`;
  }

  function streakTag(t) {
    const s = streakOf(t);
    return `<span class="streak ${s ? '' : 'zero'}">🔥 ${s}</span>`;
  }

  function dailyCard(t, p) {
    return `<div class="card task ${p.done ? 'done' : ''}" data-act="toggle" data-id="${t.id}">
      <div class="check">${ICON_CHECK}</div>
      <div class="body">
        <div class="name">${esc(t.name)}</div>
        <div class="meta">${streakTag(t)}<span>${daysLabel(t.days)}</span></div>
      </div>
      <div class="xp-pill">+${fmt(t.xp)}</div>
    </div>`;
  }

  function counterCard(t, p) {
    const tg = target(t), c = Math.min(p.done ? tg : p.count, tg);
    const pct = Math.round((c / tg) * 100);
    const C = 2 * Math.PI * 19;
    return `<div class="card task counter ${p.done ? 'done' : ''}" data-act="inc" data-id="${t.id}">
      <div class="ring">
        <svg width="46" height="46" viewBox="0 0 46 46"><circle class="track" cx="23" cy="23" r="19" fill="none" stroke-width="4"/>
        <circle class="fg" cx="23" cy="23" r="19" fill="none" stroke-width="4" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct / 100)}"/></svg>
        <span>${pct}%</span>
      </div>
      <div class="body">
        <div class="name">${esc(t.name)}</div>
        <div class="meta"><span class="count">${c}/${tg}</span>${streakTag(t)}<span class="gold">+${fmt(t.xp)} XP</span></div>
      </div>
      <div class="stepper">
        <button data-act="dec" data-id="${t.id}" ${c <= 0 ? 'disabled' : ''} aria-label="Minus one">−</button>
        <button class="plus" data-act="inc" data-id="${t.id}" ${p.done ? 'disabled' : ''} aria-label="Plus one">+</button>
      </div>
    </div>`;
  }

  function tasksView(type) {
    const today = new Date();
    const tasks = state.tasks.filter(t => t.type === type && isDue(t, today));
    if (!tasks.length) {
      const anyOfType = state.tasks.some(t => t.type === type);
      return summary(type, 0, 0) + `<div class="empty"><div class="big">${anyOfType ? '🌴' : '✨'}</div>${
        anyOfType ? 'Nothing due today. Enjoy your day!' : 'No tasks yet.<br>Tap the pencil to add some.'}</div>`;
    }
    const items = tasks.map(t => ({ t, p: getProg(t) }));
    const todo = items.filter(i => !i.p.done), done = items.filter(i => i.p.done);
    let doneN, total;
    if (type === 'daily') { doneN = done.length; total = items.length; }
    else {
      total = items.reduce((a, i) => a + target(i.t), 0);
      doneN = items.reduce((a, i) => a + (i.p.done ? target(i.t) : Math.min(i.p.count, target(i.t))), 0);
    }
    const card = type === 'daily' ? dailyCard : counterCard;
    let html = summary(type, doneN, total);
    if (todo.length) html += `<div class="section-label"><span>To do</span><span>${todo.length}</span></div>` + todo.map(i => card(i.t, i.p)).join('');
    if (done.length) html += `<div class="section-label"><span>Done</span><span>${done.length}</span></div>` + done.map(i => card(i.t, i.p)).join('');
    return html;
  }

  function editBanner() {
    return `<div class="edit-banner">
      <b>Editor mode</b><span class="note">Tap an item to edit it. Tap the pencil again when you're done.</span>
      <div class="backup">
        <button class="btn-sm" data-act="export">⬇ Export backup</button>
        <button class="btn-sm" data-act="import">⬆ Import backup</button>
      </div>
    </div>`;
  }

  function tasksEdit(type) {
    const tasks = state.tasks.filter(t => t.type === type);
    const per = type === 'weekly' ? 'week' : 'month';
    return `<div class="section-label"><span>All ${type} tasks</span><span>${tasks.length}</span></div>` +
      tasks.map(t => `<div class="card edit-row" data-act="edit" data-id="${t.id}">
        <div class="body">
          <div class="name">${esc(t.name)}</div>
          <div class="meta"><span class="gold">${fmt(t.xp)} XP</span><span>${type === 'daily' ? daysLabel(t.days) : `${target(t)}× per ${per}`}</span></div>
        </div>
        <span class="chev">${ICON_EDIT}</span>
        <button class="icon-btn small danger" data-act="delete" data-id="${t.id}" aria-label="Delete">${ICON_TRASH}</button>
      </div>`).join('') +
      `<button class="add-btn" data-act="add">+ Add ${type} task</button>`;
  }

  function boughtThisWeek(itemId) {
    const ws = weekStart().getTime();
    return state.history.filter(h => h.kind === 'purchase' && h.refId === itemId && !h.refunded && h.ts >= ws).length;
  }

  function shopView() {
    if (!state.shop.length) return `<div class="empty"><div class="big">🛍️</div>The shop is empty.<br>Tap the pencil to add rewards.</div>`;
    return `<div class="shop-grid">` + state.shop.map(i => {
      const can = state.xp >= i.price, n = boughtThisWeek(i.id);
      return `<div class="card shop-item" data-id="${i.id}">
        <div class="emoji">${esc(i.icon || '🎁')}</div>
        <div class="name">${esc(i.name)}</div>
        <div class="price">${fmt(i.price)} XP</div>
        ${n ? `<div class="bought">${n}× this week</div>` : ''}
        <button class="buy ${can ? '' : 'locked'}" data-act="buy" data-id="${i.id}">${can ? 'Buy' : `Need ${fmt(i.price - state.xp)} more`}</button>
      </div>`;
    }).join('') + `</div><p class="hint">Bought something by mistake? Undo it in the history (clock icon).</p>`;
  }

  function shopEdit() {
    return `<div class="section-label"><span>Shop items</span><span>${state.shop.length}</span></div>` +
      state.shop.map(i => `<div class="card edit-row" data-act="edit" data-id="${i.id}">
        <div class="emoji">${esc(i.icon || '🎁')}</div>
        <div class="body"><div class="name">${esc(i.name)}</div><div class="meta"><span class="gold">${fmt(i.price)} XP</span></div></div>
        <span class="chev">${ICON_EDIT}</span>
        <button class="icon-btn small danger" data-act="delete" data-id="${i.id}" aria-label="Delete">${ICON_TRASH}</button>
      </div>`).join('') +
      `<button class="add-btn" data-act="add">+ Add shop item</button>`;
  }

  function commit() { persist(); render(); renderXP(); }

  /* ---------- Task actions ---------- */
  function award(t, p, key) {
    p.done = true; p.awarded = t.xp; state.xp += t.xp;
    state.history.unshift({ id: uid(), kind: 'task', refId: t.id, name: t.name, type: t.type, xp: t.xp, period: key, ts: Date.now() });
    if (state.history.length > 3000) state.history.length = 3000;
  }
  function unaward(t, p, key) {
    state.xp -= p.awarded || 0;
    const i = state.history.findIndex(h => h.kind === 'task' && h.refId === t.id && h.period === key);
    if (i >= 0) state.history.splice(i, 1);
    p.done = false; p.awarded = 0;
  }
  const canUnaward = p => state.xp - (p.awarded || 0) >= XP_FLOOR;

  function toggleDaily(id, card) {
    const t = findTask(id); if (!t) return;
    const key = periodKey('daily'), p = getProg(t, key), rect = rectOf(card);
    if (!p.done) {
      p.count = 1; award(t, p, key); setProg(t, p, key); commit();
      celebrate(rect, t.xp, false, id);
    } else {
      if (!canUnaward(p)) return blocked();
      const amt = p.awarded; unaward(t, p, key); p.count = 0; setProg(t, p, key); commit();
      undoFx(rect, amt);
    }
  }

  function inc(id, card) {
    const t = findTask(id); if (!t) return;
    const key = periodKey(t.type), p = getProg(t, key), tg = target(t);
    if (p.done || p.count >= tg) return;
    const rect = rectOf(card);
    p.count += 1;
    if (p.count >= tg) {
      p.count = tg; award(t, p, key); setProg(t, p, key); commit();
      celebrate(rect, t.xp, true, id);
    } else {
      setProg(t, p, key); commit();
      sfx.step(); buzz(18);
      floatText(rect.left + rect.width - 70, rect.top + rect.height / 2, '+1', 'small');
    }
  }

  function dec(id, card) {
    const t = findTask(id); if (!t) return;
    const key = periodKey(t.type), p = getProg(t, key), tg = target(t);
    if (p.count <= 0 && !p.done) return;
    const rect = rectOf(card);
    if (p.done) {
      if (!canUnaward(p)) return blocked();
      const amt = p.awarded; unaward(t, p, key); p.count = tg - 1; setProg(t, p, key); commit();
      undoFx(rect, amt);
    } else {
      p.count -= 1; setProg(t, p, key); commit();
      undoFx(rect, 0);
    }
  }

  /* ---------- Shop actions ---------- */
  function buy(id) {
    const it = state.shop.find(i => i.id === id); if (!it) return;
    if (state.xp < it.price) { sfx.error(); buzz([40, 40, 40]); toast(`You need ${fmt(it.price - state.xp)} more XP`); return; }
    confirmSheet({
      title: `${it.icon || '🎁'} ${esc(it.name)}`,
      text: `Spend <b class="gold">${fmt(it.price)} XP</b> on this? You'll have ${fmt(state.xp - it.price)} XP left.`,
      ok: 'Buy it', okClass: 'gold',
      onOk() {
        state.xp -= it.price;
        state.history.unshift({ id: uid(), kind: 'purchase', refId: it.id, name: it.name, icon: it.icon, xp: it.price, ts: Date.now(), refunded: false });
        commit();
        sfx.coin(); buzz([20, 30, 20]);
        const b = rectOf($('#xpBadge'));
        floatText(b.left + b.width / 2, b.bottom + 6, `−${fmt(it.price)} XP`, 'down');
        bumpBadge();
        setTimeout(() => toast(`Enjoy it! ${it.icon || '🎉'}`), 300);
      },
    });
  }

  function refund(hid) {
    const h = state.history.find(x => x.id === hid);
    if (!h || h.kind !== 'purchase' || h.refunded) return;
    confirmSheet({
      title: 'Undo purchase?',
      text: `${esc(h.icon || '🎁')} ${esc(h.name)} — you get <b class="gold">${fmt(h.xp)} XP</b> back.`,
      ok: 'Undo purchase', okClass: 'primary',
      onOk() {
        h.refunded = true; h.refundedAt = Date.now(); state.xp += h.xp;
        commit(); renderHistory();
        sfx.undo(); buzz(20); bumpBadge();
        toast(`+${fmt(h.xp)} XP refunded`);
      },
    });
  }

  /* ---------- Overlays (sheet + history) with Android back support ---------- */
  const overlays = [];
  function pushOverlay(name) { overlays.push(name); history.pushState({ ov: overlays.length }, ''); }
  function closeTop() { if (overlays.length) history.back(); }
  window.addEventListener('popstate', () => {
    const top = overlays.pop();
    if (top === 'sheet') closeSheetNow();
    else if (top === 'history') closeHistoryNow();
  });

  let sheetSeq = 0;
  function openSheet(html, mount) {
    const s = $('#sheet'); sheetSeq++;
    s.innerHTML = `<div class="sheet-backdrop" data-close></div><div class="sheet-panel"><div class="grabber"></div>${html}</div>`;
    s.classList.remove('hidden');
    requestAnimationFrame(() => requestAnimationFrame(() => s.classList.add('open')));
    s.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeTop));
    pushOverlay('sheet');
    if (mount) mount(s);
  }
  function closeSheetNow() {
    const s = $('#sheet'), seq = sheetSeq;
    s.classList.remove('open');
    setTimeout(() => { if (seq === sheetSeq) { s.classList.add('hidden'); s.innerHTML = ''; } }, 260);
  }
  function confirmSheet({ title, text, ok, okClass = 'primary', onOk }) {
    openSheet(`<h2>${title}</h2><p>${text}</p>
      <div class="sheet-actions"><button class="btn secondary" data-close>Cancel</button><button class="btn ${okClass}" id="cOk">${ok}</button></div>`,
      s => { $('#cOk', s).addEventListener('click', () => { closeTop(); onOk(); }); });
  }

  /* ---------- Editors ---------- */
  function openTaskEditor(id) {
    const t = id ? findTask(id) : null, type = t ? t.type : tab;
    const per = type === 'weekly' ? 'week' : 'month';
    const days = new Set(t && t.days ? t.days : EVERY_DAY);
    const html = `<h2>${t ? 'Edit task' : `New ${type} task`}</h2>
      <label class="field"><span>Name</span><input id="fName" maxlength="60" placeholder="e.g. Apply for a job" value="${t ? esc(t.name) : ''}"></label>
      <label class="field"><span>XP reward</span><input id="fXP" type="number" inputmode="numeric" min="0" max="100000" value="${t ? t.xp : 20}"></label>
      ${type === 'daily' ? `
        <div class="field"><span>Due on</span>
          <div class="chips">${WEEK_ORDER.map(d => `<button type="button" class="chip ${days.has(d) ? 'on' : ''}" data-day="${d}">${DAY_NAMES[d].slice(0, 2)}</button>`).join('')}</div>
          <div class="presets"><button type="button" data-preset="all">Every day</button><button type="button" data-preset="wk">Mon–Fri</button><button type="button" data-preset="we">Weekend</button></div>
        </div>` : `
        <div class="field"><span>Times per ${per}</span>
          <div class="num-stepper"><button type="button" data-n="-1">−</button><input id="fTarget" type="number" inputmode="numeric" min="1" max="99" value="${t ? target(t) : 1}"><button type="button" data-n="1">+</button></div>
        </div>`}
      <div class="sheet-actions"><button class="btn secondary" data-close>Cancel</button><button class="btn primary" id="fSave">Save</button></div>`;

    openSheet(html, s => {
      const setDays = list => s.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', list.includes(+c.dataset.day)));
      s.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => c.classList.toggle('on')));
      s.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () =>
        setDays({ all: EVERY_DAY, wk: [1, 2, 3, 4, 5], we: [6, 0] }[b.dataset.preset])));
      s.querySelectorAll('[data-n]').forEach(b => b.addEventListener('click', () => {
        const inp = $('#fTarget', s); inp.value = Math.min(99, Math.max(1, (parseInt(inp.value, 10) || 1) + +b.dataset.n));
      }));
      if (!t) setTimeout(() => $('#fName', s).focus(), 280);

      $('#fSave', s).addEventListener('click', () => {
        const name = $('#fName', s).value.trim();
        const xp = parseInt($('#fXP', s).value, 10);
        if (!name) return toast('Please enter a name');
        if (!Number.isFinite(xp) || xp < 0 || xp > 100000) return toast('XP must be between 0 and 100,000');
        const data = { name, xp };
        if (type === 'daily') {
          data.days = [...s.querySelectorAll('.chip.on')].map(c => +c.dataset.day);
          if (!data.days.length) return toast('Pick at least one day');
        } else {
          const tg = parseInt($('#fTarget', s).value, 10);
          if (!Number.isFinite(tg) || tg < 1 || tg > 99) return toast('Times must be between 1 and 99');
          data.target = tg;
        }
        if (t) {
          Object.assign(t, data);
          if (type !== 'daily') {           // keep current progress consistent with a new target
            const key = periodKey(type), p = getProg(t, key);
            if (p.done) p.count = data.target;
            else if (p.count >= data.target) p.count = data.target - 1;
            setProg(t, p, key);
          }
        } else {
          state.tasks.push({ id: uid(), type, created: dayKey(), ...data });
        }
        closeTop(); commit();
        toast(t ? 'Task saved' : 'Task added');
      });
    });
  }

  function openShopEditor(id) {
    const it = id ? state.shop.find(i => i.id === id) : null;
    let icon = it ? it.icon : '🎁';
    const html = `<h2>${it ? 'Edit shop item' : 'New shop item'}</h2>
      <div class="field"><span>Icon</span><div class="emoji-grid">${EMOJIS.map(e => `<button type="button" data-emoji="${e}" class="${e === icon ? 'on' : ''}">${e}</button>`).join('')}</div></div>
      <label class="field"><span>Or type your own emoji</span><input id="fIcon" maxlength="8" value="${esc(icon)}"></label>
      <label class="field"><span>Name</span><input id="fName" maxlength="60" placeholder="e.g. Cinema" value="${it ? esc(it.name) : ''}"></label>
      <label class="field"><span>Price (XP)</span><input id="fPrice" type="number" inputmode="numeric" min="1" max="100000" value="${it ? it.price : 100}"></label>
      <div class="sheet-actions"><button class="btn secondary" data-close>Cancel</button><button class="btn primary" id="fSave">Save</button></div>`;
    openSheet(html, s => {
      const iconInput = $('#fIcon', s);
      s.querySelectorAll('[data-emoji]').forEach(b => b.addEventListener('click', () => {
        s.querySelectorAll('[data-emoji]').forEach(x => x.classList.remove('on'));
        b.classList.add('on'); iconInput.value = b.dataset.emoji;
      }));
      iconInput.addEventListener('input', () => s.querySelectorAll('[data-emoji]').forEach(x => x.classList.toggle('on', x.dataset.emoji === iconInput.value)));
      $('#fSave', s).addEventListener('click', () => {
        const name = $('#fName', s).value.trim();
        const price = parseInt($('#fPrice', s).value, 10);
        icon = iconInput.value.trim() || '🎁';
        if (!name) return toast('Please enter a name');
        if (!Number.isFinite(price) || price < 1 || price > 100000) return toast('Price must be between 1 and 100,000');
        if (it) Object.assign(it, { name, price, icon });
        else state.shop.push({ id: uid(), name, price, icon });
        closeTop(); commit();
        toast(it ? 'Item saved' : 'Item added');
      });
    });
  }

  function confirmDelete(id) {
    const isShop = tab === 'shop';
    const item = isShop ? state.shop.find(i => i.id === id) : findTask(id);
    if (!item) return;
    confirmSheet({
      title: `Delete “${esc(item.name)}”?`,
      text: 'Your XP and history stay as they are.',
      ok: 'Delete', okClass: 'danger',
      onOk() {
        if (isShop) state.shop = state.shop.filter(i => i.id !== id);
        else { state.tasks = state.tasks.filter(t => t.id !== id); delete state.progress[id]; }
        commit(); toast('Deleted');
      },
    });
  }

  /* ---------- History ---------- */
  function dayLabel(ts) {
    const k = dayKey(new Date(ts)), today = dayKey(), y = new Date(); y.setDate(y.getDate() - 1);
    if (k === today) return 'Today';
    if (k === dayKey(y)) return 'Yesterday';
    return new Date(ts).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
  }
  const timeOf = ts => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const TYPE_LABEL = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

  function renderHistory() {
    const h = $('#history');
    const kind = histTab === 'tasks' ? 'task' : 'purchase';
    const list = state.history.filter(x => x.kind === kind).slice(0, 500);
    let body = '', last = '';
    for (const e of list) {
      const lbl = dayLabel(e.ts);
      if (lbl !== last) { body += `<div class="hist-day">${lbl}</div>`; last = lbl; }
      if (kind === 'task') {
        body += `<div class="hist-row"><div class="hico ok">${ICON_CHECK}</div>
          <div class="body"><div class="name">${esc(e.name)}</div><div class="sub">${TYPE_LABEL[e.type] || ''} · ${timeOf(e.ts)}</div></div>
          <div class="amt plus">+${fmt(e.xp)} XP</div></div>`;
      } else {
        body += `<div class="hist-row ${e.refunded ? 'refunded' : ''}"><div class="hico">${esc(e.icon || '🎁')}</div>
          <div class="body"><div class="name">${esc(e.name)}</div><div class="sub">${timeOf(e.ts)}${e.refunded ? '<span class="tag">Refunded</span>' : ''}</div></div>
          <div class="amt minus">−${fmt(e.xp)} XP</div>
          ${e.refunded ? '' : `<button class="undo-btn" data-hact="refund" data-id="${e.id}">Undo</button>`}</div>`;
      }
    }
    if (!list.length) body = `<div class="empty"><div class="big">${kind === 'task' ? '📋' : '🧾'}</div>${kind === 'task' ? 'No completed tasks yet.' : 'No purchases yet.'}</div>`;
    h.innerHTML = `<header class="hist-top"><button class="icon-btn" data-hact="close" aria-label="Back">${ICON_BACK}</button><h2>History</h2></header>
      <div class="seg"><button class="${histTab === 'tasks' ? 'on' : ''}" data-hact="tab" data-v="tasks">Done tasks</button><button class="${histTab === 'purchases' ? 'on' : ''}" data-hact="tab" data-v="purchases">Purchases</button></div>
      ${body}`;
  }
  function openHistory() {
    histTab = 'tasks'; renderHistory();
    const h = $('#history'); h.scrollTop = 0; h.classList.add('open'); h.setAttribute('aria-hidden', 'false');
    pushOverlay('history');
  }
  function closeHistoryNow() { const h = $('#history'); h.classList.remove('open'); h.setAttribute('aria-hidden', 'true'); }

  $('#history').addEventListener('click', e => {
    const el = e.target.closest('[data-hact]'); if (!el) return;
    const a = el.dataset.hact;
    if (a === 'close') closeTop();
    else if (a === 'tab') { histTab = el.dataset.v; renderHistory(); }
    else if (a === 'refund') refund(el.dataset.id);
  });

  /* ---------- Backup ---------- */
  function exportData() {
    const data = JSON.stringify({ app: 'DopaminApp', exportedAt: new Date().toISOString(), ...state }, null, 2);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    a.download = `dopaminapp-backup-${dayKey()}.json`;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    toast('Backup saved to your downloads');
  }
  $('#importFile').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      let s;
      try { s = JSON.parse(r.result); } catch (err) { return toast('That file is not a valid backup'); }
      if (!isValid(s)) return toast('That file is not a valid backup');
      confirmSheet({
        title: 'Import backup?',
        text: `This replaces everything in the app with the backup (${s.tasks.length} tasks, ${s.shop.length} shop items, ${fmt(s.xp)} XP).`,
        ok: 'Import', okClass: 'primary',
        onOk() {
          state = { version: 1, xp: s.xp, tasks: s.tasks, shop: s.shop, progress: s.progress, history: s.history };
          persist(); render(); renderXP(false); toast('Backup imported');
        },
      });
    };
    r.readAsText(f);
  });

  /* ---------- Events ---------- */
  view.addEventListener('click', e => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    const act = el.dataset.act, id = el.dataset.id, card = el.closest('.card');
    switch (act) {
      case 'toggle': toggleDaily(id, card); break;
      case 'inc': inc(id, card); break;
      case 'dec': dec(id, card); break;
      case 'buy': buy(id); break;
      case 'edit': tab === 'shop' ? openShopEditor(id) : openTaskEditor(id); break;
      case 'delete': confirmDelete(id); break;
      case 'add': tab === 'shop' ? openShopEditor(null) : openTaskEditor(null); break;
      case 'export': exportData(); break;
      case 'import': $('#importFile').click(); break;
    }
  });
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => {
    if (tab === b.dataset.tab) return;
    tab = b.dataset.tab; render(); window.scrollTo(0, 0);
  }));
  $('#btnEdit').addEventListener('click', () => { editMode = !editMode; render(); window.scrollTo(0, 0); });
  $('#btnHistory').addEventListener('click', openHistory);

  // Periods roll over at midnight / Monday / 1st — re-render when the day changes or the app comes back.
  let lastDay = dayKey(), lastMinute = new Date().getMinutes();
  setInterval(() => {
    const d = dayKey(), m = new Date().getMinutes();
    if (d !== lastDay) { lastDay = d; render(); }
    else if (m !== lastMinute && !overlays.length && !editMode) { $('#subtitle').textContent = subtitle(); }
    lastMinute = m;
  }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { lastDay = dayKey(); render(); } });

  render(); renderXP(false);

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
