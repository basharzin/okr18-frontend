// ---------------------------------------------------------------
// Check-ins panel inside goal.html (owner: Amr Hosni, Check-ins Service).
// Log a new value for one of the goal's key results, and see its history.
// The form only helps the user: the Check-ins API checks everything again
// (C1: key result is mine and its goal is Active or At risk, C2: the value fits).
// Everything is shown with textContent (el() in ui.js), never innerHTML,
// so a note like <script>...</script> stays plain text (test ST7).
// ---------------------------------------------------------------
(function checkInsPanel() {
    if (!Session.token()) return;                        // goal.js already sends the visitor to login
    const goalId = new URLSearchParams(window.location.search).get('id') || '';
    if (!/^G-[0-9a-f-]{36}$/.test(goalId)) return;

    const panel = document.querySelector('#check-ins-panel');
    const OPEN = ['Active', 'AtRisk'];                   // C1: check-ins only while the goal is in play
    let data = null;                                     // last answer of GET /api/goals/{id}/key-results
    let chosen = '';                                     // krId shown in the form and the history

    const say = (node, text, kind = 'error') => { node.textContent = text; node.className = `message ${kind}`; };
    const number = (n) => (Number.isInteger(n) ? String(n) : Number(n).toFixed(2).replace(/\.?0+$/, ''));
    const chosenKr = () => data.keyResults.find((k) => k.krId === chosen);

    function shown(kr, value) {
        if (kr.type === 'milestone') return value >= 1 ? 'done' : 'not done';
        return `${number(value)} ${kr.unit || ''}`.trim();
    }

    function when(iso) {
        return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    // ---------- form ----------
    const message = el('p', { className: 'message', attrs: { 'aria-live': 'polite' } });
    const krSelect = el('select', { attrs: { id: 'ci-kr' } });
    const valueInput = el('input', { attrs: { id: 'ci-value', type: 'number', step: 'any', required: '' } });
    const milestoneSelect = el('select', { attrs: { id: 'ci-done' } }, [
        el('option', { text: 'Done', attrs: { value: '1' } }),
        el('option', { text: 'Not done yet', attrs: { value: '0' } })
    ]);
    const noteInput = el('textarea', { attrs: { id: 'ci-note', maxlength: '500', placeholder: 'What happened this week? (optional)' } });
    const hint = el('p', { className: 'muted' });
    const save = el('button', { text: 'Log check-in', className: 'primary', attrs: { type: 'submit', id: 'ci-save' } });
    const valueField = el('label', {}, [document.createTextNode('New value'), valueInput]);
    const doneField = el('label', { className: 'hidden' }, [document.createTextNode('Milestone'), milestoneSelect]);

    const form = el('form', { className: 'ci-form', attrs: { novalidate: '' } }, [
        el('div', { className: 'form-grid' }, [
            el('label', {}, [document.createTextNode('Key result'), krSelect]),
            valueField,
            doneField,
            el('label', { className: 'wide' }, [document.createTextNode('Note'), noteInput])
        ]),
        hint,
        el('div', { className: 'actions' }, [save])
    ]);
    const history = el('div', { className: 'ci-history' });

    krSelect.addEventListener('change', () => { chosen = krSelect.value; say(message, '', 'ok'); syncForm(); loadHistory(); });

    function syncForm() {
        const kr = chosenKr();
        if (!kr) return;
        const milestone = kr.type === 'milestone';
        valueField.classList.toggle('hidden', milestone);
        doneField.classList.toggle('hidden', !milestone);
        valueInput.value = '';
        if (kr.type === 'percentage') { valueInput.min = '0'; valueInput.max = '100'; } else { valueInput.removeAttribute('min'); valueInput.removeAttribute('max'); }
        hint.textContent = milestone
            ? 'Mark the milestone as done or not done.'
            : `Now ${shown(kr, kr.current)}, target ${shown(kr, kr.target)}.${kr.type === 'percentage' ? ' Between 0 and 100.' : ''}`;
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const kr = chosenKr();
        if (!kr) return;
        const value = kr.type === 'milestone' ? Number(milestoneSelect.value) : (valueInput.value === '' ? NaN : Number(valueInput.value));
        const note = noteInput.value.trim();
        // Quick checks for the user's convenience (C2); the API decides
        if (!Number.isFinite(value)) { say(message, 'Write the new value as a number.'); return; }
        if (kr.type === 'percentage' && (value < 0 || value > 100)) { say(message, 'A percentage is between 0 and 100.'); return; }

        save.disabled = true;
        say(message, 'Saving...', 'ok');
        try {
            const body = note ? { krId: kr.krId, value, note } : { krId: kr.krId, value };
            await api('/api/check-ins', { method: 'POST', body });
            noteInput.value = '';
            valueInput.value = '';
            say(message, `Check-in saved: ${shown(kr, value)}.`, 'ok');
            await loadHistory();
            waitForKeyResult(kr.krId, value);
        } catch (err) {
            if (err.status === 409) say(message, 'This goal is not active, so check-ins are closed. Activate it first.');
            else if (err.status === 503) say(message, 'Key Results or Goals is not answering, so the check-in was not saved. Try again shortly.');
            else say(message, errorText(err));
        } finally {
            save.disabled = false;
        }
    });

    // Key Results applies the check-in from the check-in.logged event a moment later
    // (SNS -> SQS -> kr-events), so ask again a few times before telling the page.
    async function waitForKeyResult(krId, value) {
        for (let i = 0; i < 6; i += 1) {
            await new Promise((r) => setTimeout(r, 1000));
            try {
                const fresh = await api(`/api/goals/${encodeURIComponent(goalId)}/key-results`);
                const kr = fresh.keyResults.find((k) => k.krId === krId);
                if (kr && kr.current === value) break;
            } catch { break; }
        }
        // goal.js reloads the goal's progress bar; key-results.js and this panel reload on goal-changed
        window.dispatchEvent(new Event('key-results-changed'));
        window.dispatchEvent(new Event('goal-changed'));
    }

    // ---------- undo (rule C3) ----------
    // Only on my newest check-in, only within 24 hours, only while the goal is open.
    // The API checks all of this again and answers 409 otherwise.
    const UNDO_MS = 24 * 60 * 60 * 1000;
    function undoButton(kr, c) {
        if (!OPEN.includes(data.goalStatus) || Date.now() - new Date(c.createdAt).getTime() > UNDO_MS) return null;
        const btn = el('button', { text: 'Undo', className: 'danger', attrs: { type: 'button' } });
        btn.addEventListener('click', async () => {
            // Ask once more on the same button, like Delete in the key-results panel
            if (!btn.dataset.armed) {
                btn.dataset.armed = '1';
                btn.textContent = `Click again to undo (back to ${shown(kr, c.previousValue)})`;
                setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Undo'; }, 4000);
                return;
            }
            btn.disabled = true;
            say(message, 'Undoing...', 'ok');
            try {
                await api(`/api/check-ins/${encodeURIComponent(c.checkInId)}`, { method: 'DELETE' });
                say(message, `Check-in undone: back to ${shown(kr, c.previousValue)}.`, 'ok');
                await loadHistory();
                waitForKeyResult(kr.krId, c.previousValue);
            } catch (err) {
                btn.disabled = false;
                say(message, err.status === 503 ? 'Key Results or Goals is not answering, so nothing was undone. Try again shortly.' : errorText(err));
            }
        });
        return el('div', { className: 'actions' }, [btn]);
    }

    // ---------- history ----------
    async function loadHistory() {
        const kr = chosenKr();
        if (!kr) { history.replaceChildren(); return; }
        try {
            const list = await api(`/api/check-ins?krId=${encodeURIComponent(kr.krId)}`);
            const heading = el('h3', { text: `History: ${kr.title}` });
            if (!list.length) {
                history.replaceChildren(heading, el('p', { className: 'empty', text: 'No check-ins yet for this key result.' }));
                return;
            }
            history.replaceChildren(heading, el('ul', { className: 'ci-list' }, list.map((c, i) => el('li', { className: 'ci-item' }, [
                el('div', { className: 'row spread' }, [
                    el('strong', { text: `${shown(kr, c.previousValue)} → ${shown(kr, c.value)}` }),
                    el('span', { className: 'meta', text: when(c.createdAt) })
                ]),
                c.note ? el('p', { className: 'ci-note', text: c.note }) : null,
                i === 0 ? undoButton(kr, c) : null
            ]))));
        } catch (err) {
            history.replaceChildren(el('p', { className: 'message error', text: err.status === 503 ? 'Check-ins is not answering. Try again shortly.' : err.message }));
        }
    }

    // ---------- whole panel ----------
    function render() {
        const krs = data.keyResults;
        const header = el('h2', { text: 'Check-ins' });
        if (!krs.length) {
            panel.replaceChildren(header, el('p', { className: 'muted', text: 'Add a key result first, then log progress on it here.' }));
            return;
        }
        if (!krs.some((k) => k.krId === chosen)) chosen = krs[0].krId;
        krSelect.replaceChildren(...krs.map((k) => el('option', { text: k.title, attrs: { value: k.krId } })));
        krSelect.value = chosen;

        // Goal not Active or At risk: the history stays readable, logging is switched off
        const open = OPEN.includes(data.goalStatus);
        const closedNote = el('p', { className: 'muted', text: data.goalStatus === 'Draft'
            ? 'Activate the goal to start logging check-ins.'
            : `This goal is ${LABELS[data.goalStatus] || data.goalStatus}, so check-ins are closed. The history stays here.` });
        [valueInput, milestoneSelect, noteInput, save].forEach((i) => { i.disabled = !open; });
        if (!open) say(message, '', 'ok');
        syncForm();
        panel.replaceChildren(...[header, open ? null : closedNote, form, message, history].filter(Boolean));
        loadHistory();
    }

    async function load() {
        try {
            data = await api(`/api/goals/${encodeURIComponent(goalId)}/key-results`);
            render();
        } catch (err) {
            if (err.status === 404) { panel.replaceChildren(); return; }   // goal.js already says "does not exist"
            panel.replaceChildren(el('h2', { text: 'Check-ins' }), el('p', { className: 'message error', text: err.message }));
        }
    }

    // A change of goal status (Activate, Achieve...) or of key results changes what can be logged here
    window.addEventListener('goal-changed', load);
    load();
}());
