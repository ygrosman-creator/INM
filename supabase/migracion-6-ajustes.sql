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
