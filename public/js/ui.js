// Small display helpers shared by the goal pages. Everything is set with
// textContent or createElement, never innerHTML, so user text can't run as code.
const LABELS = {
    Draft: 'Draft', Active: 'Active', AtRisk: 'At risk', Achieved: 'Achieved', Abandoned: 'Abandoned',
    OnTrack: 'On track', Overdue: 'Overdue', Done: 'Done', NotStarted: 'Not started'
};

function el(tag, { className, text, attrs } = {}, children = []) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, v));
    children.forEach((c) => c && node.append(c));
    return node;
}

// Health only means something while a goal is in play (Active or At risk)
function showsHealth(goal) { return goal.status === 'Active' || goal.status === 'AtRisk'; }

function badge(value) {
    return el('span', { className: `badge ${value}`, text: LABELS[value] || value });
}

// Progress bar with a thin mark where the goal should be by now (rule G6)
function progressBar(progress, expected) {
    const bar = el('div', { className: 'progress', attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(progress) } });
    const fill = el('div', { className: 'bar' });
    fill.style.width = `${Math.min(100, Math.max(0, progress))}%`;
    bar.append(fill);
    if (expected > 0 && expected < 100) {
        const mark = el('div', { className: 'expected', attrs: { title: `Expected by now: ${expected}%` } });
        mark.style.left = `${expected}%`;
        bar.append(mark);
    }
    return bar;
}

function formatDate(iso) {
    const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function fillYears(select, chosen) {
    const now = new Date().getFullYear();
    [now, now + 1].forEach((y) => select.append(el('option', { text: String(y), attrs: { value: String(y) } })));
    select.value = String(chosen || now);
}

// The API's message, plus each validation detail on its own line
function errorText(error) {
    return error.details && error.details.length > 1 ? error.details.join(' ') : error.message;
}

document.addEventListener('DOMContentLoaded', () => {
    const logout = document.querySelector('#logout');
    if (!logout) return;
    logout.addEventListener('click', async () => {
        try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* the session is cleared anyway */ }
        Session.clear();
        window.location.replace('login.html');
    });
});
