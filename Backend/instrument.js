// Sentry must be initialized BEFORE Express (and other libs) are required, so
// this file is loaded first (see the top of server.js). Opt-in via SENTRY_DSN;
// a missing DSN or package is a silent no-op.
const path = require('path');
require('dotenv').config({
  path: path.resolve(__dirname, '..', '.env'),
  override: false
});

if (process.env.SENTRY_DSN) {
  try {
    const Sentry = require('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
      release: process.env.RENDER_GIT_COMMIT || undefined,
      tracesSampleRate: 0.05,
      sendDefaultPii: false,
      beforeSend(event) {
        try {
          if (event.request && event.request.headers) {
            ['authorization', 'Authorization', 'cookie', 'Cookie'].forEach((h) => {
              delete event.request.headers[h];
            });
          }
        } catch (_) {}
        return event;
      }
    });
    console.log('Sentry error tracking enabled');
  } catch (err) {
    console.warn('Sentry not initialized:', err.message);
  }
}
