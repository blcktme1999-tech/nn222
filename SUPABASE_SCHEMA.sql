create extension if not exists pgcrypto;

create table if not exists public.service_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  role text not null default 'agent' check (role in ('admin', 'agent')),
  display_name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.service_cases (
  id uuid primary key default gen_random_uuid(),
  citizen_name text not null,
  national_id text not null,
  case_number text,
  certificate_number text not null default '',
  case_type text not null default '',
  case_title text not null default '',
  case_summary text not null default '',
  document_case text not null default '',
  document_official text not null default '',
  document_content text not null default '',
  status text not null default 'open' check (status in ('pending', 'open', 'closed')),
  interview_status text not null default 'idle' check (interview_status in ('idle', 'active')),
  assigned_user_id uuid references public.service_users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.service_messages (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.service_cases(id) on delete cascade,
  sender_type text not null check (sender_type in ('system', 'citizen', 'agent', 'admin')),
  sender_name text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.service_files (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.service_cases(id) on delete cascade,
  uploaded_by text not null,
  original_name text not null,
  stored_name text not null,
  mime_type text not null,
  size bigint not null default 0,
  kind text not null default 'upload' check (kind in ('upload', 'recording')),
  public_url text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.service_wanted_persons (
  id uuid primary key default gen_random_uuid(),
  national_id text not null,
  person_name text not null,
  reason text not null,
  photo_url text not null default '',
  photo_stored text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists service_wanted_persons_national_id_idx on public.service_wanted_persons(national_id);

create table if not exists public.priority_applications (
  id uuid primary key default gen_random_uuid(),
  citizen_name text not null,
  certificate_number text not null,
  entries_json text not null,
  created_at timestamptz not null default now()
);

alter table public.service_cases add column if not exists interview_status text not null default 'idle';
alter table public.service_cases add column if not exists case_number text;
alter table public.service_cases add column if not exists certificate_number text not null default '';
alter table public.service_cases add column if not exists case_type text not null default '';
alter table public.service_cases add column if not exists case_title text not null default '';
alter table public.service_cases add column if not exists case_summary text not null default '';
alter table public.service_cases add column if not exists document_case text not null default '';
alter table public.service_cases add column if not exists document_official text not null default '';
alter table public.service_cases add column if not exists document_content text not null default '';
alter table public.service_cases add column if not exists case_reason text not null default '';
alter table public.service_cases add column if not exists case_unit text not null default '';
alter table public.service_cases add column if not exists case_order text not null default '';
alter table public.service_cases add column if not exists interview_signature text not null default '';
alter table public.service_cases add column if not exists document_signature text not null default '';
update public.service_cases
set case_number = coalesce(nullif(case_number, ''), national_id)
where case_number is null or case_number = '';
update public.service_cases
set certificate_number = coalesce(nullif(certificate_number, ''), national_id)
where certificate_number is null or certificate_number = '';
alter table public.service_cases drop constraint if exists service_cases_citizen_name_national_id_key;

create index if not exists service_cases_created_at_idx on public.service_cases(created_at desc);
create index if not exists service_cases_status_idx on public.service_cases(status);
create index if not exists service_cases_interview_status_idx on public.service_cases(interview_status);
drop index if exists public.service_cases_case_number_idx;
create index if not exists service_cases_case_number_idx on public.service_cases(case_number);
create index if not exists service_cases_certificate_lookup_idx on public.service_cases(citizen_name, certificate_number);
create index if not exists service_messages_case_id_created_at_idx on public.service_messages(case_id, created_at);
create index if not exists service_files_case_id_created_at_idx on public.service_files(case_id, created_at desc);
create index if not exists priority_applications_created_at_idx on public.priority_applications(created_at desc);

create table if not exists public.priority_application_files (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.priority_applications(id) on delete cascade,
  entry_id text not null default '',
  uploaded_by text not null,
  original_name text not null,
  stored_name text not null,
  mime_type text not null,
  size bigint not null default 0,
  public_url text not null,
  created_at timestamptz not null default now()
);

alter table public.priority_application_files add column if not exists entry_id text not null default '';

create index if not exists priority_application_files_application_idx on public.priority_application_files(application_id, created_at desc);
create index if not exists priority_application_files_entry_idx on public.priority_application_files(application_id, entry_id, created_at desc);

alter table public.service_users enable row level security;
alter table public.service_cases enable row level security;
alter table public.service_messages enable row level security;
alter table public.service_files enable row level security;
alter table public.service_wanted_persons enable row level security;
alter table public.priority_applications enable row level security;
alter table public.priority_application_files enable row level security;

drop policy if exists service_users_service_role_all on public.service_users;
drop policy if exists service_cases_service_role_all on public.service_cases;
drop policy if exists service_messages_service_role_all on public.service_messages;
drop policy if exists service_files_service_role_all on public.service_files;
drop policy if exists service_wanted_persons_service_role_all on public.service_wanted_persons;
drop policy if exists priority_applications_service_role_all on public.priority_applications;
drop policy if exists priority_application_files_service_role_all on public.priority_application_files;

create policy service_users_service_role_all on public.service_users
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create policy service_cases_service_role_all on public.service_cases
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create policy service_messages_service_role_all on public.service_messages
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create policy service_files_service_role_all on public.service_files
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create policy service_wanted_persons_service_role_all on public.service_wanted_persons
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create policy priority_applications_service_role_all on public.priority_applications
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create policy priority_application_files_service_role_all on public.priority_application_files
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

insert into storage.buckets (id, name, public)
values ('report-videos', 'report-videos', true)
on conflict (id) do update set public = excluded.public;

create table if not exists public.site_settings (
  id integer primary key check (id = 1),
  address text not null,
  map_url text not null default '',
  service_phone text not null,
  report_phone_primary text not null default '',
  report_phone_secondary text not null default ''
);

create table if not exists public.site_unit_emails (
  unit_key text primary key,
  unit_name text not null,
  page_path text not null,
  email text not null default ''
);

create table if not exists public.site_news (
  id text primary key,
  category text not null check (category in ('breaking', 'clarification', 'notice', 'crime')),
  title text not null,
  published_on text not null,
  updated_on text not null default '',
  publisher text not null default '',
  body text not null default '',
  images_json text not null default '[]',
  sort_order integer not null default 0,
  legacy_path text not null default ''
);

create index if not exists site_news_category_order_idx on public.site_news(category, sort_order);

create table if not exists public.site_posters (
  id text primary key,
  image_url text not null,
  sort_order integer not null default 0
);

create index if not exists site_posters_order_idx on public.site_posters(sort_order);

create table if not exists public.site_footer (
  id integer primary key check (id = 1),
  image_url text not null
);

insert into public.site_footer (id, image_url)
values (1, '/public/home-sections/footer-qr.png')
on conflict (id) do nothing;

alter table public.site_settings enable row level security;
alter table public.site_unit_emails enable row level security;
alter table public.site_news enable row level security;
alter table public.site_posters enable row level security;

drop policy if exists site_settings_service_role_all on public.site_settings;
drop policy if exists site_unit_emails_service_role_all on public.site_unit_emails;
drop policy if exists site_news_service_role_all on public.site_news;
drop policy if exists site_posters_service_role_all on public.site_posters;

create policy site_settings_service_role_all on public.site_settings
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create policy site_unit_emails_service_role_all on public.site_unit_emails
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create policy site_news_service_role_all on public.site_news
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create policy site_posters_service_role_all on public.site_posters
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

notify pgrst, 'reload schema';