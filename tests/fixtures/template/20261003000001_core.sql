-- =============================================================================
-- Noyau multi-organisations du gabarit factory-template
-- Tables : profiles, organizations, memberships, invitations, subscriptions, audit_logs
-- Règle : RLS activée partout ; les écritures sensibles passent par des fonctions SQL
-- (security definer) qui vérifient les droits et écrivent le journal d'audit.
-- Migrations additives uniquement (voir scripts/ci/check-migrations.mjs).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text check (full_name is null or char_length(full_name) <= 120),
  is_platform_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 80),
  slug text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$'),
  created_by uuid references auth.users (id) on delete set null,
  stripe_customer_id text unique,
  created_at timestamptz not null default now()
);

create table public.memberships (
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user_id_idx on public.memberships (user_id);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  email text not null check (email = lower(email) and position('@' in email) > 1),
  role text not null check (role in ('admin', 'member')),
  token uuid not null unique default gen_random_uuid(),
  invited_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index invitations_one_pending_per_email on public.invitations (org_id, email) where accepted_at is null;

create table public.subscriptions (
  org_id uuid primary key references public.organizations (id) on delete cascade,
  stripe_subscription_id text not null unique,
  stripe_price_id text,
  status text not null,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at timestamptz not null default now()
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  org_id uuid references public.organizations (id) on delete cascade,
  actor_id uuid references auth.users (id) on delete set null,
  action text not null check (action ~ '^[a-z_]+\.[a-z_]+$'),
  target text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_org_created_idx on public.audit_logs (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Fonctions d'aide (security definer pour éviter la récursion RLS sur memberships)
-- ---------------------------------------------------------------------------

create function public.role_rank(p_role text)
returns int
language sql
immutable
set search_path = ''
as $$
  select case p_role when 'owner' then 3 when 'admin' then 2 when 'member' then 1 else 0 end
$$;

create function public.my_org_role(p_org uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role from public.memberships m
  where m.org_id = p_org and m.user_id = (select auth.uid())
$$;

create function public.is_org_member(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = p_org and m.user_id = (select auth.uid())
  )
$$;

create function public.has_org_role(p_org uuid, p_min_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.role_rank(public.my_org_role(p_org)) >= public.role_rank(p_min_role), false)
$$;

create function public.shares_org_with(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships mine
    join public.memberships theirs on theirs.org_id = mine.org_id
    where mine.user_id = (select auth.uid()) and theirs.user_id = p_user
  )
$$;

create function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select p.is_platform_admin from public.profiles p where p.id = (select auth.uid())), false)
$$;

-- Écrit une ligne d'audit. Interne : appelée par les autres fonctions.
create function public._audit(p_org uuid, p_action text, p_target text, p_metadata jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_logs (org_id, actor_id, action, target, metadata)
  values (p_org, (select auth.uid()), p_action, p_target, coalesce(p_metadata, '{}'::jsonb))
$$;

-- ---------------------------------------------------------------------------
-- Profil créé automatiquement à l'inscription
-- ---------------------------------------------------------------------------

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    lower(coalesce(new.email, '')),
    nullif(left(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), 120), '')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Actions (RPC) : seules voies d'écriture pour les opérations sensibles
-- ---------------------------------------------------------------------------

create function public.create_organization(p_name text, p_slug text)
returns public.organizations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_org public.organizations;
begin
  if v_user is null then
    raise exception 'authentification requise' using errcode = '28000';
  end if;

  insert into public.organizations (name, slug, created_by)
  values (btrim(p_name), p_slug, v_user)
  returning * into v_org;

  insert into public.memberships (org_id, user_id, role) values (v_org.id, v_user, 'owner');
  perform public._audit(v_org.id, 'org.created', v_org.slug, jsonb_build_object('name', v_org.name));
  return v_org;
end;
$$;

create function public.update_member_role(p_org uuid, p_user uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role text := public.my_org_role(p_org);
  v_target_role text;
begin
  if p_role not in ('owner', 'admin', 'member') then
    raise exception 'rôle invalide' using errcode = '22023';
  end if;
  if public.role_rank(v_actor_role) < 2 then
    raise exception 'droits insuffisants' using errcode = '42501';
  end if;

  select role into v_target_role from public.memberships where org_id = p_org and user_id = p_user for update;
  if v_target_role is null then
    raise exception 'membre introuvable' using errcode = 'P0002';
  end if;
  if (p_role = 'owner' or v_target_role = 'owner') and v_actor_role <> 'owner' then
    raise exception 'seul un owner peut modifier un owner' using errcode = '42501';
  end if;
  if v_target_role = 'owner' and p_role <> 'owner'
     and (select count(*) from public.memberships where org_id = p_org and role = 'owner') <= 1 then
    raise exception 'impossible de retirer le dernier owner' using errcode = '23514';
  end if;

  update public.memberships set role = p_role where org_id = p_org and user_id = p_user;
  perform public._audit(p_org, 'member.role_changed', p_user::text, jsonb_build_object('from', v_target_role, 'to', p_role));
end;
$$;

create function public.remove_member(p_org uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_role text := public.my_org_role(p_org);
  v_target_role text;
begin
  if v_actor_role is null then
    raise exception 'droits insuffisants' using errcode = '42501';
  end if;

  select role into v_target_role from public.memberships where org_id = p_org and user_id = p_user for update;
  if v_target_role is null then
    raise exception 'membre introuvable' using errcode = 'P0002';
  end if;

  if p_user <> v_actor then
    if public.role_rank(v_actor_role) < 2 then
      raise exception 'droits insuffisants' using errcode = '42501';
    end if;
    if v_target_role = 'owner' and v_actor_role <> 'owner' then
      raise exception 'seul un owner peut retirer un owner' using errcode = '42501';
    end if;
  end if;

  if v_target_role = 'owner'
     and (select count(*) from public.memberships where org_id = p_org and role = 'owner') <= 1 then
    raise exception 'impossible de retirer le dernier owner' using errcode = '23514';
  end if;

  delete from public.memberships where org_id = p_org and user_id = p_user;
  perform public._audit(p_org, 'member.removed', p_user::text, jsonb_build_object('role', v_target_role));
end;
$$;

create function public.accept_invitation(p_token uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_email text := lower(coalesce((select auth.jwt()) ->> 'email', ''));
  v_inv public.invitations;
begin
  if v_user is null then
    raise exception 'authentification requise' using errcode = '28000';
  end if;

  select * into v_inv from public.invitations
  where token = p_token and accepted_at is null and expires_at > now() and email = v_email
  for update;

  if v_inv.id is null then
    raise exception 'invitation invalide ou expirée' using errcode = 'P0002';
  end if;

  insert into public.memberships (org_id, user_id, role)
  values (v_inv.org_id, v_user, v_inv.role)
  on conflict (org_id, user_id) do nothing;

  update public.invitations set accepted_at = now() where id = v_inv.id;
  perform public._audit(v_inv.org_id, 'invitation.accepted', v_email, jsonb_build_object('role', v_inv.role));
  return v_inv.org_id;
end;
$$;

-- Journal applicatif : l'acteur est toujours l'utilisateur connecté, jamais une valeur fournie.
create function public.log_event(p_org uuid, p_action text, p_target text default null, p_metadata jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_org_member(p_org) then
    raise exception 'droits insuffisants' using errcode = '42501';
  end if;
  perform public._audit(p_org, p_action, p_target, p_metadata);
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.invitations enable row level security;
alter table public.subscriptions enable row level security;
alter table public.audit_logs enable row level security;

create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.shares_org_with(id));
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy organizations_select on public.organizations for select to authenticated
  using (public.is_org_member(id));
create policy organizations_update on public.organizations for update to authenticated
  using (public.has_org_role(id, 'admin')) with check (public.has_org_role(id, 'admin'));

create policy memberships_select on public.memberships for select to authenticated
  using (public.is_org_member(org_id));

create policy invitations_select on public.invitations for select to authenticated
  using (public.has_org_role(org_id, 'admin'));
create policy invitations_insert on public.invitations for insert to authenticated
  with check (public.has_org_role(org_id, 'admin') and invited_by = (select auth.uid()));
create policy invitations_delete on public.invitations for delete to authenticated
  using (public.has_org_role(org_id, 'admin'));

create policy subscriptions_select on public.subscriptions for select to authenticated
  using (public.has_org_role(org_id, 'admin'));

create policy audit_logs_select on public.audit_logs for select to authenticated
  using (public.has_org_role(org_id, 'admin'));

-- ---------------------------------------------------------------------------
-- Privilèges explicites (ne pas dépendre des privilèges par défaut)
-- ---------------------------------------------------------------------------

revoke all on public.profiles, public.organizations, public.memberships, public.invitations,
  public.subscriptions, public.audit_logs from anon, authenticated;

grant select on public.profiles, public.organizations, public.memberships, public.invitations,
  public.subscriptions, public.audit_logs to authenticated;
grant update (full_name) on public.profiles to authenticated;
grant update (name) on public.organizations to authenticated;
grant insert (org_id, email, role, invited_by) on public.invitations to authenticated;
grant delete on public.invitations to authenticated;

grant all on public.profiles, public.organizations, public.memberships, public.invitations,
  public.subscriptions, public.audit_logs to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Supabase accorde EXECUTE à anon et authenticated par défaut : on retire tout puis on rouvre au cas par cas.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.role_rank(text),
  public.my_org_role(uuid),
  public.is_org_member(uuid),
  public.has_org_role(uuid, text),
  public.shares_org_with(uuid),
  public.is_platform_admin(),
  public.create_organization(text, text),
  public.update_member_role(uuid, uuid, text),
  public.remove_member(uuid, uuid),
  public.accept_invitation(uuid),
  public.log_event(uuid, text, text, jsonb)
to authenticated;
grant execute on all functions in schema public to service_role;

-- Sécurité par défaut pour les futures migrations : aucune table ni fonction n'est accessible
-- à anon/authenticated sans GRANT explicite. Un oubli de GRANT donne une erreur visible (et un test rouge),
-- jamais une fuite de données.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
