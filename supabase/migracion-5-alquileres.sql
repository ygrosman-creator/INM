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
