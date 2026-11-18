// The front door: logged in -> goals, otherwise -> login
window.location.replace(Session.token() ? 'goals.html' : 'login.html');
