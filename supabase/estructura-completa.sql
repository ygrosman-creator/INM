-- ESTRUCTURA COMPLETA DE LA BASE · INMUEBLES AMIA
-- Crea todas las tablas, permisos, auditoría y el espacio de archivos en un proyecto NUEVO y VACÍO de Supabase.
-- Es la unión, en orden, de schema.sql y migracion-2 a migracion-10. Ejecutar UNA vez: SQL Editor -> New query -> pegar -> Run.
-- No carga datos: los datos se cargan después con restaurar-1.sql, restaurar-2.sql... del respaldo semanal.

-- =================== schema.sql ===================
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
  numero text unique, titulo text, prop uuid references propiedades on delete set null, prov uuid references proveedores on delete set null,
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

-- =================== migracion-2.sql ===================
-- Ejecutar UNA vez en Supabase → SQL Editor (agrega el proveedor elegido a cada reparación)
alter table reparaciones add column if not exists prov uuid references proveedores on delete set null;
notify pgrst, 'reload schema';

-- =================== migracion-3-inmuebles.sql ===================
-- Fase 1 · Sistema de inmuebles. Ejecutar UNA vez en Supabase → SQL Editor.
-- Amplía la tabla "propiedades" existente; no borra nada.

-- 1) Listas editables por el equipo (etiquetas, vínculos, tipos de documento)
create table opciones(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  lista text not null check (lista in ('vinculo','tipo_documento','etiqueta','forma_pago','tipo_impuesto')),
  valor text not null, orden int default 0, unique (lista, valor));
insert into opciones(lista, valor, orden) values
 ('vinculo','Donante',1),('vinculo','Donante con usufructo',2),('vinculo','Testador',3),('vinculo','Inquilino',4),
 ('vinculo','Garante',5),('vinculo','Beneficiario',6),('vinculo','Comodatario',7),('vinculo','Heredero',8),
 ('tipo_documento','Escritura',1),('tipo_documento','Contrato de alquiler',2),('tipo_documento','Garantía',3),
 ('tipo_documento','Documentación sucesoria',4),('tipo_documento','Donación',5),('tipo_documento','Testamento',6),
 ('tipo_documento','Plano',7),('tipo_documento','Foto',8),('tipo_documento','Otro',9),
 ('etiqueta','ALQUILADO',1),
 ('etiqueta','EN ALQUILER',2),
 ('etiqueta','A LA VENTA',3),
 ('etiqueta','VENDIDO',4),
 ('etiqueta','COMODATO',5),
 ('etiqueta','USUFRUCTO DONANTE',6),
 ('etiqueta','SEDE AMIA',7),
 ('etiqueta','POSIBLE DONACIÓN',8),
 ('etiqueta','TESTAMENTO',9),
 ('etiqueta','OTROS',10),
 ('etiqueta','USUCAPIÓN',11),
 ('etiqueta','JUDICIALIZADO',12),
 ('etiqueta','LEGADO',13),
 ('etiqueta','VACÍO',14),
 ('etiqueta','OCUPADO',15),
 ('etiqueta','USURPADO',16),
 ('etiqueta','SUCESIÓN EN TRÁMITE',17),
 ('etiqueta','TASACIÓN PENDIENTE',18),
 ('forma_pago','INQUILINOS - PROPIETARIOS',1),
 ('forma_pago','TESOMPTC',2),
 ('forma_pago','DEBITOS FRANCES',3),
 ('forma_pago','T.C.',4),
 ('forma_pago','EXENTO',5),
 ('forma_pago','NO PAGAR',6),
 ('tipo_impuesto','ABL',1),
 ('tipo_impuesto','AYSA',2),
 ('tipo_impuesto','ARBA',3),
 ('tipo_impuesto','LUZ',4),
 ('tipo_impuesto','GAS',5),
 ('tipo_impuesto','EXPENSAS',6),
 ('tipo_impuesto','TELÉFONO',7),
 ('tipo_impuesto','TASA MUNICIPAL',8),
 ('tipo_impuesto','SEGURO',9),
 ('tipo_impuesto','OTRO',10);

