const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const knex = require('knex');
const jwt = require('jsonwebtoken');
const path = require('path');
const { clientError, IS_PROD } = require('./errors');
const { createRedisStore } = require('./rateLimitStore');

// Do not override platform env (Render/Vercel). Local `.env` only fills gaps.
require('dotenv').config({
  path: path.resolve(__dirname, '..', '.env'),
  override: false
});

const REQUIRED_ENV = [
  'DATABASE_URL',
  'JWT_SECRET',
  'NEON_AUTH_BASE_URL'
];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error('\nMissing environment variables:\n');
  missing.forEach(k => console.error(`  - ${k}`));
  console.error('\n.env expected at:', path.resolve(__dirname, '..', '.env'), '\n');
  process.exit(1);
}

function parseDatabaseTarget(url) {
  try {
    const normalized = String(url || '').trim().replace(/^postgresql:/i, 'http:');
    const u = new URL(normalized);
    return {
      host: u.hostname,
      user: decodeURIComponent(u.username || ''),
      port: u.port || '5432'
    };
  } catch (_) {
    return null;
  }
}

const dbTarget = parseDatabaseTarget(process.env.DATABASE_URL);
if (dbTarget) {
  console.log(`Database target: ${dbTarget.user}@${dbTarget.host}:${dbTarget.port}`);
  const isDirectSupabase = /^db\.[a-z0-9]+\.supabase\.co$/i.test(dbTarget.host);
  if (isDirectSupabase && (process.env.RENDER === 'true' || process.env.NODE_ENV === 'production')) {
    console.error('\nDATABASE_URL still uses the direct Supabase host (IPv6).');
    console.error('Render is IPv4-only - use the Session pooler URL instead:');
    console.error('  Supabase → Connect → Connection pooling → Session mode');
    console.error('  Host must contain: pooler.supabase.com');
    console.error('  User must look like: postgres.<project-ref>\n');
    process.exit(1);
  }
}

const app = express();
function normalizeFrontendUrl(raw) {
  let url = String(raw || 'http://localhost:3000').trim().replace(/\/$/, '');
  // Browsers send Origin with a scheme; bare hostnames in env break CORS.
  if (url && !/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  return url;
}
const FRONTEND_URL = normalizeFrontendUrl(process.env.FRONTEND_URL);
const ALLOW_DEGRADED = process.env.ALLOW_DEGRADED === '1';
const DB_SSL_INSECURE = process.env.DB_SSL_INSECURE === '1';
// Origin of the Neon Auth server (for CSP connect-src so the browser can complete OAuth).
let NEON_AUTH_ORIGIN = null;
try { if (process.env.NEON_AUTH_BASE_URL) NEON_AUTH_ORIGIN = new URL(process.env.NEON_AUTH_BASE_URL).origin; } catch (_) {}
let dbReady = false;

app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", 'data:', 'https:'],
      "font-src": ["'self'", 'data:'],
      "connect-src": ["'self'", FRONTEND_URL, NEON_AUTH_ORIGIN, 'https://*.neon.tech'].filter(Boolean),
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "frame-ancestors": ["'none'"]
    }
  }
}));

app.use(compression());
app.use(morgan(IS_PROD ? 'combined' : 'dev'));

