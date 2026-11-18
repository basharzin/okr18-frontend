// Runs the auth API on a PC: npm run dev -> http://localhost:3000
const app = require('./app');
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`Auth service on http://localhost:${PORT}`));
