// ---------------------------------------------------------------
// The login token lives in sessionStorage: gone when the tab closes,
// never in localStorage, never in a cookie the API would accept by itself.
// ---------------------------------------------------------------
const Session = {
    save(token, expiresInSeconds) {
        sessionStorage.setItem('okr18.token', token);
        sessionStorage.setItem('okr18.expires', String(Date.now() + expiresInSeconds * 1000));
    },
    token() {
        const expires = Number(sessionStorage.getItem('okr18.expires') || 0);
        if (Date.now() > expires) { Session.clear(); return null; }
        return sessionStorage.getItem('okr18.token');
    },
    clear() {
        sessionStorage.removeItem('okr18.token');
        sessionStorage.removeItem('okr18.expires');
    },
    // Pages that need a login call this first
    require() {
        if (!Session.token()) { window.location.replace('login.html'); return false; }
        return true;
    }
};
