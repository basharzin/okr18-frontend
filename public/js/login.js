// ---------------------------------------------------------------
// Log in or create an account. Both need a Turnstile token first;
// the API checks it with Cloudflare before it talks to Cognito.
// ---------------------------------------------------------------
const form = document.querySelector('#auth-form');
const email = document.querySelector('#email');
const password = document.querySelector('#password');
const submit = document.querySelector('#submit');
const message = document.querySelector('#form-message');
const hint = document.querySelector('#password-hint');
const confirmField = document.querySelector('#confirm-field');      // sign-up only: type the password twice
const confirmInput = document.querySelector('#password-confirm');
const tabLogin = document.querySelector('#tab-login');
const tabSignup = document.querySelector('#tab-signup');

let mode = 'login';
let turnstileToken = '';
let widgetId = null;

if (Session.token()) window.location.replace('goals.html');

// Turnstile calls this when its script has loaded
window.onTurnstileReady = () => {
    widgetId = window.turnstile.render('#turnstile', {
        sitekey: window.OKR18_CONFIG.turnstileSiteKey,
        callback: (token) => { turnstileToken = token; },
        'expired-callback': () => { turnstileToken = ''; },
        'error-callback': () => { turnstileToken = ''; }
    });
};

function setMode(next) {
    mode = next;
    tabLogin.setAttribute('aria-selected', String(mode === 'login'));
    tabSignup.setAttribute('aria-selected', String(mode === 'signup'));
    submit.textContent = mode === 'login' ? 'Log in' : 'Create account';
    password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    hint.classList.toggle('hidden', mode === 'login');
    confirmField.classList.toggle('hidden', mode === 'login');
    confirmInput.value = '';
    showMessage('');
}
tabLogin.addEventListener('click', () => setMode('login'));
tabSignup.addEventListener('click', () => setMode('signup'));

function showMessage(text, kind = 'error') {
    message.textContent = text;
    message.className = `message ${kind}`;
}

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!email.value.trim() || !password.value) return showMessage('Enter your email and password.');
    if (mode === 'signup' && password.value !== confirmInput.value) return showMessage('The two passwords are not the same. Type them again.');
    if (!turnstileToken) return showMessage('Wait for the bot check to finish, then try again.');

    const body = { email: email.value.trim(), password: password.value, turnstileToken };
    submit.disabled = true;
    try {
        if (mode === 'signup') {
            await api('/api/auth/signup', { method: 'POST', body, auth: false });
            setMode('login');
            showMessage('Account created. Log in now.', 'ok');
        } else {
            const out = await api('/api/auth/login', { method: 'POST', body, auth: false });
            Session.save(out.accessToken, out.expiresIn);
            window.location.replace('goals.html');
        }
    } catch (error) {
        showMessage(error.message);
    } finally {
        submit.disabled = false;
        password.value = '';
        confirmInput.value = '';
        // A Turnstile token works once: get a fresh one for the next try
        turnstileToken = '';
        if (widgetId !== null) window.turnstile.reset(widgetId);
    }
});
