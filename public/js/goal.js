// ---------------------------------------------------------------
// One goal: details, progress and health, edit, and the state buttons.
// The buttons shown follow rule G1, but the API checks every move again:
// a hidden button is never the security check.
// ---------------------------------------------------------------
if (Session.require()) {
    const id = new URLSearchParams(window.location.search).get('id') || '';
    const pageMessage = document.querySelector('#page-message');
    const view = document.querySelector('#goal-view');
    const actions = document.querySelector('#goal-actions');
    const actionMessage = document.querySelector('#action-message');
    const editPanel = document.querySelector('#edit-panel');
    let goal = null;

    const HEALTH_NOTES = {
        OnTrack: 'On track: progress is keeping up with the time that has passed.',
        AtRisk: 'At risk: progress is more than 10 points behind where it should be by now.',
        Overdue: 'Overdue: the deadline has passed before reaching 100%.',
        Done: 'Done.',
        NotStarted: 'Add at least one key result, then activate the goal to start tracking.'
    };

    function say(node, text, kind = 'error') { node.textContent = text; node.className = `message ${kind}`; }

    function button(text, onClick, className) {
        const b = el('button', { text, className, attrs: { type: 'button' } });
        b.addEventListener('click', onClick);
        return b;
    }

    function render() {
        document.title = `${goal.title} · OKR Tracker`;
        document.querySelector('#goal-title').textContent = goal.title;
        document.querySelector('#goal-badges').replaceChildren(badge(goal.status), showsHealth(goal) ? badge(goal.health) : '');
        document.querySelector('#goal-meta').textContent = `${goal.category} · ${goal.year} · due ${formatDate(goal.deadline)}`;
        document.querySelector('#goal-description').textContent = goal.description || '';
        document.querySelector('#goal-progress').replaceChildren(progressBar(goal.progress, goal.expectedProgress));
        document.querySelector('#goal-progress-label').textContent = goal.status === 'Draft'
            ? 'Not started'
            : `${goal.progress}% done${goal.expectedProgress ? ` · expected by now ${goal.expectedProgress}%` : ''}`;
        document.querySelector('#goal-health-note').textContent = goal.status === 'Draft' || showsHealth(goal) ? (HEALTH_NOTES[goal.health] || '') : '';
        const reason = document.querySelector('#goal-abandon-reason');
        reason.textContent = goal.abandonReason ? `Abandoned because: ${goal.abandonReason}` : '';
        reason.classList.toggle('hidden', !goal.abandonReason);

        const s = goal.status;
        const thisYear = new Date().getFullYear();
        const buttons = [];
        if (s === 'Draft') buttons.push(button('Activate', () => move('Active'), 'primary'));
        if (s === 'Active' || s === 'AtRisk') {
            buttons.push(button('Mark achieved', () => move('Achieved'), 'primary'));
            buttons.push(button('Abandon', openAbandon, 'danger'));
        }
        if (s === 'Abandoned' && !goal.reopened && goal.year === thisYear) buttons.push(button('Reopen', () => move('Active'), 'primary'));
        if (s === 'Draft' || s === 'Active' || s === 'AtRisk') buttons.push(button('Edit', openEdit));
        if (s === 'Draft' || s === 'Abandoned') buttons.push(button('Delete', () => document.querySelector('#delete-dialog').showModal(), 'danger'));
        actions.replaceChildren(...buttons);
        view.classList.remove('hidden');
    }

    async function load() {
        if (!/^G-[0-9a-f-]{36}$/.test(id)) { say(pageMessage, 'This goal does not exist.'); return; }
        try {
            goal = await api(`/api/goals/${encodeURIComponent(id)}`);
            render();
            say(pageMessage, '', 'ok');
        } catch (error) {
            say(pageMessage, error.status === 404 ? 'This goal does not exist, or it is not yours.' : error.message);
        }
    }

    // POST /transitions: the API applies rules G1 to G5 and answers 409 with the reason
    async function move(to, reason) {
        actions.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        say(actionMessage, 'Saving...', 'ok');
        try {
            goal = await api(`/api/goals/${encodeURIComponent(id)}/transitions`, { method: 'POST', body: reason ? { to, reason } : { to } });
            render();
            say(actionMessage, `Goal is now ${LABELS[goal.status]}.`, 'ok');
            window.dispatchEvent(new Event('goal-changed'));
            return true;
        } catch (error) {
            say(actionMessage, error.status === 503 ? 'Key Results is not answering, so this cannot be checked yet. Try again shortly.' : error.message);
            render();
            return false;
        }
    }

    // Abandon needs a reason (rule G5)
    const abandonDialog = document.querySelector('#abandon-dialog');
    function openAbandon() {
        document.querySelector('#abandon-reason').value = '';
        document.querySelector('#abandon-message').textContent = '';
        abandonDialog.showModal();
    }
    document.querySelector('#abandon-cancel').addEventListener('click', () => abandonDialog.close());
    document.querySelector('#abandon-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const reason = document.querySelector('#abandon-reason').value.trim();
        if (reason.length < 10 || reason.length > 200) {
            document.querySelector('#abandon-message').textContent = 'Write a reason of 10 to 200 characters.';
            return;
        }
        abandonDialog.close();
        await move('Abandoned', reason);
    });

    // Edit (rule G7)
    function openEdit() {
        document.querySelector('#e-title').value = goal.title;
        document.querySelector('#e-description').value = goal.description || '';
        document.querySelector('#e-category').value = goal.category;
        document.querySelector('#e-deadline').value = goal.deadline;
        document.querySelector('#edit-message').textContent = '';
        editPanel.classList.remove('hidden');
        document.querySelector('#e-title').focus();
    }
    document.querySelector('#e-cancel').addEventListener('click', () => editPanel.classList.add('hidden'));
    document.querySelector('#edit-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const changes = {};
        const title = document.querySelector('#e-title').value.trim();
        const description = document.querySelector('#e-description').value.trim();
        const category = document.querySelector('#e-category').value;
        const deadline = document.querySelector('#e-deadline').value;
        if (title !== goal.title) changes.title = title;
        if (description !== (goal.description || '')) changes.description = description;
        if (category !== goal.category) changes.category = category;
        if (deadline !== goal.deadline) changes.deadline = deadline;
        if (!Object.keys(changes).length) { editPanel.classList.add('hidden'); return; }
        const saveBtn = document.querySelector('#e-save');
        saveBtn.disabled = true;
        try {
            await api(`/api/goals/${encodeURIComponent(id)}`, { method: 'PATCH', body: changes });
            editPanel.classList.add('hidden');
            await load();
            say(actionMessage, 'Changes saved.', 'ok');
        } catch (error) {
            document.querySelector('#edit-message').textContent = errorText(error);
        } finally {
            saveBtn.disabled = false;
        }
    });

    // Delete (rule G8)
    const deleteDialog = document.querySelector('#delete-dialog');
    document.querySelector('#delete-cancel').addEventListener('click', () => deleteDialog.close());
    document.querySelector('#delete-confirm').addEventListener('click', async () => {
        try {
            await api(`/api/goals/${encodeURIComponent(id)}`, { method: 'DELETE' });
            window.location.replace('goals.html');
        } catch (error) {
            document.querySelector('#delete-message').textContent = error.message;
        }
    });

    // The key-results panel (js/key-results.js) loads its own data from the Key Results API.
    // The two parts tell each other when something changed:
    //   key results changed -> reload the goal (its progress bar)
    //   goal changed        -> the panel reloads (which buttons it may show)
    window.addEventListener('key-results-changed', load);

    load();
}
