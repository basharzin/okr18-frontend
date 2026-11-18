// ---------------------------------------------------------------
// One helper for every call to the API (shared layout task 8 builds on it).
// - adds the login token
// - sends and reads JSON
// - 401 anywhere = the login has ended: back to the login page
// - every other error becomes an ApiError with the API's own code and message
// ---------------------------------------------------------------
class ApiError extends Error {
    constructor(status, code, message, details) {
        super(message);
        this.status = status; this.code = code; this.details = details || [];
    }
}

async function api(path, { method = 'GET', body, auth = true } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) {
        const token = Session.token();
        if (!token) { window.location.replace('login.html'); throw new ApiError(401, 'UNAUTHENTICATED', 'Log in to continue.'); }
        headers.Authorization = `Bearer ${token}`;
    }

    let res;
    try {
        res = await fetch(window.OKR18_CONFIG.apiUrl + path, {
            method, headers, body: body === undefined ? undefined : JSON.stringify(body)
        });
    } catch {
        throw new ApiError(0, 'NETWORK', 'The server cannot be reached. Check that Floci is running.');
    }

    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (res.ok) return data;

    if (res.status === 401 && auth) { Session.clear(); window.location.replace('login.html'); }
    const err = data?.error || {};
    throw new ApiError(res.status, err.code || 'ERROR', err.message || data?.message || `Request failed (${res.status}).`, err.details);
}
