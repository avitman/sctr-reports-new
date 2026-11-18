-- Lock down sctr_daily: the anon key is public (served by /api/config),
-- so anonymous users may only read. The scraper writes with the
-- service_role key, which bypasses RLS.

alter table public.sctr_daily enable row level security;

-- Remove any existing policies (e.g. permissive insert/update/delete ones).
do $$
declare p record;
begin
  for p in select policyname from pg_policies
           where schemaname = 'public' and tablename = 'sctr_daily'
  loop
    execute format('drop policy %I on public.sctr_daily', p.policyname);
  end loop;
end $$;

create policy "anon read only" on public.sctr_daily
  for select to anon, authenticated using (true);

-- Belt and braces: strip write privileges from public roles.
revoke insert, update, delete, truncate on public.sctr_daily from anon, authenticated;
