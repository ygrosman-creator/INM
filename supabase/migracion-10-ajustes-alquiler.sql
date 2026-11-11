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
