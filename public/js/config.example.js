// Copy of what infra/write-config.sh writes to public/js/config.js on each PC.
// Nothing here is secret: the API address and the PUBLIC Turnstile site key.
window.OKR18_CONFIG = {
    apiUrl: 'http://<api-id>.execute-api.localhost.floci.io:4566',
    // Cloudflare's public test site key (always passes). Replace with the real site key for a real site.
    turnstileSiteKey: '1x00000000000000000000AA'
};
