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
