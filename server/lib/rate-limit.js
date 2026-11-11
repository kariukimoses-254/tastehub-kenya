/**
 * Small in-memory rate limiter suitable for a single server process.
 * For a multi-instance deployment, replace the store with Redis or a gateway
 * level limiter.
 */
function createRateLimiter({
  windowMs = 15 * 60 * 1000,
  max = 60,
  keyGenerator = (req) => req.ip,
  message = 'Too many requests. Please wait and try again.',
} = {}) {
  const hits = new Map();

  function prune(now) {
    for (const [key, timestamps] of hits) {
      const recent = timestamps.filter((time) => now - time < windowMs);
      if (recent.length) hits.set(key, recent);
      else hits.delete(key);
    }
  }

  function middleware(req, res, next) {
    const now = Date.now();
    if (hits.size > 5000) prune(now);
    const key = keyGenerator(req) || req.ip || 'unknown';
    const timestamps = (hits.get(key) || []).filter((time) => now - time < windowMs);
    if (timestamps.length >= max) {
      const retryAfter = Math.max(1, Math.ceil((timestamps[0] + windowMs - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message });
    }
    timestamps.push(now);
    hits.set(key, timestamps);
    return next();
  }

  middleware.reset = () => hits.clear();
  return middleware;
}

module.exports = { createRateLimiter };
