// ---------------------------------------------------------------
// Key-results panel inside goal.html (owner: Amr Shalaby, Key Results Service).
// Lists the goal's key results with their progress, and adds, edits and deletes them.
// The form follows rules K1, K2 and K5, but the API checks everything again:
// a hidden button or a browser check is never the security check.
// Everything is shown with textContent (el() in ui.js), never innerHTML.
// ---------------------------------------------------------------
(function keyResultsPanel() {
    if (!Session.token()) return;                        // goal.js already sends the visitor to login
    const goalId = new URLSearchParams(window.location.search).get('id') || '';
    if (!/^G-[0-9a-f-]{36}$/.test(goalId)) return;

    const panel = document.querySelector('#key-results-panel');
    const TYPE_LABELS = { number: 'Number', percentage: 'Percentage', milestone: 'Milestone (done / not done)' };
    let data = null;          // last answer of GET /api/goals/{id}/key-results
    let editing = null;       // the key result being edited, or null when adding

    const say = (node, text, kind = 'error') => { node.textContent = text; node.className = `message ${kind}`; };
    const tellGoalPage = () => window.dispatchEvent(new Event('key-results-changed'));   // goal.js reloads its progress bar

    function number(n) { return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ''); }

    // ---------- list ----------
    function card(kr) {
        const done = kr.type === 'milestone'
            ? (kr.current >= 1 ? 'Done' : 'Not done yet')
            : `now ${number(kr.current)} ${kr.unit} · target ${number(kr.target)} ${kr.unit} (started at ${number(kr.start)})`;
        const meta = `${TYPE_LABELS[kr.type].split(' ')[0]} · weight ${kr.weight}`;
        const buttons = [];
        if (data.canChange) {
            const edit = el('button', { text: 'Edit', attrs: { type: 'button' } });
            edit.addEventListener('click', () => openForm(kr));
            const del = el('button', { text: 'Delete', className: 'danger', attrs: { type: 'button' } });
            del.addEventListener('click', () => confirmDelete(kr, del));
            buttons.push(edit, del);
        }
        return el('li', { className: 'kr-card' }, [
            el('div', { className: 'row', attrs: { style: 'justify-content: space-between;' } }, [
                el('h3', { text: kr.title }),
                el('span', { className: `badge ${kr.status === 'Completed' ? 'Done' : kr.status === 'Frozen' ? 'Abandoned' : 'Active'}`, text: kr.status })
            ]),
            el('p', { className: 'meta', text: meta }),
            progressBar(kr.progress, 0),
            el('p', { className: 'progress-label', text: `${kr.progress}% · ${done}` }),
            buttons.length ? el('div', { className: 'actions' }, buttons) : null
        ]);
    }

    // Delete asks once more on the same button (rule K5 is checked by the API)
    function confirmDelete(kr, btn) {
        if (btn.dataset.armed) {
            remove(kr);
            return;
        }
        btn.dataset.armed = '1';
        btn.textContent = 'Click again to delete';
        setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Delete'; }, 4000);
    }

    function render() {
        const krs = data.keyResults;
        const header = el('div', { className: 'row', attrs: { style: 'justify-content: space-between;' } }, [
            el('h2', { text: 'Key results' }),
            el('span', { className: 'muted', text: `${krs.length} of ${data.maxKeyResults} · goal progress ${data.progress}%` })
        ]);
        const parts = [header];

        if (!data.canChange) {
            parts.push(el('p', { className: 'muted', text: `This goal is ${LABELS[data.goalStatus] || data.goalStatus}, so its key results can no longer change.` }));
        } else if (data.goalStatus === 'Active') {
            parts.push(el('p', { className: 'muted', text: 'The goal is active: targets are locked, only titles can change. Progress comes from check-ins.' }));
        }

        parts.push(krs.length
            ? el('ul', { className: 'kr-list' }, krs.map(card))
            : el('p', { className: 'empty', text: 'No key results yet. Add one so this goal can be measured and activated.' }));

        if (data.canChange && krs.length < data.maxKeyResults) {
            const add = el('button', { text: 'Add key result', className: 'primary', attrs: { type: 'button', id: 'kr-add' } });
            add.addEventListener('click', () => openForm(null));
            parts.push(el('div', { className: 'actions' }, [add]));
        }
        parts.push(form.node);
        parts.push(message);
        panel.replaceChildren(...parts);
    }

    // ---------- add / edit form ----------
    const message = el('p', { className: 'message', attrs: { 'aria-live': 'polite' } });
    const form = buildForm();

    function field(label, input, cls) { return el('label', { className: cls }, [document.createTextNode(label), input]); }

    function buildForm() {
        const title = el('input', { attrs: { id: 'kr-title', minlength: '3', maxlength: '80', required: '' } });
        const type = el('select', { attrs: { id: 'kr-type' } },
            Object.entries(TYPE_LABELS).map(([v, t]) => el('option', { text: t, attrs: { value: v } })));
        const unit = el('input', { attrs: { id: 'kr-unit', maxlength: '20', placeholder: 'books, km, %' } });
        const start = el('input', { attrs: { id: 'kr-start', type: 'number', step: 'any', value: '0' } });
        const target = el('input', { attrs: { id: 'kr-target', type: 'number', step: 'any' } });
        const weight = el('select', { attrs: { id: 'kr-weight' } },
            [1, 2, 3, 4, 5].map((w) => el('option', { text: String(w), attrs: { value: String(w) } })));
        const heading = el('h3', { text: 'Add key result' });
        const note = el('p', { className: 'muted' });
        const error = el('p', { className: 'message error', attrs: { 'aria-live': 'polite' } });
        const save = el('button', { text: 'Save', className: 'primary', attrs: { type: 'submit' } });
        const cancel = el('button', { text: 'Cancel', attrs: { type: 'button' } });
        const numberFields = [field('Unit', unit), field('Start value', start), field('Target value', target)];

        const node = el('form', { className: 'kr-form hidden', attrs: { novalidate: '' } }, [
            heading,
            note,
            el('div', { className: 'form-grid' }, [
                field('Title', title, 'wide'), field('Type', type), field('Weight (1-5)', weight), ...numberFields
            ]),
            error,
            el('div', { className: 'actions' }, [save, cancel])
        ]);

        // A milestone is just done / not done: no unit, start or target to type
        const syncType = () => numberFields.forEach((f) => f.classList.toggle('hidden', type.value === 'milestone'));
        type.addEventListener('change', syncType);
        cancel.addEventListener('click', () => { node.classList.add('hidden'); editing = null; });

        node.addEventListener('submit', async (event) => {
            event.preventDefault();
            const body = { title: title.value.trim(), type: type.value, weight: Number(weight.value) };
            if (type.value !== 'milestone') {
                body.unit = unit.value.trim();
                body.start = start.value === '' ? NaN : Number(start.value);
                body.target = target.value === '' ? NaN : Number(target.value);
            }
            // Quick checks for the user's convenience (K1); the API decides
            if (body.title.length < 3) { error.textContent = 'Title must be at least 3 characters.'; return; }
            if (type.value !== 'milestone') {
                if (!body.unit) { error.textContent = 'Write a unit, for example books or km.'; return; }
                if (!Number.isFinite(body.start) || !Number.isFinite(body.target)) { error.textContent = 'Start and target must be numbers.'; return; }
                if (body.start === body.target) { error.textContent = 'Target must be different from start.'; return; }
            }
            // Active goal (K5): send only the title, the API refuses the rest anyway
            const send = editing && data.goalStatus !== 'Draft' ? { title: body.title } : body;
            save.disabled = true;
            error.textContent = '';
            try {
                if (editing) {
                    await api(`/api/key-results/${encodeURIComponent(editing.krId)}`, { method: 'PATCH', body: send });
                } else {
                    await api(`/api/goals/${encodeURIComponent(goalId)}/key-results`, { method: 'POST', body: send });
                }
                node.classList.add('hidden');
                const what = editing ? 'Key result saved.' : 'Key result added.';
                editing = null;
                await load();
                say(message, what, 'ok');
                tellGoalPage();
            } catch (err) {
                error.textContent = errorText(err);
            } finally {
                save.disabled = false;
            }
        });

        function open(kr) {
            editing = kr;
            heading.textContent = kr ? 'Edit key result' : 'Add key result';
            title.value = kr ? kr.title : '';
            type.value = kr ? kr.type : 'number';
            unit.value = kr && kr.type !== 'milestone' ? kr.unit : '';
            start.value = kr ? String(kr.start) : '0';
            target.value = kr ? String(kr.target) : '';
            weight.value = String(kr ? kr.weight : 1);
            const locked = Boolean(kr) && data.goalStatus !== 'Draft';     // K5
            [type, unit, start, target, weight].forEach((i) => { i.disabled = locked; });
            note.textContent = locked ? 'The goal is active, so only the title can change.' : '';
            error.textContent = '';
            syncType();
            node.classList.remove('hidden');
            title.focus();
        }

        return { node, open };
    }

    function openForm(kr) { say(message, '', 'ok'); form.open(kr); }

    // ---------- API calls ----------
    async function remove(kr) {
        try {
            await api(`/api/key-results/${encodeURIComponent(kr.krId)}`, { method: 'DELETE' });
            await load();
            say(message, 'Key result deleted.', 'ok');
            tellGoalPage();
        } catch (err) {
            say(message, errorText(err));
        }
    }

    async function load() {
        try {
            data = await api(`/api/goals/${encodeURIComponent(goalId)}/key-results`);
            render();
        } catch (err) {
            if (err.status === 404) { panel.replaceChildren(); return; }   // goal.js already says "does not exist"
            panel.replaceChildren(
                el('h2', { text: 'Key results' }),
                el('p', { className: 'message error', text: err.status === 503 ? 'Goals is not answering, so key results cannot be checked yet. Try again shortly.' : err.message })
            );
        }
    }

    // When goal.js changes the goal (Activate, Achieve, Abandon...), what may change here changes too
    window.addEventListener('goal-changed', load);
    load();
}());
