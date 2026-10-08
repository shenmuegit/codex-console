import { randomBytes, randomUUID, scrypt as nativeScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(nativeScrypt);
const TTL = 12 * 60 * 60 * 1000;
const fail = (code, message) => Object.assign(new Error(message), { code });
const validPassword = password => typeof password === 'string' && password.length > 0 && password.length <= 256;

export function checkOrigin(actual, expected) {
  if (actual !== expected) throw fail('ORIGIN_DENIED', '页面来源不匹配，请使用配置中的地址。');
}

export async function hashPassword(password) {
  if (!validPassword(password)) throw fail('INVALID_PASSWORD', '密码长度须为 1–256 个字符。');
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt:${salt.toString('base64')}:${key.toString('base64')}`;
}

export function createAuth({ passwordHash, now = Date.now }) {
  const [kind, saltText, keyText, extra] = String(passwordHash).split(':');
  const salt = Buffer.from(saltText ?? '', 'base64'), expected = Buffer.from(keyText ?? '', 'base64');
  if (kind !== 'scrypt' || extra || salt.length !== 16 || expected.length !== 64 ||
      salt.toString('base64') !== saltText || expected.toString('base64') !== keyText) {
    throw fail('INVALID_PASSWORD_HASH', '请先初始化登录配置。');
  }
  const sessions = new Map(), failures = new Map();
  let checking = 0;
  return {
    async login(password, ip) {
      const time = now();
      for (const [key, value] of failures) if (value.until <= time) failures.delete(key);
      for (const [token, session] of sessions) if (session.expiresAt <= time) sessions.delete(token);
      let attempts = failures.get(ip);
      if (attempts?.count >= 5 || checking >= 4 || (!attempts && failures.size >= 1024) || sessions.size >= 1024) {
        throw fail('LOGIN_THROTTLED', '尝试过于频繁，请稍后重试。');
      }
      if (!attempts) failures.set(ip, attempts = { count: 0, until: time + 60_000 });
      // Count before awaiting, so simultaneous guesses cannot bypass the limit.
      ++attempts.count;
      let matches = false;
      if (validPassword(password)) {
        ++checking;
        try { matches = timingSafeEqual(await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }), expected); }
        finally { --checking; }
      }
      if (!matches) throw fail('LOGIN_DENIED', '密码不正确。');
      failures.delete(ip);
      const token = randomBytes(32).toString('base64url'), expiresAt = now() + TTL;
      sessions.set(token, { id: randomUUID(), expiresAt });
      return { token, expiresAt };
    },
    verifySession(token) {
      const session = sessions.get(token);
      if (!session || session.expiresAt <= now()) { sessions.delete(token); return null; }
      return session;
    },
    revoke(token) { sessions.delete(token); },
  };
}
