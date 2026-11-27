-- =====================================================================
-- Necesidades y Donaciones dentro de INMUEBLES AMIA · ejecutar UNA vez en el SQL Editor.
--
-- 1) Rol nuevo "solicitante": solo puede cargar necesidades y donaciones y ver lo que cargó.
--    Los usuarios NUEVOS empiezan como solicitante. Los que ya existen quedan como están.
-- 2) Los datos de inmuebles (y sus archivos) solo los ven admin, editor y lector.
--    Un solicitante no ve nada de inmuebles, ni siquiera entrando por fuera de la pantalla.
-- 3) Tablas de la app de donaciones: elementos, equipo, necesidades y donaciones.
--    Solo los admin ven todo y asignan. Cada solicitante ve solo lo que cargó.
-- 4) Los admin ven la lista de usuarios y pueden cambiarles el rol desde la pantalla "Usuarios".
--
-- Después de esto, para cargar los datos que ya tenía la app de donaciones, ejecutar
-- (en otra consulta) el archivo datos-privados/datos-iniciales.sql de la carpeta "donaciones".
-- =====================================================================

-- ---------- 1) Roles ----------
alter table perfiles add column if not exists email text;
update perfiles p set email = u.email from auth.users u where u.id = p.user_id and p.email is distinct from u.email;
-- Usuarios que existieran sin perfil: quedan como lector (igual que hasta hoy)
insert into perfiles(user_id, rol, email) select id, 'lector', email from auth.users on conflict (user_id) do nothing;

alter table perfiles drop constraint if exists perfiles_rol_check;
alter table perfiles add constraint perfiles_rol_check check (rol in ('admin','editor','lector','solicitante'));
alter table perfiles alter column rol set default 'solicitante';

create or replace function public.nuevo_perfil() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into perfiles(user_id, rol, email) values (new.id, 'solicitante', new.email) on conflict (user_id) do nothing;
  return new;
end $$;

create or replace function public.es_personal() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.rol_actual() in ('admin','editor','lector'), false) $$;
create or replace function public.es_admin_inm() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.rol_actual() = 'admin', false) $$;
create or replace function public.es_solicitante() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.rol_actual() = 'solicitante', false) $$;

-- Los admin ven todos los perfiles y cambian roles (cada uno sigue viendo el suyo)
drop policy if exists "admin ve perfiles" on perfiles;
create policy "admin ve perfiles" on perfiles for select to authenticated using (public.es_admin_inm());
drop policy if exists "admin cambia roles" on perfiles;
create policy "admin cambia roles" on perfiles for update to authenticated using (public.es_admin_inm()) with check (public.es_admin_inm());

-- ---------- 2) Inmuebles: solo el personal (admin, editor, lector) puede leer ----------
-- Se cambian todas las reglas de lectura abiertas ("using (true)") de las tablas existentes.
do $$ declare r record; begin
  for r in select tablename, policyname from pg_policies
           where schemaname = 'public' and cmd in ('SELECT','ALL') and qual = 'true'
             and tablename not in ('elementos','equipo','necesidades','donaciones','perfiles') loop
    execute format('alter policy %I on public.%I using (public.es_personal())', r.policyname, r.tablename);
  end loop;
end $$;
-- Archivos adjuntos de inmuebles
do $$ begin
  if exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'adjuntos leer') then
    alter policy "adjuntos leer" on storage.objects using (bucket_id = 'adjuntos' and public.es_personal());
  end if;
end $$;

-- ---------- 3) Necesidades y donaciones ----------
create table if not exists public.elementos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null unique check (trim(nombre) <> ''),
  rubro text not null default 'Otros',
  activo boolean not null default true,
  created_at timestamptz not null default now());
create unique index if not exists elementos_nombre_unico on public.elementos (lower(nombre));

insert into public.elementos (nombre, rubro) values
  ('Cama', 'Muebles'), ('Colchón 1 plaza', 'Muebles'), ('Colchón 2 plazas', 'Muebles'),
  ('Cómoda', 'Muebles'), ('Cuna', 'Muebles'), ('Escritorio', 'Muebles'), ('Mesa', 'Muebles'),
  ('Mesa de luz', 'Muebles'), ('Mesa ratona', 'Muebles'), ('Placard', 'Muebles'), ('Silla', 'Muebles'),
  ('Sillón', 'Muebles'),
  ('Anafe eléctrico', 'Electrodomésticos'), ('Cocina', 'Electrodomésticos'), ('Estufa', 'Electrodomésticos'),
  ('Heladera', 'Electrodomésticos'), ('Horno eléctrico', 'Electrodomésticos'), ('Lavarropas', 'Electrodomésticos'),
  ('Microondas', 'Electrodomésticos'), ('Pava eléctrica', 'Electrodomésticos'), ('Secarropas', 'Electrodomésticos'),
  ('Televisor', 'Electrodomésticos'), ('Termotanque', 'Electrodomésticos'), ('Ventilador', 'Electrodomésticos'),
  ('Celular', 'Otros'), ('Ropa de cama', 'Otros'), ('Vajilla', 'Otros')
