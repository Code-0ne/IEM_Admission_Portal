import crypto from 'crypto';
import bcrypt from 'bcrypt';
import config from '../../config.js';
import {
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  TooManyRequestsError,
  ConflictError,
  NotFoundError,
} from '../../errors.js';
import { createSupabaseAuthClient, getSupabaseClient } from '../../db/supabase.js';

// Salt rounds for password hashing
const SALT_ROUNDS = 10;

// In-memory data store for testing and when Supabase credentials are not configured
const inMemoryStore = {
  users: new Map(), // id -> user
  usersByEmail: new Map(), // email -> id
  usersByPhone: new Map(), // countryCode+mobile -> id
  otps: new Map(), // id -> otp
  sessions: new Map(), // token_hash -> session
  auditLogs: [],
};

// Reset in-memory store helper (useful for isolated unit/integration tests)
export function resetAuthStore() {
  inMemoryStore.users.clear();
  inMemoryStore.usersByEmail.clear();
  inMemoryStore.usersByPhone.clear();
  inMemoryStore.otps.clear();
  inMemoryStore.sessions.clear();
  inMemoryStore.auditLogs = [];
}

/**
 * Set user role in in-memory store (for testing/seeding)
 */
export function setInMemoryUserRole(userId, role) {
  const user = inMemoryStore.users.get(userId);
  if (user) {
    user.role = role;
  }
}

/**
 * Hash an OTP code with token secret
 */
export function hashOtp(otpCode) {
  return crypto
    .createHash('sha256')
    .update(`${otpCode}:${config.auth.tokenSecret}`)
    .digest('hex');
}

/**
 * Hash a session token with token secret
 */
export function hashSessionToken(token) {
  return crypto
    .createHash('sha256')
    .update(`${token}:${config.auth.tokenSecret}`)
    .digest('hex');
}

/**
 * Generate a 6-digit numeric OTP string
 */
export function generateOtpCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Sanitize user object to never leak password_hash
 */
export function sanitizeUser(user) {
  if (!user) return null;
  const { password_hash, passwordHash, ...safeUser } = user;
  return {
    id: safeUser.id,
    fullName: safeUser.full_name || safeUser.fullName,
    email: safeUser.email,
    countryCode: safeUser.country_code || safeUser.countryCode || '+91',
    mobile: safeUser.mobile,
    role: safeUser.role || 'applicant',
    isVerified: Boolean(safeUser.is_verified ?? safeUser.isVerified),
    consent: Boolean(safeUser.consent),
    createdAt: safeUser.created_at || safeUser.createdAt,
    updatedAt: safeUser.updated_at || safeUser.updatedAt,
  };
}

function assertLoginRole(user, requiredRole) {
  if ((user.role || 'applicant') === requiredRole) return;

  const message = requiredRole === 'admin'
    ? 'This account does not have administrator access.'
    : 'Administrator accounts must sign in through the admin portal.';
  throw new ForbiddenError(message);
}

export class AuthService {
  async createSession(client, user) {
    const now = new Date();
    const rawSessionToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashSessionToken(rawSessionToken);
    const { data: session, error } = await client
      .from('sessions')
      .insert({
        user_id: user.id,
        token_hash: tokenHash,
        expires_at: new Date(now.getTime() + config.auth.sessionMaxAgeMs).toISOString(),
      })
      .select()
      .single();

    if (error) {
      throw new BadRequestError(`Account created, but a session could not be created: ${error.message}`);
    }

    return { token: rawSessionToken, user: sanitizeUser(user), session };
  }

