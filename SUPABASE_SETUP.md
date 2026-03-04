# Supabase Setup

1. Open your Supabase project and run this SQL in SQL Editor:

```sql
create table if not exists public.app_state (
id text primary key,
thoughts jsonb not null default '[]'::jsonb,
deleted_thoughts jsonb not null default '[]'::jsonb,
custom_categories jsonb not null default '[]'::jsonb,
updated_at timestamptz not null default now()
);
```

2. In `assets/js/supabase-config.js`, add your values:
- `url`: Project URL
- `anonKey`: Project API anon key
- `adminEmails`: admin account emails allowed to access owner mode

Example:

```js
window.SUPABASE_CONFIG = {
  url: 'https://YOUR_PROJECT.supabase.co',
  anonKey: 'YOUR_ANON_KEY',
  adminEmails: ['you@example.com']
};
```

3. In Supabase Dashboard -> Authentication -> Users:
- Create admin user(s) with email + password (the same credentials you will use in app owner login).

4. Enable Row Level Security and add policies.

Recommended policy set (public read):
- Anyone can read thoughts (visitor mode works publicly).
- Only authenticated users can insert/update/delete.

```sql
alter table public.app_state enable row level security;

drop policy if exists "app_state_select_all" on public.app_state;
drop policy if exists "app_state_insert_auth" on public.app_state;
drop policy if exists "app_state_update_auth" on public.app_state;
drop policy if exists "app_state_delete_auth" on public.app_state;

create policy "app_state_select_all"
on public.app_state for select
to anon, authenticated
using (true);

create policy "app_state_insert_auth"
on public.app_state for insert
to authenticated
with check (true);

create policy "app_state_update_auth"
on public.app_state for update
to authenticated
using (true)
with check (true);

create policy "app_state_delete_auth"
on public.app_state for delete
to authenticated
using (true);
```

If you are using the Vercel API proxy + encryption (recommended to block GitHub/sandbox reads),
remove public read access entirely. The serverless API uses a service role key and bypasses RLS.

```sql
alter table public.app_state enable row level security;

drop policy if exists "app_state_select_all" on public.app_state;
drop policy if exists "app_state_select_auth" on public.app_state;

-- Optional: keep these for admin updates if you still use client auth for write.
-- Otherwise, you can remove all policies and rely only on the serverless API.
```

Vercel environment variables required:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `THOUGHTS_SECRET` (32-byte base64 or hex; keep secret)

5. Deploy using `index.html` (not `index.html.html`).

6. Verify secure admin sync:
- Open site on mobile and PC.
- Login as Owner using admin email + password on mobile.
- Add/delete a thought on mobile.
- Wait up to 10 seconds or reload PC.
- Login as Owner on PC with same admin account.
- The same changes should appear on PC.