on conflict do nothing;

-- Profesionales del Servicio Social (para "profesional a cargo")
create table if not exists public.equipo (
  id uuid primary key default gen_random_uuid(),
  iniciales text not null unique,
  apellido text not null,
  nombre text not null default '',
  sector text not null default '',
  ubicacion text not null default '',
  interno text not null default '',
  mail text not null default '',
  activo boolean not null default true,
  created_at timestamptz not null default now());

create table if not exists public.donaciones (
  id uuid primary key default gen_random_uuid(),
  fecha date default current_date,
  elemento text not null references public.elementos(nombre) on update cascade,
  detalle text not null default '',
  cantidad text not null default '1',
  estado_producto text not null default '',
  donante_apellido text not null default '',
  donante_nombre text not null default '',
  donante_telefono text not null default '',
  donante_domicilio text not null default '',
  notas text not null default '',
  estado text not null default 'disponible' check (estado in ('disponible','asignada','entregada')),
  necesidad_id uuid,
  destino_externo text not null default '',
  fecha_entrega date,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid());

create table if not exists public.necesidades (
  id uuid primary key default gen_random_uuid(),
  fecha date default current_date,
  profesional text references public.equipo(iniciales) on update cascade on delete set null,
  apellido text not null,
  nombre text not null default '',
  telefono text not null default '',
  domicilio text not null default '',
  localidad text not null default '',
  elemento text not null references public.elementos(nombre) on update cascade,
  cantidad text not null default '1',
  detalle text not null default '',
  prioridad text not null default '' check (prioridad in ('','alta','media','baja')),
  notas text not null default '',
  estado text not null default 'pendiente' check (estado in ('pendiente','asignada','entregada','cerrada')),
  donacion_id uuid references public.donaciones(id) on delete set null,
  fecha_entrega date,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid());

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'donaciones_necesidad_fk') then
    alter table public.donaciones add constraint donaciones_necesidad_fk
      foreign key (necesidad_id) references public.necesidades(id) on delete set null;
  end if;
end $$;
create index if not exists necesidades_estado_idx on public.necesidades (estado);
create index if not exists necesidades_creador_idx on public.necesidades (created_by);
create index if not exists donaciones_estado_idx on public.donaciones (estado);
create index if not exists donaciones_creador_idx on public.donaciones (created_by);

alter table public.elementos enable row level security;
alter table public.equipo enable row level security;
alter table public.necesidades enable row level security;
alter table public.donaciones enable row level security;

do $$ declare t text; begin
  foreach t in array array['elementos','equipo','necesidades','donaciones'] loop
    execute format('drop policy if exists "leer" on public.%I', t);
    execute format('drop policy if exists "alta" on public.%I', t);
    execute format('drop policy if exists "editar" on public.%I', t);
    execute format('drop policy if exists "borrar" on public.%I', t);
  end loop;
end $$;

-- Elementos: los leen admin y solicitantes; los cambian solo los admin
create policy "leer" on public.elementos for select to authenticated using (public.es_admin_inm() or public.es_solicitante());
create policy "alta" on public.elementos for insert to authenticated with check (public.es_admin_inm());
create policy "editar" on public.elementos for update to authenticated using (public.es_admin_inm()) with check (public.es_admin_inm());
create policy "borrar" on public.elementos for delete to authenticated using (public.es_admin_inm());

-- Equipo: los admin ven a todos; cada solicitante solo su propia fila (por mail)
create policy "leer" on public.equipo for select to authenticated
  using (public.es_admin_inm() or (public.es_solicitante() and lower(mail) = lower(coalesce(auth.jwt() ->> 'email', ''))));
create policy "alta" on public.equipo for insert to authenticated with check (public.es_admin_inm());
create policy "editar" on public.equipo for update to authenticated using (public.es_admin_inm()) with check (public.es_admin_inm());
create policy "borrar" on public.equipo for delete to authenticated using (public.es_admin_inm());

-- Necesidades: admin todo; solicitante carga, ve y corrige SOLO lo suyo mientras siga pendiente
create policy "leer" on public.necesidades for select to authenticated
  using (public.es_admin_inm() or (public.es_solicitante() and created_by = auth.uid()));
create policy "alta" on public.necesidades for insert to authenticated
  with check (public.es_admin_inm() or (public.es_solicitante() and created_by = auth.uid() and estado = 'pendiente' and donacion_id is null));
create policy "editar" on public.necesidades for update to authenticated
  using (public.es_admin_inm() or (public.es_solicitante() and created_by = auth.uid() and estado = 'pendiente'))
  with check (public.es_admin_inm() or (public.es_solicitante() and created_by = auth.uid() and estado = 'pendiente' and donacion_id is null));
