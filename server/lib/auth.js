const jwt = require('jsonwebtoken');
const { HttpError } = require('./errors');

function createAuth({ secret, expiresIn = '8h' }) {
  function sign(user) {
    return jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        branch: user.branch_name || null,
      },
      secret,
      { expiresIn }
    );
  }

  function tokenFromRequest(req) {
    const header = req.headers.authorization || '';
    const token = header.replace(/^Bearer\s+/i, '').trim();
    if (!token) throw new HttpError(401, 'Please sign in');
    return token;
  }

  function verifyRequest(req) {
    try {
      return jwt.verify(tokenFromRequest(req), secret);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(401, 'Your session is invalid or has expired. Please sign in again.');
    }
  }

  /**
   * Require a signed-in user with one of the supplied roles.
   * An empty role list means "any signed-in user".
   */
  function requireRole(...roles) {
    return function authenticate(req, res, next) {
      try {
        const payload = verifyRequest(req);
        if (roles.length && !roles.includes(payload.role)) {
          throw new HttpError(403, 'Insufficient permissions');
        }
        req.user = payload;
        return next();
      } catch (error) {
        return next(error);
      }
    };
  }

  return { sign, verifyRequest, requireRole };
}

module.exports = { createAuth };
