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

3. If Row Level Security is enabled, create a policy that allows read/write for your use case.

4. Deploy using `index.html` (not `index.html.html`).
