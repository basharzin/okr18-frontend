// ---------------------------------------------------------------
// Goals dashboard: summary, filters, goal cards, and the "New goal" form.
// All data comes from the Goals API; nothing is stored in the page.
// ---------------------------------------------------------------
if (Session.require()) {
    const list = document.querySelector('#goal-list');
    const listMessage = document.querySelector('#list-message');
    const filterYear = document.querySelector('#filter-year');
    const filterStatus = document.querySelector('#filter-status');
    const filterCategory = document.querySelector('#filter-category');
    const dialog = document.querySelector('#goal-dialog');
    const form = document.querySelector('#goal-form');
    const formMessage = document.querySelector('#goal-form-message');
    const save = document.querySelector('#g-save');

    fillYears(filterYear);
    fillYears(document.querySelector('#g-year'));

    function goalCard(goal) {
        const title = el('h3', {}, [el('a', { text: goal.title, attrs: { href: `goal.html?id=${encodeURIComponent(goal.goalId)}` } })]);
        const badges = el('div', { className: 'row' }, [badge(goal.status), showsHealth(goal) ? badge(goal.health) : null]);
        const meta = el('div', { className: 'meta', text: `${goal.category} · due ${formatDate(goal.deadline)}` });
        const label = goal.status === 'Draft'
            ? 'Not started: add key results and activate it.'
            : `${goal.progress}% done${goal.expectedProgress ? ` · expected by now ${goal.expectedProgress}%` : ''}`;
        return el('article', { className: 'goal-card' }, [
            el('div', { className: 'row', attrs: { style: 'justify-content: space-between;' } }, [title, badges]),
            meta,
            progressBar(goal.progress, goal.expectedProgress),
            el('div', { className: 'progress-label', text: label })
        ]);
    }

    async function loadSummary() {
        const s = await api(`/api/goals/summary?year=${filterYear.value}`);
        document.querySelector('#stat-active').textContent = s.counts.Active + s.counts.AtRisk;
        document.querySelector('#stat-draft').textContent = s.counts.Draft;
        document.querySelector('#stat-achieved').textContent = s.counts.Achieved;
        document.querySelector('#stat-average').textContent = `${s.averageProgress}%`;
        const box = document.querySelector('#attention');
        const ul = document.querySelector('#attention-list');
        ul.replaceChildren(...s.needsAttention.map((g) => el('li', {}, [
            el('a', { text: g.title, attrs: { href: `goal.html?id=${encodeURIComponent(g.goalId)}` } }),
            document.createTextNode(` · ${g.progress}% done, expected ${g.expectedProgress}% · `),
            badge(g.health)
        ])));
        box.classList.toggle('hidden', s.needsAttention.length === 0);
    }

    async function loadGoals() {
        const q = new URLSearchParams({ year: filterYear.value });
        if (filterStatus.value) q.set('status', filterStatus.value);
        if (filterCategory.value) q.set('category', filterCategory.value);
        listMessage.textContent = 'Loading goals...';
        listMessage.className = 'message';
        try {
            const goals = await api(`/api/goals?${q}`);
            listMessage.textContent = '';
            list.replaceChildren(...(goals.length
                ? goals.map(goalCard)
                : [el('div', { className: 'empty', text: filterStatus.value || filterCategory.value ? 'No goals match these filters.' : 'No goals yet for this year. Start with "New goal".' })]));
        } catch (error) {
            listMessage.textContent = error.message;
            listMessage.className = 'message error';
        }
    }

    async function refresh() {
        await Promise.all([loadGoals(), loadSummary().catch(() => {})]);
    }

    [filterYear, filterStatus, filterCategory].forEach((s) => s.addEventListener('change', refresh));

    document.querySelector('#new-goal').addEventListener('click', () => {
        form.reset();
        const gYear = document.querySelector('#g-year');
        gYear.replaceChildren();
        fillYears(gYear, filterYear.value);
        formMessage.textContent = '';
        dialog.showModal();
        document.querySelector('#g-title').focus();
    });
    document.querySelector('#g-cancel').addEventListener('click', () => dialog.close());

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const body = {
            title: document.querySelector('#g-title').value.trim(),
            description: document.querySelector('#g-description').value.trim(),
            category: document.querySelector('#g-category').value,
            year: Number(document.querySelector('#g-year').value),
            deadline: document.querySelector('#g-deadline').value
        };
        // Same rules as the API, so most mistakes are caught before sending
        if (body.title.length < 3) { formMessage.textContent = 'Title must be between 3 and 80 characters.'; return; }
        if (!body.deadline) { formMessage.textContent = 'Pick a deadline.'; return; }
        save.disabled = true;
        try {
            const goal = await api('/api/goals', { method: 'POST', body });
            dialog.close();
            window.location.href = `goal.html?id=${encodeURIComponent(goal.goalId)}`;
        } catch (error) {
            formMessage.textContent = errorText(error);
        } finally {
            save.disabled = false;
        }
    });

    refresh();
}