-- 2) Ficha del inmueble. Las etiquetas (varias por inmueble) reemplazan al estado único
alter table propiedades
  add column if not exists tipo text,                       -- departamento, local, lote, PH, cementerio…
  add column if not exists m2 numeric,
  add column if not exists nomenclatura text,               -- nomenclatura catastral
  add column if not exists etiquetas text[] default '{}',   -- permite filtrar varias a la vez
  add column if not exists situacion_legal text,
  add column if not exists legal_actualizado timestamptz,   -- fecha automática de última actualización legal
  add column if not exists de_amia boolean default false,   -- DE AMIA: tenemos el título
  add column if not exists anio_venta int,                  -- para los VENDIDOS
  add column if not exists valor_venta numeric,
  add column if not exists moneda_venta text default 'USD'; -- las notas van en la columna existente "obs"
create index if not exists propiedades_etiquetas on propiedades using gin (etiquetas);

-- Las etiquetas se guardan siempre en MAYÚSCULAS, y OTRO / OTRA / OTRAS / OTROS se unifican en OTROS
create function public.etiquetas_mayuscula() returns trigger language plpgsql as $$
declare f text := '';
begin
  if tg_table_name = 'propiedades' then
    new.etiquetas := coalesce((select array_agg(distinct case when upper(trim(e)) in ('OTRO','OTRA','OTRAS') then 'OTROS' else upper(trim(e)) end)
                               from unnest(new.etiquetas) e where trim(e) <> ''), '{}');
  elsif new.lista = 'etiqueta' then
    new.valor := case when upper(trim(new.valor)) in ('OTRO','OTRA','OTRAS') then 'OTROS' else upper(trim(new.valor)) end;
  end if;
  return new;
end $$;

create trigger mayuscula_etiquetas_prop before insert or update on propiedades for each row execute function public.etiquetas_mayuscula();
create trigger mayuscula_etiquetas_opc  before insert or update on opciones     for each row execute function public.etiquetas_mayuscula();

-- 3) Personas y su vínculo con cada inmueble (varias por inmueble, varios inmuebles por persona)
create table personas(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  nombre text, apellido text, dni text, cuit text, nacimiento date, fallecimiento date,
  mail text, telefono text, otros text);
create table vinculos(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  inmueble uuid references propiedades on delete cascade, persona uuid references personas on delete cascade,
  vinculo text, desde date, hasta date, obs text);

-- 4) Documentos y fotos (el archivo vive en el bucket privado "adjuntos")
create table documentos(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  inmueble uuid references propiedades on delete cascade,
  tipo text, nombre text, fecha date, estado text default 'Disponible' check (estado in ('Disponible','Pendiente')),
  archivo jsonb, obs text);

-- 5) Legal: causas, bitácora y sepelios
create table causas(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  inmueble uuid references propiedades on delete cascade,
  tipo text default 'Usucapión', expediente text, caratula text, estado text, tasacion numeric, moneda text default 'USD');
create table novedades_legales(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  inmueble uuid references propiedades on delete cascade, causa uuid references causas on delete set null,
  fecha date default current_date, tipo text, texto text, por text);
create table sepelios(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  inmueble uuid references propiedades on delete cascade, persona uuid references personas on delete set null,
  origen text, servicio text, obs text);

-- La fecha de última actualización legal se completa sola
create function public.tocar_legal() returns trigger language plpgsql security definer set search_path=public as $$
begin
  update propiedades set legal_actualizado = now() where id = coalesce(new.inmueble, old.inmueble);
  return coalesce(new, old);
end $$;
create trigger legal_novedades after insert or update or delete on novedades_legales for each row execute function public.tocar_legal();
create trigger legal_causas    after insert or update or delete on causas            for each row execute function public.tocar_legal();
create trigger legal_sepelios  after insert or update or delete on sepelios          for each row execute function public.tocar_legal();

-- 6) Trazabilidad: cada alta, cambio o baja queda con fecha, hora y usuario
create table auditoria(
  id bigint generated always as identity primary key, cuando timestamptz default now(),
  usuario uuid, tabla text, registro uuid, accion text, antes jsonb, despues jsonb);
