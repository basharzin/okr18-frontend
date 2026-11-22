// ---------------------------------------------------------------
// Two small protections every API answer gets (Lab 8, "security in layers").
//
// 1. securityHeaders: tells the browser how to treat our answers.
//      nosniff          -> never guess the type: JSON stays JSON
//      DENY + CSP       -> an API answer is never shown in a frame or run as a page
//      no-store         -> answers with user data are not kept in caches
//
// 2. rateLimit: at most RATE_LIMIT_MAX requests per IP in the last 60 seconds,
//    then 429 Too Many Requests (a sliding window, as in Lab 8).
//    The IP comes from API Gateway (requestContext.http.sourceIp), never from the
//    X-Forwarded-For header, which any client can fake.
//    Honest limit: the count lives in this Lambda container's memory, so each
//    container counts on its own. API Gateway throttling is the main limit on AWS.
// ---------------------------------------------------------------

function securityHeaders(req, res, next) {
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store'
    });
    next();
}

function clientIp(req) {
    return req.requestContext?.http?.sourceIp      // set by API Gateway, cannot be faked by the client
        || req.socket?.remoteAddress                // a PC (npm run dev)
        || 'unknown';
}

function rateLimit({ max = Number(process.env.RATE_LIMIT_MAX) || 60, windowMs = 60 * 1000, now = () => Date.now(), service = 'api' } = {}) {
    const hits = new Map();   // ip -> times of its requests in the window

    return (req, res, next) => {
        const t = now();
        const ip = clientIp(req);
        const recent = (hits.get(ip) || []).filter((time) => t - time < windowMs);

        if (recent.length >= max) {
            hits.set(ip, recent);
            const retryAfter = Math.ceil((recent[0] + windowMs - t) / 1000);
            console.log(JSON.stringify({ service, security: 'rate_limited', method: req.method, path: req.originalUrl.split('?')[0] }));
            res.set('Retry-After', String(retryAfter));
            return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Wait a minute and try again.' } });
        }

        recent.push(t);
        hits.set(ip, recent);
        if (hits.size > 10000) hits.delete(hits.keys().next().value);   // keep memory small: forget the oldest IP
        return next();
    };
}

module.exports = { securityHeaders, rateLimit, clientIp };