  /**
   * Register a new applicant
   */
  async register({ fullName, email, mobile, countryCode = '+91', password, consent }) {
    const normalizedEmail = email.trim().toLowerCase();
    const cleanMobile = mobile.trim();
    const cleanCountryCode = countryCode.trim();

    const client = getSupabaseClient();

    if (client) {
      // Check existing email
      const { data: existingEmail } = await client
        .from('users')
        .select('id')
        .eq('email', normalizedEmail)
        .maybeSingle();

      if (existingEmail) {
        throw new ConflictError('An account with this email address already exists');
      }

      // Check existing phone
      const { data: existingPhone } = await client
        .from('users')
        .select('id')
        .eq('country_code', cleanCountryCode)
        .eq('mobile', cleanMobile)
        .maybeSingle();

      if (existingPhone) {
        throw new ConflictError('An account with this mobile number already exists');
      }

      if (!config.supabase.serviceRoleKey) {
        throw new BadRequestError('Supabase service-role credentials are required to create accounts.');
      }

      const authClient = createSupabaseAuthClient();
      if (!authClient) {
        throw new BadRequestError('Supabase Auth is not configured.');
      }

      const { data: authResult, error: authError } = await authClient.auth.signUp({
        email: normalizedEmail,
        password,
        user_metadata: { full_name: fullName.trim() },
      });

      if (authError || !authResult?.user) {
        throw new BadRequestError(`Registration failed: ${authError?.message || 'Supabase Auth did not create the account.'}`);
      }
      if (authResult.user.identities?.length === 0) {
        throw new ConflictError('An account with this email address already exists');
      }
      if (!authResult.session && !authResult.user.email_confirmed_at) {
        const { error: deleteError } = await client.auth.admin.deleteUser(authResult.user.id);
        if (deleteError) {
          console.error('Could not remove a signup requiring email confirmation:', deleteError.message);
        }
        throw new BadRequestError('Email confirmation is enabled in Supabase. Disable it to allow account registration without email verification.');
      }

      const { data: newUser, error: insertError } = await client
        .from('users')
        .insert({
          auth_user_id: authResult.user.id,
          full_name: fullName.trim(),
          email: normalizedEmail,
          country_code: cleanCountryCode,
          mobile: cleanMobile,
          role: 'applicant', // Force default role
          is_verified: true,
          consent: Boolean(consent),
        })
        .select()
        .single();

      if (insertError) {
        const { error: rollbackError } = await client.auth.admin.deleteUser(authResult.user.id);
        if (rollbackError) {
          console.error('Failed to remove Supabase Auth user after registration error:', rollbackError.message);
        }
        throw new BadRequestError(`Registration failed: ${insertError.message}`);
      }

      const session = await this.createSession(client, newUser);
      return { user: session.user, token: session.token };
    }

    // --- In-memory Store Fallback ---
    if (inMemoryStore.usersByEmail.has(normalizedEmail)) {
      throw new ConflictError('An account with this email address already exists');
    }
    const phoneKey = `${cleanCountryCode}:${cleanMobile}`;
    if (inMemoryStore.usersByPhone.has(phoneKey)) {
      throw new ConflictError('An account with this mobile number already exists');
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const userId = crypto.randomUUID();
    const now = new Date().toISOString();

    const newUser = {
      id: userId,
      full_name: fullName.trim(),
      email: normalizedEmail,
      country_code: cleanCountryCode,
      mobile: cleanMobile,
      password_hash: passwordHash,
      role: 'applicant',
      is_verified: true,
      failed_login_attempts: 0,
      locked_until: null,
      consent: Boolean(consent),
      created_at: now,
      updated_at: now,
    };

    inMemoryStore.users.set(userId, newUser);
    inMemoryStore.usersByEmail.set(normalizedEmail, userId);
    inMemoryStore.usersByPhone.set(phoneKey, userId);

    const session = await this.login({ identifier: normalizedEmail, password });
    return { user: session.user, token: session.token };
  }

  /**
   * Authenticate user with email or mobile + password
   */
  async login({ identifier, password, requiredRole = 'applicant' }) {
    if (!identifier || !password) {
      throw new BadRequestError('Email/mobile and password are required');
    }

    const cleanId = identifier.trim();
    const isEmail = cleanId.includes('@');
    const now = new Date();

    const client = getSupabaseClient();

    if (client) {
      const query = client.from('users').select('*');
      if (isEmail) {
        query.eq('email', cleanId.toLowerCase());
      } else {
        query.eq('mobile', cleanId);
      }
      const { data: user } = await query.maybeSingle();

      if (!user) {
        throw new UnauthorizedError('Invalid email/mobile or password');
      }
      // Lockout check
      if (user.locked_until && new Date(user.locked_until) > now) {
        const remainingMinutes = Math.ceil((new Date(user.locked_until).getTime() - now.getTime()) / 60000);
        throw new TooManyRequestsError(
          `Account is temporarily locked due to 5 consecutive failed attempts. Please try again after ${remainingMinutes} minute(s).`
        );
      }

      if (!user.auth_user_id) {
        throw new UnauthorizedError('Account setup is incomplete. Please contact admissions support.');
      }

      const authClient = createSupabaseAuthClient();
      if (!authClient) {
        throw new BadRequestError('Supabase Auth is not configured.');
      }

      const { data: authResult, error: authError } = await authClient.auth.signInWithPassword({
        email: user.email,
        password,
      });
      if (authError || authResult?.user?.id !== user.auth_user_id) {
        const nextAttempts = (user.failed_login_attempts || 0) + 1;
        const updates = { failed_login_attempts: nextAttempts };

        if (nextAttempts >= config.auth.lockoutAttempts) {
          updates.locked_until = new Date(now.getTime() + config.auth.lockoutDurationMinutes * 60 * 1000).toISOString();
        }

        const { error: updateError } = await client.from('users').update(updates).eq('id', user.id);
        if (updateError) {
          console.error('Failed to update failed-login counter:', updateError.message);
        }
        throw new UnauthorizedError('Invalid email/mobile or password');
      }

      assertLoginRole(user, requiredRole);

      // Reset login counters on success
      const { error: counterError } = await client
        .from('users')
        .update({
          failed_login_attempts: 0,
          locked_until: null,
          is_verified: true,
          updated_at: now.toISOString(),
        })
        .eq('id', user.id);
      if (counterError) {
        throw new BadRequestError(`Could not reset login counters: ${counterError.message}`);
      }

      // Create session
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashSessionToken(rawToken);
      const sessionExpiry = new Date(now.getTime() + config.auth.sessionMaxAgeMs).toISOString();

      const { error: sessionError } = await client.from('sessions').insert({
        user_id: user.id,
        token_hash: tokenHash,
        expires_at: sessionExpiry,
      });
      if (sessionError) {
        throw new BadRequestError(`Could not create session: ${sessionError.message}`);
      }

      return {
        token: rawToken,
        user: sanitizeUser(user),
      };
    }

    // In-memory fallback
    let user = null;
    if (isEmail) {
      const uid = inMemoryStore.usersByEmail.get(cleanId.toLowerCase());
      if (uid) user = inMemoryStore.users.get(uid);
    } else {
      // Find by mobile
      for (const u of inMemoryStore.users.values()) {
        if (u.mobile === cleanId) {
          user = u;
          break;
        }
      }
    }

    if (!user) {
      throw new UnauthorizedError('Invalid email/mobile or password');
    }
    // Check lockout
    if (user.locked_until && new Date(user.locked_until) > now) {
      const remainingMinutes = Math.ceil((new Date(user.locked_until).getTime() - now.getTime()) / 60000);
      throw new TooManyRequestsError(
        `Account is temporarily locked due to 5 consecutive failed attempts. Please try again after ${remainingMinutes} minute(s).`
      );
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      user.failed_login_attempts = (user.failed_login_attempts || 0) + 1;
      if (user.failed_login_attempts >= config.auth.lockoutAttempts) {
        user.locked_until = new Date(now.getTime() + config.auth.lockoutDurationMinutes * 60 * 1000).toISOString();
      }
      throw new UnauthorizedError('Invalid email/mobile or password');
    }

    assertLoginRole(user, requiredRole);

    // Successful login: reset counters
    user.failed_login_attempts = 0;
    user.locked_until = null;
    user.updated_at = now.toISOString();

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashSessionToken(rawToken);
    const sessionExpiry = new Date(now.getTime() + config.auth.sessionMaxAgeMs).toISOString();

    inMemoryStore.sessions.set(tokenHash, {
      id: crypto.randomUUID(),
      user_id: user.id,
      token_hash: tokenHash,
      expires_at: sessionExpiry,
      created_at: now.toISOString(),
    });

    return {
      token: rawToken,
      user: sanitizeUser(user),
    };
  }

  /**
   * Terminate active session immediately (FR3)
   */
  async logout(token) {
    if (!token) return { success: true };

    const tokenHash = hashSessionToken(token);
    const client = getSupabaseClient();

    if (client) {
      await client.from('sessions').delete().eq('token_hash', tokenHash);
      return { success: true };
    }

    // In-memory fallback
    inMemoryStore.sessions.delete(tokenHash);
    return { success: true };
  }

  /**
   * Validate session token from cookie/header and return authenticated user
   */
  async validateSession(token) {
    if (!token) return null;

    const tokenHash = hashSessionToken(token);
    const now = new Date();
    const client = getSupabaseClient();

    if (client) {
      const { data: session } = await client
        .from('sessions')
        .select('*')
        .eq('token_hash', tokenHash)
        .gt('expires_at', now.toISOString())
        .maybeSingle();

      if (!session) return null;

      const { data: user } = await client
        .from('users')
        .select('*')
        .eq('id', session.user_id)
        .maybeSingle();

      if (!user) return null;

      return {
        user: sanitizeUser(user),
        session,
      };
    }

    // In-memory fallback
    const session = inMemoryStore.sessions.get(tokenHash);
    if (!session || new Date(session.expires_at) <= now) {
      if (session) inMemoryStore.sessions.delete(tokenHash);
      return null;
    }

    const user = inMemoryStore.users.get(session.user_id);
    if (!user) return null;

    return {
      user: sanitizeUser(user),
      session,
    };
  }

  /**
   * Forgot password: send 15-minute reset OTP
   */
  async forgotPassword({ email }) {
    if (!email) {
      throw new BadRequestError('Email address is required');
    }

    const normalizedEmail = email.trim().toLowerCase();
    const client = getSupabaseClient();
    if (client) {
      const authClient = createSupabaseAuthClient();
      if (!authClient) {
        throw new BadRequestError('Supabase Auth is not configured.');
      }

      const { error } = await authClient.auth.resetPasswordForEmail(normalizedEmail, {
        redirectTo: new URL('/reset-password', config.clientOrigin).toString(),
      });
      if (error) {
        throw new BadRequestError(`Could not request password reset: ${error.message}`);
      }

      return {
        success: true,
        message: 'If an account exists with this email, a password reset link has been sent.',
      };
    }

    const otpCode = generateOtpCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    // In-memory fallback
    const userId = inMemoryStore.usersByEmail.get(normalizedEmail);
    if (!userId) {
      return {
        success: true,
        message: 'If an account exists with this email, a password reset code has been sent.',
      };
    }

    // Invalidate old
    for (const [id, o] of inMemoryStore.otps.entries()) {
      if (o.user_id === userId && o.purpose === 'password_reset') {
        inMemoryStore.otps.delete(id);
      }
    }

    const otpId = crypto.randomUUID();
    inMemoryStore.otps.set(otpId, {
      id: otpId,
      user_id: userId,
      otp_hash: hashOtp(otpCode),
      purpose: 'password_reset',
      attempts: 0,
      expires_at: expiresAt,
      created_at: now,
    });

    return {
      success: true,
      message: 'If an account exists with this email, a password reset code has been sent.',
      otpCode: config.nodeEnv === 'development' || config.nodeEnv === 'test' ? otpCode : undefined,
    };
  }

  /**
   * Reset password with OTP and revoke all existing sessions
   */
  async resetPassword({ accessToken, email, otp, newPassword }) {
    if (!newPassword) {
      throw new BadRequestError('New password is required');
    }

    const client = getSupabaseClient();
    if (client) {
      if (!accessToken) {
        throw new BadRequestError('Password reset authorization is required');
      }

      const authClient = createSupabaseAuthClient();
      if (!authClient) {
        throw new BadRequestError('Supabase Auth is not configured.');
      }
      if (!config.supabase.serviceRoleKey) {
        throw new BadRequestError('Supabase service-role credentials are required to reset passwords.');
      }

      const { data: authResult, error: authError } = await authClient.auth.getUser(accessToken);
      if (authError || !authResult.user) {
        throw new BadRequestError('Password reset link is invalid or has expired. Request a new link.');
      }

      const { data: user, error: lookupError } = await client
        .from('users')
        .select('id')
        .eq('auth_user_id', authResult.user.id)
        .maybeSingle();
      if (lookupError) {
        throw new BadRequestError(`Could not load the account for password reset: ${lookupError.message}`);
      }
      if (!user) {
        throw new NotFoundError('No application account is linked to this Supabase Auth user.');
      }

      const { error: passwordError } = await client.auth.admin.updateUserById(authResult.user.id, {
        password: newPassword,
      });
      if (passwordError) {
        throw new BadRequestError(`Could not update password: ${passwordError.message}`);
      }

      const { error: sessionsError } = await client.from('sessions').delete().eq('user_id', user.id);
      if (sessionsError) {
        throw new BadRequestError(`Password changed, but existing sessions could not be revoked: ${sessionsError.message}`);
      }

      const { error: profileError } = await client
        .from('users')
        .update({
          failed_login_attempts: 0,
          locked_until: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', user.id);
      if (profileError) {
        throw new BadRequestError(`Password changed, but account login status could not be reset: ${profileError.message}`);
      }

      return { success: true, message: 'Password has been reset successfully. Please log in.' };
    }

    // In-memory fallback
    if (!email || !otp) {
      throw new BadRequestError('Email, reset code, and new password are required');
    }

    const normalizedEmail = email.trim().toLowerCase();
    const cleanOtp = otp.trim();
    const expectedHash = hashOtp(cleanOtp);
    const now = new Date();
    const userId = inMemoryStore.usersByEmail.get(normalizedEmail);
    if (!userId) {
      throw new NotFoundError('User not found');
    }

    const user = inMemoryStore.users.get(userId);
    const matchingOtp = Array.from(inMemoryStore.otps.values())
      .filter((o) => o.user_id === userId && o.purpose === 'password_reset' && new Date(o.expires_at) > now)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

    if (!matchingOtp) {
      throw new BadRequestError('Reset code has expired or does not exist');
    }

    if (matchingOtp.attempts >= 5) {
      throw new BadRequestError('Too many invalid attempts. Please request a new reset code.');
    }

    if (matchingOtp.otp_hash !== expectedHash) {
      matchingOtp.attempts += 1;
      throw new BadRequestError('Invalid reset code');
    }

    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    user.password_hash = passwordHash;
    user.failed_login_attempts = 0;
    user.locked_until = null;
    user.updated_at = now.toISOString();

    // Revoke all sessions
    for (const [tokenHash, session] of inMemoryStore.sessions.entries()) {
      if (session.user_id === userId) {
        inMemoryStore.sessions.delete(tokenHash);
      }
    }

    inMemoryStore.otps.delete(matchingOtp.id);

    return { success: true, message: 'Password has been reset successfully. Please log in.' };
  }
}

export const authService = new AuthService();
export default authService;
