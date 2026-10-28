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