create function public.auditar() returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into auditoria(usuario, tabla, registro, accion, antes, despues)
  values (auth.uid(), tg_table_name, (coalesce(to_jsonb(new), to_jsonb(old))->>'id')::uuid, tg_op,
          case when tg_op <> 'INSERT' then to_jsonb(old) end, case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end $$;
do $$ declare t text; begin
  foreach t in array array['propiedades','personas','vinculos','documentos','causas','novedades_legales','sepelios'] loop
    execute format('create trigger auditar_%1$s after insert or update or delete on %1$I for each row execute function public.auditar()', t);
  end loop;
end $$;
alter table auditoria enable row level security;
create policy "solo admin ve auditoria" on auditoria for select to authenticated using (public.rol_actual() = 'admin');

-- 7) Seguridad y tiempo real (mismo esquema que el resto: leer todos, escribir editor/admin)
do $$ declare t text; begin
  foreach t in array array['opciones','personas','vinculos','documentos','causas','novedades_legales','sepelios'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "leer" on %I for select to authenticated using (true)', t);
    execute format('create policy "escribir" on %I for all to authenticated using (public.puede_editar()) with check (public.puede_editar())', t);
    execute format('alter publication supabase_realtime add table %I', t);
  end loop;
end $$;
notify pgrst, 'reload schema';

-- =================== migracion-4-impuestos.sql ===================
-- Impuestos de cada inmueble · ejecutar UNA vez, DESPUÉS de migracion-3-inmuebles.sql
-- Un impuesto (o servicio) pertenece a un inmueble y se actualiza mes a mes en impuestos_periodos.

create table impuestos(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  inmueble uuid references propiedades on delete cascade,
  concepto text,        -- impuesto o servicio tal como figura (EDESUR, AYSA, ABL exento nov 22…)
  tipo text,            -- ABL, AYSA, ARBA, LUZ, GAS, EXPENSAS, TELÉFONO… (lista editable en "opciones")
  nro_cliente text,     -- número de cliente o referencia; puede quedar vacío (por ejemplo, exentos)
  forma_pago text,      -- INQUILINOS - PROPIETARIOS, TESOMPTC, DEBITOS FRANCES, T.C., EXENTO, NO PAGAR…
  notas text);
create index impuestos_inmueble on impuestos(inmueble);

create table impuestos_periodos(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  impuesto uuid not null references impuestos on delete cascade,
  periodo date not null,      -- primer día del mes (2026-01-01 = enero 2026)
  importe numeric,
  vencimiento date,           -- con esto se arma el aviso semanal de vencimientos
  pagado boolean default false, fecha_pago date, obs text,
  unique (impuesto, periodo));
create index periodos_vencimiento on impuestos_periodos(vencimiento);

do $$ declare t text; begin
  foreach t in array array['impuestos','impuestos_periodos'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "leer" on %I for select to authenticated using (true)', t);
    execute format('create policy "escribir" on %I for all to authenticated using (public.puede_editar()) with check (public.puede_editar())', t);
    execute format('create trigger auditar_%1$s after insert or update or delete on %1$I for each row execute function public.auditar()', t);
    execute format('alter publication supabase_realtime add table %I', t);
  end loop;
end $$;
notify pgrst, 'reload schema';

-- =================== migracion-5-alquileres.sql ===================
-- Alquileres: contratos y pagos mensuales · ejecutar UNA vez, DESPUÉS de migracion-3 y migracion-4.
-- Un inquilino es una persona (tabla personas) vinculada al inmueble; el contrato guarda fechas, monto e incremento.

create table contratos(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  inmueble uuid references propiedades on delete cascade,
  inquilino uuid references personas on delete set null,
  descripcion text,            -- m², ambientes, etc.
  duracion_texto text,         -- tal como figuraba en la planilla
  inicio date, fin date, meses int,
  monto numeric, moneda text default 'ARS', fuente_monto text,
  forma_incremento text,       -- IPC, ICL, promedio IPC + ICL, etc.
  deposito text, inmobiliaria text,
  servicios_inquilino jsonb default '{}',   -- {"LUZ":true,"GAS":false,"ABL":true,...}
  activo boolean default true, obs text);
create index contratos_inmueble on contratos(inmueble);
create index contratos_fin on contratos(fin);

create table alquiler_pagos(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  contrato uuid not null references contratos on delete cascade,
  periodo date not null,       -- primer día del mes
  importe numeric,
  pagado boolean,              -- vacío = todavía sin confirmar
  fecha_pago date, obs text,
  unique (contrato, periodo));

do $$ declare t text; begin
  foreach t in array array['contratos','alquiler_pagos'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "leer" on %I for select to authenticated using (true)', t);
    execute format('create policy "escribir" on %I for all to authenticated using (public.puede_editar()) with check (public.puede_editar())', t);
    execute format('create trigger auditar_%1$s after insert or update or delete on %1$I for each row execute function public.auditar()', t);
    execute format('alter publication supabase_realtime add table %I', t);
  end loop;
end $$;
notify pgrst, 'reload schema';

-- =================== migracion-6-ajustes.sql ===================
-- Ajustes del lote 2 · ejecutar UNA vez, después de migracion-5.
-- 1) Llaves de cada inmueble, 2) fecha exacta de venta, 3) la situación legal cargada pasa a una nota con fecha.

