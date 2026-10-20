-- Inmuebles | Reparaciones y Mantenimiento — ejecutar completo en Supabase → SQL Editor
create extension if not exists pgcrypto;

-- Roles: admin (aprueba presupuestos y edita), editor (edita), lector (solo consulta)
create table perfiles(user_id uuid primary key references auth.users on delete cascade, rol text not null default 'lector' check (rol in ('admin','editor','lector')));
alter table perfiles enable row level security;
create policy "ver mi perfil" on perfiles for select to authenticated using (user_id = auth.uid());
create function public.rol_actual() returns text language sql stable security definer set search_path=public as $$ select rol from perfiles where user_id = auth.uid() $$;
create function public.puede_editar() returns boolean language sql stable security definer set search_path=public as $$ select coalesce(public.rol_actual() in ('admin','editor'), false) $$;
create function public.nuevo_perfil() returns trigger language plpgsql security definer set search_path=public as $$ begin insert into perfiles(user_id) values (new.id) on conflict do nothing; return new; end $$;
create trigger al_crear_usuario after insert on auth.users for each row execute function public.nuevo_perfil();
insert into perfiles(user_id) select id from auth.users on conflict do nothing;

create table propiedades(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  codigo text unique, direccion text, localidad text, estado text, responsable text, obs text);
create table proveedores(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  nombre text, cuit text, rubro text, tel text, email text, facturacion text, condiciones text, obs text);
create table reparaciones(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  numero text unique, titulo text, prop uuid references propiedades on delete set null,
  solicitante text, categoria text, prioridad text, estado text, responsable text, "desc" text,
  "fechaSol" date, "fechaIni" date, "fechaFinPrev" date, "fechaFinReal" date,
  docs jsonb default '[]', novedades jsonb default '[]');
create table presupuestos(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  rep uuid references reparaciones on delete cascade, prov uuid references proveedores on delete set null,
  fecha date, monto numeric default 0, estado text, validez date, plazo text, condiciones text, "desc" text,
  "aprobadoPor" text, "fechaAprob" date, "aprobadoOriginal" numeric, archivo jsonb);
create table pagos(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  rep uuid references reparaciones on delete cascade, prov uuid references proveedores on delete set null,
  numero text, fecha date, monto numeric default 0, medio text, operacion text, factura text, por text, obs text, archivo jsonb);
create unique index un_aprobado_por_rep on presupuestos(rep) where estado = 'Aprobado';

-- Solo un admin puede aprobar presupuestos
create function public.solo_admin_aprueba() returns trigger language plpgsql as $$
begin
  if new.estado = 'Aprobado' and (tg_op = 'INSERT' or old.estado is distinct from 'Aprobado') and coalesce(public.rol_actual(),'') <> 'admin' then
    raise exception 'Solo un administrador puede aprobar presupuestos';
  end if; return new;
end $$;
create trigger aprobar_solo_admin before insert or update on presupuestos for each row execute function public.solo_admin_aprueba();

-- Seguridad (RLS) y tiempo real
do $$ declare t text; begin
  foreach t in array array['propiedades','proveedores','reparaciones','presupuestos','pagos'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "leer" on %I for select to authenticated using (true)', t);
    execute format('create policy "escribir" on %I for all to authenticated using (public.puede_editar()) with check (public.puede_editar())', t);
    execute format('alter publication supabase_realtime add table %I', t);
  end loop;
end $$;

-- Archivos adjuntos (bucket privado)
insert into storage.buckets(id, name, public) values ('adjuntos','adjuntos',false) on conflict do nothing;
create policy "adjuntos leer" on storage.objects for select to authenticated using (bucket_id = 'adjuntos');
create policy "adjuntos subir" on storage.objects for insert to authenticated with check (bucket_id = 'adjuntos' and public.puede_editar());

-- Después de crear tu usuario (Authentication → Users), hacete admin:
-- update perfiles set rol = 'admin' where user_id = (select id from auth.users where email = 'tu@correo.com');
