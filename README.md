# IEM Admissions

An admissions portal with a Vite/React frontend and an Express API.

## Requirements

- Node.js and npm
- Windows PowerShell (the all-in-one launcher is `run-all.ps1`)
- Supabase credentials for persistent database-backed operation
- MongoDB is used for uploaded document storage

## Quick start

1. Install dependencies from the project root:

   ```powershell
   npm install --prefix .\server
   npm install --prefix .\client
   ```

2. Create `server\.env` from the template and fill in the credentials needed for your setup:

   ```powershell
   Copy-Item .\server\.env.example .\server\.env
   ```

   Do not commit or share `server\.env`. The example file lists the available Supabase, MongoDB, session, email, payment-gateway, and LLM settings.

3. From the project root, run the API and frontend with one command:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\run-all.ps1
   ```

   This opens a separate terminal for each service. Stop each server with **Ctrl+C** in its terminal. The launcher checks required ports first and will report if one is occupied.

## Local URLs

| Service | URL |
|---|---|
| Frontend | <http://localhost:5175> |
| API health | <http://localhost:5000/api/health> |

The frontend proxies `/api` requests to the API on port `5000`.

## Running services individually

Run each command from the project root in its own terminal:

```powershell
npm run dev --prefix .\server
npm run dev --prefix .\client
```

## Tests and production builds

```powershell
npm test --prefix .\server
npm run build --prefix .\client
```

## Database setup

Database migrations are in `server\src\db\migrations`. Apply the numbered SQL files in order through the target Supabase SQL Editor. `npm run migrate --prefix .\server` checks and loads the migration SQL for the application; it does not execute DDL against Supabase. The API can use an in-memory fallback for local/test operation, but that data is not persistent.

Authentication uses Supabase Auth for password verification and password-reset email. Disable email confirmations in Supabase **Authentication → Providers → Email** to let new users register and sign in without email verification. Configure email delivery in Supabase **Authentication → SMTP Settings**; SMTP credentials are not stored in the application `.env`.

After applying the migrations, run `npm run migrate:auth-users --prefix .\server` once to link existing application profiles to Supabase Auth; existing applicants will need to use **Forgot password** to set a new password. Configure the application URL and `/reset-password` redirect URL in Supabase **Authentication → URL Configuration**.

Keep `SUPABASE_SECRET_KEY` server-side only. The publishable key is used for public Auth operations; the secret key is used by the API to manage Auth accounts.

## Payment note

The current **Pay now** action is a development-only simulated payment. It records a demo receipt and updates an approved application, but does not transfer money or connect to a real payment gateway. Configure and implement server-side gateway verification before accepting real payments.

## Account registration

New accounts can sign in immediately after registration. Password recovery uses a Supabase Auth email link.