create table llaves(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  inmueble uuid references propiedades on delete cascade,
  numero int, notas text);
create index llaves_inmueble on llaves(inmueble);

do $$ declare t text; begin
  foreach t in array array['llaves'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "leer" on %I for select to authenticated using (true)', t);
    execute format('create policy "escribir" on %I for all to authenticated using (public.puede_editar()) with check (public.puede_editar())', t);
    execute format('create trigger auditar_%1$s after insert or update or delete on %1$I for each row execute function public.auditar()', t);
    execute format('alter publication supabase_realtime add table %I', t);
  end loop;
end $$;

alter table propiedades add column if not exists fecha_venta date;

-- El texto legal que vino de las planillas pasa a UNA nota con la fecha de hoy (después la ordenás por fechas).
insert into novedades_legales(inmueble, fecha, tipo, texto, por)
select p.id, current_date, 'Carga inicial', p.situacion_legal, 'Carga inicial'
from propiedades p
where nullif(trim(p.situacion_legal), '') is not null
  and not exists (select 1 from novedades_legales n where n.inmueble = p.id and n.tipo = 'Carga inicial');

update propiedades set situacion_legal = null
where situacion_legal is not null
  and exists (select 1 from novedades_legales n where n.inmueble = propiedades.id and n.tipo = 'Carga inicial');

notify pgrst, 'reload schema';
select (select count(*) from llaves) as llaves, (select count(*) from novedades_legales where tipo = 'Carga inicial') as notas_legales_iniciales;

-- =================== migracion-7-ingreso.sql ===================
-- Fecha de ingreso del inmueble y sus notas · ejecutar UNA vez.
alter table propiedades add column if not exists fecha_ingreso date;
alter table propiedades add column if not exists notas_ingreso text;
notify pgrst, 'reload schema';
select count(*) as columnas_nuevas from information_schema.columns where table_name = 'propiedades' and column_name in ('fecha_ingreso','notas_ingreso');   -- tiene que dar 2

-- =================== migracion-8-ajustes.sql ===================
-- Ajustes de etiquetas, usucapión y comodato · ejecutar UNA vez (después de migracion-7).

-- 1) Campos nuevos
alter table propiedades add column if not exists usucapion_anios int;     -- años de usucapión (o directamente el año)
alter table propiedades add column if not exists comodato_vence date;    -- vencimiento del comodato

-- 2) Etiquetas: OCUPADO pasa a USURPADO; se sacan OTROS y SUCESIÓN EN TRÁMITE
update propiedades
set etiquetas = (
  select coalesce(array_agg(distinct case when e = 'OCUPADO' then 'USURPADO' else e end), '{}')
  from unnest(etiquetas) e
  where e not in ('OTROS', 'SUCESIÓN EN TRÁMITE'))
where etiquetas && array['OCUPADO', 'OTROS', 'SUCESIÓN EN TRÁMITE'];

delete from opciones where lista = 'etiqueta' and valor in ('OCUPADO', 'OTROS', 'SUCESIÓN EN TRÁMITE');

notify pgrst, 'reload schema';
select
  (select count(*) from information_schema.columns where table_name = 'propiedades' and column_name in ('usucapion_anios','comodato_vence')) as columnas_nuevas,   -- tiene que dar 2
  (select count(*) from propiedades where etiquetas && array['OCUPADO','OTROS','SUCESIÓN EN TRÁMITE']) as con_etiquetas_viejas;                                              -- tiene que dar 0