create policy "borrar" on public.necesidades for delete to authenticated using (public.es_admin_inm());

-- Donaciones: igual, mientras siga disponible
create policy "leer" on public.donaciones for select to authenticated
  using (public.es_admin_inm() or (public.es_solicitante() and created_by = auth.uid()));
create policy "alta" on public.donaciones for insert to authenticated
  with check (public.es_admin_inm() or (public.es_solicitante() and created_by = auth.uid() and estado = 'disponible' and necesidad_id is null and destino_externo = ''));
create policy "editar" on public.donaciones for update to authenticated
  using (public.es_admin_inm() or (public.es_solicitante() and created_by = auth.uid() and estado = 'disponible'))
  with check (public.es_admin_inm() or (public.es_solicitante() and created_by = auth.uid() and estado = 'disponible' and necesidad_id is null and destino_externo = ''));
create policy "borrar" on public.donaciones for delete to authenticated using (public.es_admin_inm());

-- ---------- Asignar y entregar (solo admin, todo o nada) ----------
create or replace function public.asignar(p_necesidad uuid, p_donacion uuid) returns void
language plpgsql set search_path = public as $$
begin
  if not public.es_admin_inm() then raise exception 'Solo un administrador puede asignar'; end if;
  update donaciones set estado = 'asignada', necesidad_id = p_necesidad, destino_externo = ''
    where id = p_donacion and estado = 'disponible';
  if not found then raise exception 'La donación ya no está disponible'; end if;
  update necesidades set estado = 'asignada', donacion_id = p_donacion
    where id = p_necesidad and estado = 'pendiente';
  if not found then raise exception 'La necesidad ya no está pendiente'; end if;
end $$;

create or replace function public.entregar(p_donacion uuid, p_fecha date) returns void
language plpgsql set search_path = public as $$
declare v_nec uuid;
begin
  if not public.es_admin_inm() then raise exception 'Solo un administrador puede registrar entregas'; end if;
  update donaciones set estado = 'entregada', fecha_entrega = coalesce(p_fecha, current_date)
    where id = p_donacion and estado = 'asignada' returning necesidad_id into v_nec;
  if not found then raise exception 'La donación no está asignada'; end if;
  if v_nec is not null then
    update necesidades set estado = 'entregada', fecha_entrega = coalesce(p_fecha, current_date) where id = v_nec;
  end if;
end $$;

create or replace function public.entregar_externo(p_donacion uuid, p_destino text, p_fecha date) returns void
language plpgsql set search_path = public as $$
begin
  if not public.es_admin_inm() then raise exception 'Solo un administrador puede registrar entregas'; end if;
  if coalesce(trim(p_destino), '') = '' then raise exception 'Indicá el destino'; end if;
  update donaciones set estado = 'entregada', destino_externo = trim(p_destino), necesidad_id = null,
    fecha_entrega = coalesce(p_fecha, current_date)
    where id = p_donacion and estado = 'disponible';
  if not found then raise exception 'La donación ya no está disponible'; end if;
end $$;

create or replace function public.deshacer_asignacion(p_donacion uuid) returns void
language plpgsql set search_path = public as $$
declare v_nec uuid;
begin
  if not public.es_admin_inm() then raise exception 'Solo un administrador puede deshacer asignaciones'; end if;
  select necesidad_id into v_nec from donaciones where id = p_donacion and estado = 'asignada';
  if not found then raise exception 'La donación no está asignada'; end if;
  update donaciones set estado = 'disponible', necesidad_id = null, fecha_entrega = null where id = p_donacion;
  if v_nec is not null then
    update necesidades set estado = 'pendiente', donacion_id = null, fecha_entrega = null where id = v_nec;
  end if;
end $$;

grant execute on function public.asignar(uuid, uuid), public.entregar(uuid, date),
  public.entregar_externo(uuid, text, date), public.deshacer_asignacion(uuid) to authenticated;

-- Trazabilidad (misma auditoría que el resto de la página)
do $$ declare t text; begin
  if exists (select 1 from pg_proc where proname = 'auditar' and pronamespace = 'public'::regnamespace) then
    foreach t in array array['elementos','equipo','necesidades','donaciones'] loop
      execute format('drop trigger if exists auditar_%1$s on public.%1$I', t);
      execute format('create trigger auditar_%1$s after insert or update or delete on public.%1$I for each row execute function public.auditar()', t);
    end loop;
  end if;
end $$;

-- Actualización en vivo
do $$ declare t text; begin
  foreach t in array array['elementos','equipo','necesidades','donaciones','perfiles'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';

-- Control: usuarios y su rol (los que hoy usan INMUEBLES tienen que seguir como admin / editor / lector)
select p.email, p.rol from perfiles p order by p.rol, p.email;
