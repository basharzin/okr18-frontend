// ---------------------------------------------------------------
// Admin page (owner: Amr Hosni, admin-api). Lists the accounts.
// The page shows the table to anyone who opens it, but the data only comes
// if the API says yes: it checks the admin group in the token and answers
// 403 to everyone else (test ST4). Hiding a link is never the security check.
// Everything is shown with textContent (el() in ui.js), never innerHTML.
// ---------------------------------------------------------------
(function adminPage() {
    if (!Session.require()) return;

    const message = document.querySelector('#admin-message');
    const box = document.querySelector('#admin-users');
    const count = document.querySelector('#admin-count');
    const say = (text, kind = 'error') => { message.textContent = text; message.className = `message ${kind}`; };

    function table(users) {
        const head = el('tr', {}, ['Email', 'Role', 'Status', 'Enabled', 'Created'].map((h) => el('th', { text: h, attrs: { scope: 'col' } })));
        const rows = users.map((u) => el('tr', {}, [
            el('td', { text: u.email }),
            el('td', {}, [el('span', { className: `badge ${u.admin ? 'Active' : 'Draft'}`, text: u.admin ? 'admin' : 'user' })]),
            el('td', { text: u.status }),
            el('td', { text: u.enabled ? 'Yes' : 'No' }),
            el('td', { text: u.createdAt ? formatDate(u.createdAt) : '' })
        ]));
        return el('div', { className: 'table-wrap' }, [
            el('table', { className: 'admin-table' }, [el('thead', {}, [head]), el('tbody', {}, rows)])
        ]);
    }

    async function load() {
        try {
            const data = await api('/api/admin/users');
            count.textContent = `${data.count} account${data.count === 1 ? '' : 's'}`;
            say('', 'ok');
            box.replaceChildren(data.users.length ? table(data.users) : el('p', { className: 'empty', text: 'No accounts yet.' }));
        } catch (err) {
            box.replaceChildren();
            if (err.status === 403) say('403: this page is for admins only. Your account is a normal user.');
            else if (err.status === 503) say('Cognito is not answering. Try again shortly.');
            else say(err.message);
        }
    }

    load();
}());
