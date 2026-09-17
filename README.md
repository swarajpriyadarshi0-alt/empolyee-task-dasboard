# Employee Task Dashboard

A small-company employee task manager with a Node.js API, Supabase (Postgres) storage, hashed passwords, signed cookie sessions, and a responsive browser dashboard. No npm dependencies.

## Run locally

```bash
npm start
```

Open `http://localhost:3000`.

Without Supabase settings the server stores data in a local `data.json` file. This is fine for testing on your own computer but **not** for hosting: hosts like Render wipe the disk on every restart, so data would disappear.

Demo accounts:

- Manager: `admin` / `admin123`
- Matrix IT Support admin: `matrix` / `matrix1234`
- Employees: `SP001`, `UT002`, `AS003`, `SR004`, `GE005`, `PR006`, `SI007`, `PR008`, `RI009`, `CH010`, `NA011`, `NE012`, `KA013`, `DE014` / `employee123`

These are temporary demo credentials. Change the passwords from the account menu after signing in.

## Hosting on Render with Supabase (one-time setup)

### 1. Create the Supabase table

In your Supabase project open **SQL Editor** and run:

```sql
create table if not exists app_state (
  id integer primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
```

### 2. Get the keys

In Supabase go to **Project Settings → API** and copy:

- **Project URL** (looks like `https://abcdefgh.supabase.co`)
- **service_role** key (under "Project API keys" – keep this secret, never put it in the browser or in git)

### 3. Set environment variables in Render

In your Render service open **Environment** and add:

| Key | Value |
| --- | --- |
| `SUPABASE_URL` | the Project URL from step 2 |
| `SUPABASE_SERVICE_ROLE_KEY` | the service_role key from step 2 |
| `SESSION_SECRET` | any long random text (e.g. run `openssl rand -hex 32`) |
| `NODE_ENV` | `production` |

Save. Render redeploys automatically. The first start creates the demo users and branches in Supabase.

### How it works

The whole database is kept in memory while the server runs and written to the `app_state` row in Supabase after every change. On start, it is loaded back from Supabase. Sessions are signed cookies, so logins survive restarts and Render's free-tier sleep.

Limits to know about: the app is meant for one server instance. If two managers save at the exact same moment the later save wins. For a small team this is fine.
