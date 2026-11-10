import crypto from 'node:crypto';
import config from '../config.js';
import { getSupabaseClient } from '../db/supabase.js';

async function findAuthUserByEmail(client, email) {
  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) {
      throw new Error(`Could not check Supabase Auth users: ${error.message}`);
    }

    const user = data.users.find((candidate) => candidate.email?.toLowerCase() === email);
    if (user) return user;
    if (data.users.length < 1000) return null;
  }

  throw new Error('Stopped while searching Supabase Auth users after 100 pages.');
}

export async function migrateAuthUsers() {
  if (!config.supabase.serviceRoleKey) {
    throw new Error('SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY is required.');
  }

  const client = getSupabaseClient();
  if (!client) {
    throw new Error('Supabase is not configured.');
  }

  const adminEmail = (process.env.ADMIN_SEED_EMAIL || '').trim().toLowerCase();
  const adminPassword = process.env.ADMIN_SEED_PASSWORD || '';
  if (!adminPassword || adminPassword.length < 6) {
    throw new Error('ADMIN_SEED_PASSWORD must be at least 6 characters to create the configured admin in Supabase Auth.');
  }

  let migratedCount = 0;
  let alreadyLinkedCount = 0;

  for (let offset = 0; ; offset += 500) {
    const { data: users, error: lookupError } = await client
      .from('users')
      .select('id, email, full_name, auth_user_id')
      .order('created_at', { ascending: true })
      .range(offset, offset + 499);

    if (lookupError) {
      throw new Error(`Could not load application users: ${lookupError.message}`);
    }
    if (users.length === 0) break;

    for (const profile of users) {
      const email = profile.email.trim().toLowerCase();
      const isConfiguredAdmin = Boolean(adminEmail && email === adminEmail);
      if (isConfiguredAdmin && !adminPassword) {
        throw new Error('ADMIN_SEED_PASSWORD is required to provision the configured admin account.');
      }

      const isAlreadyLinked = Boolean(profile.auth_user_id);
      let authUser = isAlreadyLinked
        ? { id: profile.auth_user_id }
        : await findAuthUserByEmail(client, email);

      if (authUser) {
        if (isConfiguredAdmin || !isAlreadyLinked) {
          const password = isConfiguredAdmin
            ? adminPassword
            : crypto.randomBytes(32).toString('base64url');
          const { data, error } = await client.auth.admin.updateUserById(authUser.id, {
            password,
            email_confirm: true,
            user_metadata: { full_name: profile.full_name },
          });
          if (error) {
            throw new Error(`Could not update a Supabase Auth account: ${error.message}`);
          }
          authUser = data.user;
        }
      } else {
        const password = isConfiguredAdmin
          ? adminPassword
          : crypto.randomBytes(32).toString('base64url');
        const { data, error } = await client.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { full_name: profile.full_name },
        });
        if (error || !data.user) {
          throw new Error(`Could not create a Supabase Auth account: ${error?.message || 'No user returned.'}`);
        }
        authUser = data.user;
      }

      const { error: updateError } = await client
        .from('users')
        .update({
          auth_user_id: authUser.id,
          password_hash: null,
        })
        .eq('id', profile.id);

      if (updateError) {
        throw new Error(`Could not link Supabase Auth account to application profile: ${updateError.message}`);
      }

      if (isAlreadyLinked) alreadyLinkedCount += 1;
      else migratedCount += 1;
    }

    if (users.length < 500) break;
  }

  console.log(`Supabase Auth account migration complete: linked=${migratedCount}, already_linked=${alreadyLinkedCount}`);
  console.log('Existing applicants must use Forgot password to set a new password.');
}

if (process.argv[1]?.endsWith('migrate-auth-users.js')) {
  migrateAuthUsers().catch((error) => {
    console.error('Supabase Auth account migration failed:', error.message);
    process.exitCode = 1;
  });
}