app.use(cors({
  origin(origin, callback) {
    if (!origin || origin === FRONTEND_URL || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(express.json({ limit: '100kb' }));

// API responses must not be cached - browsers turn GETs into 304s which break fetch().json().
app.set('etag', false);
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  next();
});

const AUTH_WINDOW_MS = 15 * 60 * 1000;
const IGDB_WINDOW_MS = 60 * 1000;
const authStore = createRedisStore(AUTH_WINDOW_MS);
const igdbStore = createRedisStore(IGDB_WINDOW_MS);

const authLimiter = rateLimit({
  windowMs: AUTH_WINDOW_MS,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth requests, please try again later' },
  ...(authStore ? { store: authStore } : {})
});

const igdbLimiter = rateLimit({
  windowMs: IGDB_WINDOW_MS,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many game data requests, please slow down' },
  ...(igdbStore ? { store: igdbStore } : {})
});

const db = knex({
  client: 'pg',
  connection: {
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: !DB_SSL_INSECURE }
  },
  pool: { min: 2, max: 10 }
});

db.raw('SELECT 1')
  .then(() => {
    dbReady = true;
    console.log('Neon PostgreSQL connected');
  })
  .catch(err => {
    console.error('Database connection failed:', err.message);
    if (dbTarget) {
      console.error(`Tried: ${dbTarget.user}@${dbTarget.host}:${dbTarget.port}`);
    }
    if (/ENETUNREACH|EHOSTUNREACH/i.test(err.message || '')) {
      console.error('Hint: ENETUNREACH on Render usually means DATABASE_URL is still db.*.supabase.co (IPv6).');
      console.error('Switch to Session pooler from Supabase Connect (host may be aws-0 / aws-1 / …).');
      console.error('Wrong pooler cluster → tenant/user not found.');
    }
    if (ALLOW_DEGRADED) {
      console.warn('ALLOW_DEGRADED=1 - continuing without DB (auth/lists will fail).');
      return;
    }
    console.error('Exiting: database is required. Set ALLOW_DEGRADED=1 only for local IGDB-only checks.');
    process.exit(1);
  });

const JWT_SECRET = process.env.JWT_SECRET;
const { getTokenFromRequest } = require('./sessionCookies');

const verifyToken = async (req, res, next) => {
  const token = getTokenFromRequest(req);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.tokenVersion = Number(decoded.tv || 0);

    try {
      const row = await db('users').where({ id: req.userId }).first('token_version');
      if (row && Number(row.token_version || 0) !== req.tokenVersion) {
        return res.status(401).json({ error: 'Session expired. Please log in again.' });
      }
    } catch (_) {
      // token_version column may not exist yet - allow token until migration is applied
    }

    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Guest-friendly auth: attach req.userId when a valid token is present, otherwise
// continue as an anonymous visitor. Banned users are still blocked. Used for
// read-only catalog browse so guests can explore before creating an account.
const optionalAuth = async (req, res, next) => {
  const token = getTokenFromRequest(req);
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    try {
      const row = await db('users').where({ id: req.userId }).first('is_banned');
      if (row && row.is_banned) return res.status(403).json({ error: 'Your account has been banned' });
    } catch (_) {}
    return next();
  } catch (_) {
    return next();
  }
};
const passThrough = (req, res, next) => next();

const checkBanned = async (req, res, next) => {
  try {
    const dbUser = await db('users').where({ id: req.userId }).first();
    if (!dbUser) return res.status(401).json({ error: 'User not found' });

    if (dbUser.is_banned) {
      return res.status(403).json({
        error: 'Your account has been banned',
        reason: dbUser.ban_reason || null
      });
    }
    next();
  } catch (error) {
    return clientError(res, 500, 'Server error', error);
  }
};

const verifyModerator = async (req, res, next) => {
  try {
    const dbUser = await db('users').where({ id: req.userId }).first();
    if (!dbUser) return res.status(401).json({ error: 'User not found' });

    if (dbUser.is_banned) {
      return res.status(403).json({ error: 'Your account has been banned' });
    }
    if (!dbUser.is_moderator && !dbUser.is_admin) {
      return res.status(403).json({ error: 'Moderator access required' });
    }

    req.userRole = {
      isModerator: dbUser.is_moderator || dbUser.is_admin,
      isAdmin:     dbUser.is_admin || false
    };

    next();
  } catch (error) {
    return clientError(res, 500, 'Server error', error);
  }
};

const verifyAdmin = async (req, res, next) => {
  try {
    const dbUser = await db('users').where({ id: req.userId }).first();
    if (!dbUser) return res.status(401).json({ error: 'User not found' });

    if (dbUser.is_banned) {
      return res.status(403).json({ error: 'Your account has been banned' });
    }
    if (!dbUser.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    req.userRole = { isModerator: true, isAdmin: true };
    next();
  } catch (error) {
    return clientError(res, 500, 'Server error', error);
  }
};

async function logModeratorActivity(moderatorId, actionType, targetType, targetId, details = null) {
  try {
    await db('moderator_activity').insert({
      moderator_id: moderatorId,
      action_type:  actionType,
      target_type:  targetType,
      target_id:    targetId,
      details:      details
    });
  } catch (error) {
    console.error('Activity logging error:', error);
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/ready', async (req, res) => {
  try {
    await db.raw('SELECT 1');
    dbReady = true;
    const igdbConfigured = !!(
      process.env.IGDB_CLIENT_ID &&
      (process.env.IGDB_CLIENT_SECRET || process.env.IGDB_ACCESS_TOKEN)
    );
    res.json({
      status: 'ready',
      db: true,
      igdb: igdbConfigured,
      rateLimitStore: authStore || igdbStore ? 'redis' : 'memory'
    });
  } catch (error) {
    dbReady = false;
    res.status(503).json({ status: 'not_ready', db: false });
  }
});

console.log('Loading routes...');

try {
  const authRoutes = require('./auth');
  app.use('/api/auth', authLimiter, authRoutes(db, jwt, JWT_SECRET, verifyToken, checkBanned));
  console.log('  Auth routes loaded');
} catch (error) {
  console.error('  Error loading auth routes:', error.message);
  process.exit(1);
}

try {
  const homeRoutes = require('./home');
  app.use('/api', homeRoutes(db));
  console.log('  Home routes loaded');
} catch (error) {
  console.error('  Error loading home routes:', error.message);
  process.exit(1);
}

try {
  const profileRoutes = require('./profile');
  app.use('/api/user', profileRoutes(db, verifyToken, checkBanned));
  console.log('  Profile routes loaded');
} catch (error) {
  console.error('  Error loading profile routes:', error.message);
  process.exit(1);
}

try {
  const myGameListRoutes = require('./myGameList');
  app.use('/api/user', myGameListRoutes(db, verifyToken, checkBanned));
  console.log('  MyGameList routes loaded');
} catch (error) {
  console.error('  Error loading myGameList routes:', error.message);
  process.exit(1);
}

try {
  const friendsRoutes = require('./friends');
  app.use('/api', friendsRoutes(db, verifyToken, checkBanned));
  console.log('  Friends routes loaded');
} catch (error) {
  console.error('  Error loading friends routes:', error.message);
  process.exit(1);
}

try {
  const userProfileRoutes = require('./userProfile');
  app.use('/api/users', userProfileRoutes(db, verifyToken, checkBanned));
  console.log('  UserProfile routes loaded');
} catch (error) {
  console.error('  Error loading userProfile routes:', error.message);
  process.exit(1);
}

try {
  const adminRoutes = require('./admin');
  app.use('/api/admin', adminRoutes(db, verifyToken, verifyModerator, verifyAdmin, logModeratorActivity));
  console.log('  Admin routes loaded');
} catch (error) {
  console.error('  Error loading admin routes:', error.message);
  process.exit(1);
}

try {
  const moderatorRoutes = require('./moderator');
  app.use('/api/moderator', moderatorRoutes(db, verifyToken, verifyModerator, logModeratorActivity));
  console.log('  Moderator routes loaded');
} catch (error) {
  console.error('  Error loading moderator routes:', error.message);
  process.exit(1);
}

try {
  const igdbRoutes = require('./igdb');
  app.use('/api/igdb', igdbLimiter, igdbRoutes(optionalAuth, passThrough, db));
  console.log('  IGDB proxy routes loaded');
} catch (error) {
  console.error('  Error loading IGDB proxy routes:', error.message);
  process.exit(1);
}

try {
  const tmdbRoutes = require('./tmdb');
  app.use('/api/tmdb', igdbLimiter, tmdbRoutes(optionalAuth, passThrough, db));
  console.log('  TMDB proxy routes loaded');
} catch (error) {
  console.error('  Error loading TMDB proxy routes:', error.message);
  process.exit(1);
}

// Compatibility aliases for external clients (/api remains for this app).
try {
  const authRoutes = require('./auth');
  const homeRoutes = require('./home');
  const profileRoutes = require('./profile');
  const myGameListRoutes = require('./myGameList');
  const friendsRoutes = require('./friends');
  const userProfileRoutes = require('./userProfile');
  const adminRoutes = require('./admin');
  const moderatorRoutes = require('./moderator');
  const igdbRoutes = require('./igdb');
  const tmdbRoutes = require('./tmdb');

  app.use('/api/v1/auth', authLimiter, authRoutes(db, jwt, JWT_SECRET, verifyToken, checkBanned));
  app.use('/api/v1', homeRoutes(db));
  app.use('/api/v1/user', profileRoutes(db, verifyToken, checkBanned));
  app.use('/api/v1/user', myGameListRoutes(db, verifyToken, checkBanned));
  app.use('/api/v1', friendsRoutes(db, verifyToken, checkBanned));
  app.use('/api/v1/users', userProfileRoutes(db, verifyToken, checkBanned));
  app.use('/api/v1/admin', adminRoutes(db, verifyToken, verifyModerator, verifyAdmin, logModeratorActivity));
  app.use('/api/v1/moderator', moderatorRoutes(db, verifyToken, verifyModerator, logModeratorActivity));
  app.use('/api/v1/igdb', igdbLimiter, igdbRoutes(optionalAuth, passThrough, db));
  app.use('/api/v1/tmdb', igdbLimiter, tmdbRoutes(optionalAuth, passThrough, db));
  console.log('  /api/v1 aliases loaded');
} catch (error) {
  console.error('  Error loading /api/v1 aliases:', error.message);
}

console.log('All routes loaded\n');

const frontendPath = path.join(__dirname, '..', 'Frontend');
app.use(express.static(frontendPath, {
  etag: false,
  lastModified: true,
  maxAge: 0,
  setHeaders(res, filePath) {
    const name = path.basename(filePath).toLowerCase();
    // Avoid stale JS/HTML during local iteration (was causing old home.js + API 304 bugs).
    if (/\.(?:js|css|html?)$/i.test(name)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (/\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$/i.test(name)) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  }
}));

app.get('/', (req, res) => res.sendFile(path.join(frontendPath, 'home.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(frontendPath, 'home.html')));
app.get('/auth.html', (req, res) => res.sendFile(path.join(frontendPath, 'auth.html')));
app.get('/home.html', (req, res) => res.sendFile(path.join(frontendPath, 'home.html')));
app.get('/movies.html', (req, res) => res.sendFile(path.join(frontendPath, 'movies.html')));
app.get('/series.html', (req, res) => res.sendFile(path.join(frontendPath, 'series.html')));
app.get('/profile.html', (req, res) => res.sendFile(path.join(frontendPath, 'profile.html')));
app.get('/myGameList.html', (req, res) => res.sendFile(path.join(frontendPath, 'myGameList.html')));
app.get('/friends.html', (req, res) => res.sendFile(path.join(frontendPath, 'friends.html')));
app.get('/userProfile.html', (req, res) => res.sendFile(path.join(frontendPath, 'userProfile.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(frontendPath, 'admin.html')));
app.get('/moderator.html', (req, res) => res.sendFile(path.join(frontendPath, 'moderator.html')));
app.get('/terms.html', (req, res) => res.sendFile(path.join(frontendPath, 'terms.html')));
app.get('/privacy.html', (req, res) => res.sendFile(path.join(frontendPath, 'privacy.html')));
app.get('/robots.txt', (req, res) => res.sendFile(path.join(frontendPath, 'robots.txt')));

app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'CORS blocked' });
  }
  return clientError(res, 500, 'Something went wrong!', err);
});

app.use((req, res) => {
  const accept = String(req.headers.accept || '');
  if (req.method === 'GET' && accept.includes('text/html')) {
    return res.status(404).sendFile(path.join(frontendPath, '404.html'));
  }
  res.status(404).json({ error: 'Route not found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});