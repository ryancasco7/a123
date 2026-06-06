/* MathBOT - Application Logic (Supabase) */
(function () {
  'use strict';

  const DB = window.MathBOTDB;
  const CONFIG = {
    CORRECT_REWARD: 0.02,
    MIN_WITHDRAWAL: 100,
    ANTI_SPAM_MS: 1000,
    THEME_KEY: 'mathbot_theme',
    ACTIVATION_VALUE: 159
  };

  let lastSubmitTime = 0;
  let currentQuestion = null;
  let questionSeenCache = new Set();

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

  function formatPHP(amount) {
    return '₱' + Number(amount).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function showToast(message, type = 'info') {
    let container = $('#toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3200);
  }

  function showLoader(show = true) {
    let loader = $('#app-loader');
    if (!loader) {
      loader = document.createElement('div');
      loader.id = 'app-loader';
      loader.innerHTML = '<div class="loader-spinner"></div><p>Loading MathBOT...</p>';
      document.body.appendChild(loader);
    }
    loader.classList.toggle('hidden', !show);
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function downloadCSV(filename, rows) {
    if (!rows.length) return showToast('No data to export', 'warning');
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('Report exported', 'success');
  }

  function initTheme() {
    const saved = localStorage.getItem(CONFIG.THEME_KEY) || 'light';
    document.documentElement.setAttribute('data-theme', saved);
    $$('[data-theme-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem(CONFIG.THEME_KEY, next);
      });
    });
  }

  function validatePhone(phone) { return /^09\d{9}$/.test(phone.replace(/\s/g, '')); }
  function validateUsername(username) { return /^[a-zA-Z0-9_]{3,20}$/.test(username); }

  function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const seg = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    return `MB-${seg()}-${seg()}-${seg()}`;
  }

  const OPS = ['+', '-', '×', '÷'];

  function randDigits(minD, maxD) {
    const len = minD + Math.floor(Math.random() * (maxD - minD + 1));
    let n = Math.floor(Math.random() * 9) + 1;
    for (let i = 1; i < len; i++) n = n * 10 + Math.floor(Math.random() * 10);
    return n;
  }

  async function generateQuestion(userId) {
    if (!questionSeenCache.size) {
      const keys = await DB.getUserQuestionKeys(userId);
      questionSeenCache = new Set(keys);
    }
    let attempts = 0;
    while (attempts < 200) {
      attempts++;
      const opIdx = Math.floor(Math.random() * OPS.length);
      const op = OPS[opIdx];
      let a, b, answer;

      if (op === '÷') {
        b = randDigits(2, 3);
        answer = randDigits(2, 4);
        a = b * answer;
        if (String(a).length < 4 || String(a).length > 6) continue;
      } else if (op === '×') {
        a = randDigits(4, 6);
        b = randDigits(2, 3);
        answer = a * b;
      } else if (op === '-') {
        a = randDigits(4, 6);
        b = randDigits(4, 6);
        if (b > a) [a, b] = [b, a];
        answer = a - b;
      } else {
        a = randDigits(4, 6);
        b = randDigits(4, 6);
        answer = a + b;
      }

      const key = `${a}${op}${b}`;
      if (questionSeenCache.has(key)) continue;
      questionSeenCache.add(key);
      await DB.saveQuestionKey(userId, key);
      return { a, b, op, answer, key, display: `${a.toLocaleString()} ${op} ${b.toLocaleString()} = ?` };
    }
    return { a: 1234, b: 5678, op: '+', answer: 6912, key: 'fallback', display: '1234 + 5678 = ?' };
  }

  /* ========== AUTH ========== */
  async function handleRegister(e) {
    e.preventDefault();
    const form = e.target;
    const name = form.name.value.trim();
    const username = form.username.value.trim().toLowerCase();
    const phone = form.phone.value.trim().replace(/\s/g, '');
    const activationCode = form.activationCode.value.trim().toUpperCase();
    const referralUsername = form.referralUsername.value.trim().toLowerCase();
    const password = form.password?.value;

    if (!name || name.length < 2) return showToast('Enter your complete name', 'error');
    if (!validateUsername(username)) return showToast('Username: 3-20 chars, letters/numbers/_', 'error');
    if (!validatePhone(phone)) return showToast('Phone must be 11 digits starting with 09', 'error');
    if (!activationCode) return showToast('Activation code is required', 'error');
    if (!password || password.length < 6) return showToast('Password must be at least 6 characters', 'error');

    try {
      showLoader(true);
      await DB.register({ name, username, phone, password, activationCode, referralUsername });
      showToast('Registration successful! Login with your username.', 'success');
      setTimeout(() => window.location.href = 'login.html', 1500);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      showLoader(false);
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    const username = e.target.username.value.trim().toLowerCase();
    const password = e.target.password.value;
    try {
      showLoader(true);
      const user = await DB.login(username, password);
      showToast(`Welcome back, ${user.name}!`, 'success');
      setTimeout(() => {
        window.location.href = user.role === 'admin' ? 'admin.html' : 'dashboard.html';
      }, 600);
    } catch (err) {
      showToast(err.message === 'Invalid login credentials' ? 'Invalid credentials' : err.message, 'error');
    } finally {
      showLoader(false);
    }
  }

  async function handleLogout() {
    await DB.logout();
    showToast('Logged out securely', 'info');
    setTimeout(() => window.location.href = 'index.html', 400);
  }

  async function guardPage(role = null) {
    const auth = await DB.requireAuth(role);
    if (!auth) { window.location.href = 'login.html'; return null; }
    if (auth.forbidden) {
      window.location.href = auth.profile.role === 'admin' ? 'admin.html' : 'dashboard.html';
      return null;
    }
    return auth;
  }

  /* ========== DASHBOARD ========== */
  async function renderDashboard() {
    const auth = await guardPage('user');
    if (!auth) return;
    const { user } = auth;
    const accuracy = user.stats.totalAnswered
      ? ((user.stats.correct / user.stats.totalAnswered) * 100).toFixed(1) : '0.0';

    const set = (id, val) => { const el = $(id); if (el) el.textContent = val; };
    set('#user-greeting', `Hello, ${user.name}`);
    set('#total-earnings', formatPHP(user.earnings + user.referralEarnings));
    set('#referral-count', String(user.referralCount));
    set('#referral-earnings', formatPHP(user.referralEarnings));
    set('#total-withdrawn', formatPHP(user.totalWithdrawn));
    set('#stat-answered', String(user.stats.totalAnswered));
    set('#stat-correct', String(user.stats.correct));
    set('#stat-wrong', String(user.stats.wrong));
    set('#stat-accuracy', accuracy + '%');
    set('#referral-username', user.username);

    await renderActivityFeed('#activity-feed', 8);
    const daily = await DB.getDailyLeaderboard();
    const top = await DB.getTopEarners();
    renderLeaderboard('#daily-leaderboard', daily);
    renderLeaderboard('#top-earners', top.map(e => [e.username, e.total]));
    await renderNotifications(user.id);

    DB.subscribe(['profiles', 'earnings', 'notifications'], () => {
      DB.refreshProfile().then(u => {
        if (!u) return;
        set('#total-earnings', formatPHP(u.earnings + u.referralEarnings));
        set('#referral-count', String(u.referralCount));
        renderNotifications(u.id);
        renderActivityFeed('#activity-feed', 8);
      });
    });
  }

  async function renderNotifications(userId) {
    const list = $('#notification-list');
    const badge = $('#notify-badge');
    if (!list) return;
    const notes = await DB.getNotifications(userId);
    const unread = notes.filter(n => !n.read).length;
    if (badge) { badge.textContent = unread; badge.classList.toggle('hidden', unread === 0); }
    if (!notes.length) {
      list.innerHTML = '<div class="empty-state"><div class="empty-icon">🔔</div><p>No notifications yet</p></div>';
      return;
    }
    list.innerHTML = notes.slice(0, 10).map(n => `
      <div class="notification-item ${n.read ? '' : 'unread'}">
        <span class="notify-dot"></span>
        <div><p>${escapeHtml(n.message)}</p><small>${formatDate(n.date)}</small></div>
      </div>`).join('');
    await DB.markNotificationsRead();
  }

  async function renderActivityFeed(selector, limit) {
    const el = $(selector);
    if (!el) return;
    const earnings = await DB.getRecentEarnings(limit);
    if (!earnings.length) {
      el.innerHTML = '<div class="empty-state"><div class="empty-icon">📊</div><p>No recent activity</p></div>';
      return;
    }
    el.innerHTML = earnings.map(e => `
      <div class="activity-item fade-in">
        <span class="activity-dot activity-${e.type}"></span>
        <div><p>${escapeHtml(e.username)} earned ${formatPHP(e.amount)} — ${escapeHtml(e.description)}</p>
        <small>${formatDate(e.created_at)}</small></div>
      </div>`).join('');
  }

  function renderLeaderboard(selector, data) {
    const el = $(selector);
    if (!el) return;
    if (!data.length) {
      el.innerHTML = '<div class="empty-state small"><p>No data yet</p></div>';
      return;
    }
    el.innerHTML = data.map((item, i) => {
      const name = item[0] || item.username;
      const val = formatPHP(item[1] !== undefined ? item[1] : item.total);
      return `<div class="leaderboard-row rank-${i + 1}"><span class="rank">#${i + 1}</span><span class="name">${escapeHtml(name)}</span><span class="score">${val}</span></div>`;
    }).join('');
  }

  /* ========== GAME ========== */
  async function initGame() {
    const auth = await guardPage('user');
    if (!auth) return;
    const { user } = auth;
    await loadNextQuestion(user);
    updateGameBalance(user);

    $('#game-form')?.addEventListener('submit', e => { e.preventDefault(); submitAnswer(user); });
    $('#skip-btn')?.addEventListener('click', async () => {
      showToast('Question skipped', 'warning');
      const u = await DB.refreshProfile();
      await loadNextQuestion(u || user);
    });

    DB.subscribe(['profiles', 'earnings'], async () => {
      const u = await DB.refreshProfile();
      if (u) updateGameBalance(u);
    });
  }

  async function loadNextQuestion(user) {
    currentQuestion = await generateQuestion(user.id);
    const qEl = $('#current-question');
    const input = $('#answer-input');
    if (qEl) qEl.textContent = currentQuestion.display;
    if (input) { input.value = ''; input.focus(); }
    const feedback = $('#game-feedback');
    if (feedback) { feedback.textContent = ''; feedback.className = 'game-feedback'; }
  }

  function updateGameBalance(user) {
    const el = $('#game-balance');
    if (el) el.textContent = formatPHP(user.earnings + user.referralEarnings);
  }

  async function submitAnswer(user) {
    const now = Date.now();
    if (now - lastSubmitTime < CONFIG.ANTI_SPAM_MS) return showToast('Please wait before submitting again', 'warning');
    lastSubmitTime = now;

    const input = $('#answer-input');
    const feedback = $('#game-feedback');
    if (!input || !currentQuestion) return;

    const userAnswer = parseFloat(input.value.trim().replace(/,/g, ''));
    if (isNaN(userAnswer)) return showToast('Enter a valid number', 'error');

    try {
      const result = await DB.submitAnswer(currentQuestion.key, userAnswer, currentQuestion.answer);
      const freshUser = DB.getProfile();

      if (result.correct) {
        if (feedback) { feedback.textContent = `Correct! +${formatPHP(CONFIG.CORRECT_REWARD)}`; feedback.className = 'game-feedback success'; }
        showToast(`+${formatPHP(CONFIG.CORRECT_REWARD)}`, 'success');
      } else {
        if (feedback) { feedback.textContent = `Wrong. Answer was ${currentQuestion.answer.toLocaleString()}`; feedback.className = 'game-feedback error'; }
      }
      updateGameBalance(freshUser);
      setTimeout(() => loadNextQuestion(freshUser), result.correct ? 600 : 1200);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  /* ========== WITHDRAWAL ========== */
  async function initWithdrawal() {
    const auth = await guardPage('user');
    if (!auth) return;
    await renderWithdrawalPage(auth.user);

    $('#withdrawal-form')?.addEventListener('submit', e => handleWithdrawal(e, auth.user));

    DB.subscribe(['withdrawals', 'profiles'], () => renderWithdrawalPage(auth.user));
  }

  async function renderWithdrawalPage(user) {
    const fresh = await DB.refreshProfile() || user;
    const pending = await DB.getPendingAmount(fresh.id);
    const available = fresh.earnings + fresh.referralEarnings - fresh.totalWithdrawn - pending;
    const balEl = $('#available-balance');
    if (balEl) balEl.textContent = formatPHP(Math.max(0, available));
    await renderWithdrawalHistory(fresh.id);
  }

  async function handleWithdrawal(e, user) {
    e.preventDefault();
    const form = e.target;
    const amount = parseFloat(form.amount.value);
    const gcashNumber = form.gcashNumber.value.trim();
    const gcashName = form.gcashName.value.trim();

    if (!gcashName || gcashName.length < 2) return showToast('Enter GCash name', 'error');
    if (!/^09\d{9}$/.test(gcashNumber)) return showToast('Invalid GCash number', 'error');
    if (isNaN(amount) || amount < CONFIG.MIN_WITHDRAWAL) return showToast(`Minimum withdrawal is ${formatPHP(CONFIG.MIN_WITHDRAWAL)}`, 'error');

    try {
      await DB.requestWithdrawal(amount, gcashName, gcashNumber);
      showToast('Withdrawal request submitted', 'success');
      form.reset();
      await renderWithdrawalPage(await DB.refreshProfile());
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function renderWithdrawalHistory(userId) {
    const el = $('#withdrawal-history');
    if (!el) return;
    const items = await DB.getUserWithdrawals(userId);
    if (!items.length) {
      el.innerHTML = '<div class="empty-state"><div class="empty-icon">💸</div><p>No withdrawals yet</p></div>';
      return;
    }
    el.innerHTML = `<div class="table-wrap"><table class="data-table"><thead><tr>
      <th>Amount</th><th>GCash</th><th>Date</th><th>Status</th></tr></thead><tbody>
      ${items.map(w => `<tr><td>${formatPHP(w.amount)}</td><td>${escapeHtml(w.gcash_name)}<br><small>${escapeHtml(w.gcash_number)}</small></td>
      <td>${formatDate(w.requested_at)}</td><td><span class="badge badge-${w.status}">${w.status}</span></td></tr>`).join('')}
      </tbody></table></div>`;
  }

  /* ========== ADMIN ========== */
  let adminCodeFilter = 'all';

  async function initAdmin() {
    const auth = await guardPage('admin');
    if (!auth) return;
    await refreshAdminUI();
    bindAdminTabs();
    bindAdminActions();

    DB.subscribe(['profiles', 'withdrawals', 'earnings', 'activation_codes', 'notifications'], () => {
      refreshAdminUI();
    });
  }

  async function refreshAdminUI() {
    await renderAdminStats();
    await renderAdminCharts();
    await renderAdminCodes(adminCodeFilter);
    await renderAdminUsers($('#user-search')?.value || '');
    await renderAdminWithdrawals();
    await renderActivityFeed('#admin-activity', 12);
  }

  async function renderAdminStats() {
    const s = await DB.getAdminStats();
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('#stat-total-users', s.totalUsers);
    set('#stat-activated', s.activated);
    set('#stat-earnings-paid', formatPHP(s.totalPaid));
    set('#stat-ref-rewards', formatPHP(s.refRewards));
    set('#stat-pending-wd', s.pendingWd);
    set('#stat-approved-wd', s.approvedWd);
    set('#stat-rejected-wd', s.rejectedWd);
    set('#stat-codes', s.totalCodes);
    set('#stat-daily-users', s.dailyUsers);
    set('#stat-daily-earnings', formatPHP(s.dailyEarnings));
  }

  async function renderAdminCharts() {
    drawBarChart('#chart-users', await DB.getLast7DaysUsers(), 'New Users');
    drawBarChart('#chart-earnings', await DB.getLast7DaysEarnings(), 'Earnings (₱)');
  }

  function drawBarChart(selector, data, title) {
    const canvas = $(selector);
    if (!canvas || !data.length) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width = canvas.offsetWidth * 2;
    const h = canvas.height = 280;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(2, 1);
    const cw = w / 2;
    const max = Math.max(...data.map(d => d.value), 1);
    const barW = (cw - 60) / data.length - 8;
    const colors = getComputedStyle(document.documentElement);
    const primary = colors.getPropertyValue('--primary').trim() || '#2563eb';
    const muted = colors.getPropertyValue('--text-muted').trim() || '#94a3b8';
    ctx.clearRect(0, 0, cw, h);
    ctx.fillStyle = muted;
    ctx.font = '12px Inter, sans-serif';
    ctx.fillText(title, 10, 16);
    data.forEach((d, i) => {
      const barH = (d.value / max) * (h - 60);
      const x = 30 + i * (barW + 8);
      const y = h - 30 - barH;
      ctx.fillStyle = primary;
      ctx.beginPath();
      ctx.roundRect(x, y, barW, barH, 4);
      ctx.fill();
      ctx.fillStyle = muted;
      ctx.textAlign = 'center';
      ctx.fillText(d.label, x + barW / 2, h - 10);
      if (d.value > 0) ctx.fillText(d.value < 1 ? d.value.toFixed(2) : String(Math.round(d.value)), x + barW / 2, y - 6);
    });
  }

  function bindAdminTabs() {
    $$('.admin-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        $$('.admin-tab').forEach(t => t.classList.remove('active'));
        $$('.admin-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        $(`#panel-${tab.dataset.panel}`)?.classList.add('active');
      });
    });
  }

  async function renderAdminCodes(filter = 'all') {
    const el = $('#codes-table-body');
    if (!el) return;
    const codes = await DB.getActivationCodes(filter);
    if (!codes.length) {
      el.innerHTML = '<tr><td colspan="5"><div class="empty-state small"><p>No codes found</p></div></td></tr>';
      return;
    }
    el.innerHTML = codes.map(c => `<tr>
      <td><code>${escapeHtml(c.code_id)}</code></td>
      <td>${formatDate(c.generated_at)}</td>
      <td><span class="badge badge-${c.status}">${c.status}</span></td>
      <td>${c.user_assigned ? escapeHtml(c.user_assigned) : '—'}</td>
      <td class="actions">
        ${c.status === 'unused' ? `<button class="btn btn-sm btn-danger" data-disable-code="${escapeHtml(c.code_id)}">Disable</button>` : ''}
        <button class="btn btn-sm btn-outline" data-delete-code="${escapeHtml(c.code_id)}">Delete</button>
      </td></tr>`).join('');
  }

  async function renderAdminUsers(search = '') {
    const el = $('#users-table-body');
    if (!el) return;
    const users = await DB.getAllUsers(search);
    if (!users.length) {
      el.innerHTML = '<tr><td colspan="8"><div class="empty-state small"><p>No users found</p></div></td></tr>';
      return;
    }
    el.innerHTML = users.map(u => `<tr>
      <td>${escapeHtml(u.name)}</td>
      <td>${escapeHtml(u.username)}</td>
      <td>${escapeHtml(u.phone)}</td>
      <td>${formatPHP(u.earnings + u.referralEarnings)}</td>
      <td>${u.referralCount}</td>
      <td>${formatDate(u.registrationDate)}</td>
      <td><span class="badge badge-${u.status}">${u.status}</span></td>
      <td class="actions">
        <button class="btn btn-sm btn-outline" data-edit-user="${u.id}">Edit</button>
        <button class="btn btn-sm ${u.status === 'banned' ? 'btn-success' : 'btn-warning'}" data-ban-user="${u.id}">${u.status === 'banned' ? 'Unban' : 'Ban'}</button>
        <button class="btn btn-sm btn-danger" data-delete-user="${u.id}">Delete</button>
      </td></tr>`).join('');
  }

  async function renderAdminWithdrawals() {
    const el = $('#admin-withdrawals-body');
    if (!el) return;
    const wds = await DB.getAllWithdrawals();
    if (!wds.length) {
      el.innerHTML = '<tr><td colspan="7"><div class="empty-state small"><p>No withdrawal requests</p></div></td></tr>';
      return;
    }
    el.innerHTML = wds.map(w => `<tr>
      <td>${escapeHtml(w.username)}</td>
      <td>${formatPHP(w.amount)}</td>
      <td>${escapeHtml(w.gcash_name)}</td>
      <td>${escapeHtml(w.gcash_number)}</td>
      <td>${formatDate(w.requested_at)}</td>
      <td><span class="badge badge-${w.status}">${w.status}</span></td>
      <td class="actions">
        ${w.status === 'pending' ? `
          <button class="btn btn-sm btn-success" data-approve-wd="${w.id}">Approve</button>
          <button class="btn btn-sm btn-danger" data-reject-wd="${w.id}">Reject</button>` : '—'}
      </td></tr>`).join('');
  }

  function bindAdminActions() {
    $('#generate-code-btn')?.addEventListener('click', async () => {
      try {
        await DB.adminGenerateCodes(1);
        showToast('Code generated', 'success');
        await refreshAdminUI();
      } catch (err) { showToast(err.message, 'error'); }
    });

    $('#generate-multi-btn')?.addEventListener('click', async () => {
      const count = parseInt($('#code-count')?.value || '5', 10);
      try {
        await DB.adminGenerateCodes(count);
        showToast(`${Math.min(count, 50)} codes generated`, 'success');
        await refreshAdminUI();
      } catch (err) { showToast(err.message, 'error'); }
    });

    $$('[data-code-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('[data-code-filter]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        adminCodeFilter = btn.dataset.codeFilter;
        renderAdminCodes(adminCodeFilter);
      });
    });

    $('#user-search')?.addEventListener('input', e => renderAdminUsers(e.target.value));

    document.body.addEventListener('click', async e => {
      const disable = e.target.closest('[data-disable-code]');
      if (disable) {
        try { await DB.adminDisableCode(disable.dataset.disableCode); showToast('Code disabled', 'info'); await renderAdminCodes(adminCodeFilter); }
        catch (err) { showToast(err.message, 'error'); }
      }
      const del = e.target.closest('[data-delete-code]');
      if (del) {
        if (!confirm('Delete this code?')) return;
        try { await DB.adminDeleteCode(del.dataset.deleteCode); await refreshAdminUI(); }
        catch (err) { showToast(err.message, 'error'); }
      }
      const ban = e.target.closest('[data-ban-user]');
      if (ban) {
        try { await DB.adminToggleBan(ban.dataset.banUser); await renderAdminUsers($('#user-search')?.value); }
        catch (err) { showToast(err.message, 'error'); }
      }
      const delUser = e.target.closest('[data-delete-user]');
      if (delUser) {
        if (!confirm('Delete this user permanently?')) return;
        try { await DB.adminDeleteUser(delUser.dataset.deleteUser); await refreshAdminUI(); }
        catch (err) { showToast(err.message, 'error'); }
      }
      const edit = e.target.closest('[data-edit-user]');
      if (edit) openEditUserModal(edit.dataset.editUser);
      const appr = e.target.closest('[data-approve-wd]');
      if (appr) {
        try { await DB.adminProcessWithdrawal(appr.dataset.approveWd, 'approved'); showToast('Withdrawal approved', 'success'); await refreshAdminUI(); }
        catch (err) { showToast(err.message, 'error'); }
      }
      const rej = e.target.closest('[data-reject-wd]');
      if (rej) {
        try { await DB.adminProcessWithdrawal(rej.dataset.rejectWd, 'rejected'); showToast('Withdrawal rejected', 'info'); await refreshAdminUI(); }
        catch (err) { showToast(err.message, 'error'); }
      }
    });

    $('#export-users-btn')?.addEventListener('click', async () => {
      const users = await DB.getAllUsers();
      downloadCSV('mathbot-users.csv', [['Name', 'Username', 'Phone', 'Earnings', 'Referrals', 'Date', 'Status'],
        ...users.map(u => [u.name, u.username, u.phone, u.earnings + u.referralEarnings, u.referralCount, u.registrationDate, u.status])]);
    });

    $('#export-withdrawals-btn')?.addEventListener('click', async () => {
      const wds = await DB.getAllWithdrawals();
      downloadCSV('mathbot-withdrawals.csv', [['User', 'Amount', 'GCash Name', 'GCash Number', 'Date', 'Status'],
        ...wds.map(w => [w.username, w.amount, w.gcash_name, w.gcash_number, w.requested_at, w.status])]);
    });
  }

  async function openEditUserModal(userId) {
    const users = await DB.getAllUsers();
    const user = users.find(u => u.id === userId);
    if (!user) return;
    $('#edit-user-id').value = user.id;
    $('#edit-name').value = user.name;
    $('#edit-phone').value = user.phone;
    $('#edit-earnings').value = user.earnings;
    $('#edit-user-modal')?.classList.add('open');
  }

  async function saveEditUser() {
    const id = $('#edit-user-id')?.value;
    try {
      await DB.adminUpdateUser(id, $('#edit-name').value.trim(), $('#edit-phone').value.trim(), parseFloat($('#edit-earnings').value) || 0);
      $('#edit-user-modal')?.classList.remove('open');
      await renderAdminUsers($('#user-search')?.value);
      showToast('User updated', 'success');
    } catch (err) { showToast(err.message, 'error'); }
  }

  function bindLogout() {
    $$('[data-logout]').forEach(btn => btn.addEventListener('click', handleLogout));
  }

  function bindEditModal() {
    $('#save-edit-user')?.addEventListener('click', saveEditUser);
    $$('[data-close-modal]').forEach(btn => btn.addEventListener('click', () => btn.closest('.modal')?.classList.remove('open')));
  }

  function initMobileNav() {
    const page = document.body.dataset.page;
    $$('.bottom-nav a').forEach(a => { if (a.dataset.nav === page) a.classList.add('active'); });
  }

  async function init() {
    showLoader(true);
    initTheme();
    try {
      await DB.init();
    } catch (err) {
      showLoader(false);
      showToast(err.message, 'error');
      return;
    }
    showLoader(false);

    const page = document.body.dataset.page;
    bindLogout();
    bindEditModal();
    initMobileNav();

    const session = await DB.getSession();
    const profile = DB.getProfile();

    switch (page) {
      case 'index':
        if (session && profile) window.location.href = profile.role === 'admin' ? 'admin.html' : 'dashboard.html';
        break;
      case 'login':
        if (session && profile) window.location.href = profile.role === 'admin' ? 'admin.html' : 'dashboard.html';
        else $('#login-form')?.addEventListener('submit', handleLogin);
        break;
      case 'register':
        $('#register-form')?.addEventListener('submit', handleRegister);
        break;
      case 'dashboard': await renderDashboard(); break;
      case 'game': await initGame(); break;
      case 'withdrawal': await initWithdrawal(); break;
      case 'admin': await initAdmin(); break;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