-- =================== migracion-9-comodato.sql ===================
-- Comodato sin fecha de vencimiento · ejecutar UNA vez (después de migracion-8).
-- Si está tildado, el comodato se considera VIGENTE en los informes aunque no tenga fecha.
alter table propiedades add column if not exists comodato_sin_vencimiento boolean default false;
notify pgrst, 'reload schema';
select count(*) as columnas_nuevas from information_schema.columns where table_name = 'propiedades' and column_name = 'comodato_sin_vencimiento';   -- tiene que dar 1

-- =================== migracion-10-ajustes-alquiler.sql ===================
-- Ajuste automático de alquileres (sugerir y confirmar) · ejecutar UNA vez, después de migracion-9.
-- 1) Cada contrato guarda con qué índice ajusta, cada cuántos meses y desde cuándo rige el monto actual.
-- 2) Cada ajuste aprobado queda registrado en contratos_ajustes (quién, cuándo, índice, monto anterior y nuevo).
-- 3) Se completan los datos a partir del texto de "forma de incremento" que ya estaba cargado. Revisar los que queden vacíos.

alter table contratos add column if not exists ajuste_indice text check (ajuste_indice in ('IPC','ICL','PROMEDIO','MANUAL'));
alter table contratos add column if not exists ajuste_meses int check (ajuste_meses between 1 and 24);
alter table contratos add column if not exists base_fecha date;   -- desde cuándo rige el monto actual (último ajuste o inicio)

create table if not exists contratos_ajustes(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  contrato uuid not null references contratos on delete cascade,
  fecha date,              -- fecha desde la que rige el monto nuevo
  indice text, detalle text,
  coef numeric, monto_anterior numeric, monto_nuevo numeric,
  por text);
create index if not exists contratos_ajustes_contrato on contratos_ajustes(contrato);

do $$ declare t text; begin
  foreach t in array array['contratos_ajustes'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "leer" on %I for select to authenticated using (true)', t);
    execute format('create policy "escribir" on %I for all to authenticated using (public.puede_editar()) with check (public.puede_editar())', t);
    execute format('create trigger auditar_%1$s after insert or update or delete on %1$I for each row execute function public.auditar()', t);
    execute format('alter publication supabase_realtime add table %I', t);
  end loop;
end $$;

-- Completar índice y frecuencia a partir del texto (solo donde todavía están vacíos)
update contratos set
  ajuste_indice = case
    when upper(forma_incremento) like '%IPC%' and upper(forma_incremento) like '%ICL%' then 'PROMEDIO'
    when upper(forma_incremento) like '%IPC%' then 'IPC'
    when upper(forma_incremento) like '%ICL%' then 'ICL' end,
  ajuste_meses = case
    when upper(forma_incremento) like '%CUATRIMESTRAL%' then 4
    when upper(forma_incremento) like '%TRIMESTRAL%' then 3
    when upper(forma_incremento) like '%SEMESTRAL%' then 6
    when upper(forma_incremento) like '%ANUAL O CADA%' then null   -- ambiguo: completar a mano
    when upper(forma_incremento) like '%ANUAL%' then 12 end
where ajuste_indice is null and ajuste_meses is null;

-- Se supone que el "alquiler actual" cargado rige desde el último ajuste que correspondía según el inicio.
update contratos set base_fecha = (inicio + make_interval(months => (
    ((extract(year from age(current_date, inicio))*12 + extract(month from age(current_date, inicio)))::int / ajuste_meses) * ajuste_meses)))::date
where base_fecha is null and inicio is not null and ajuste_meses is not null and inicio <= current_date;

notify pgrst, 'reload schema';

-- Control: cómo quedó cada contrato (los que tengan índice o meses vacíos hay que completarlos en la ficha)
select p.direccion, c.forma_incremento, c.ajuste_indice, c.ajuste_meses, c.inicio, c.base_fecha, c.monto
from contratos c left join propiedades p on p.id = c.inmueble
order by (c.ajuste_indice is null or c.ajuste_meses is null) desc, p.direccion;
