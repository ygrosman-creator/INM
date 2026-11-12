-- Marca como PAGADOS todos los impuestos y alquileres hasta el 31/10/2026 inclusive. Ejecutar UNA vez.
-- Antes de cambiar nada guarda una copia de las dos tablas en el esquema "respaldo" (para poder volver atrás).
-- Cada cambio queda además registrado en la auditoría del sistema.

-- 0) Copias de seguridad
create schema if not exists respaldo;
drop table if exists respaldo.impuestos_periodos_antes_pagado_oct2026;
drop table if exists respaldo.alquiler_pagos_antes_pagado_oct2026;
create table respaldo.impuestos_periodos_antes_pagado_oct2026 as select * from public.impuestos_periodos;
create table respaldo.alquiler_pagos_antes_pagado_oct2026     as select * from public.alquiler_pagos;

-- 1) Impuestos: todos los períodos hasta octubre 2026, o con vencimiento hasta el 31/10/2026, que no estén pagados.
--    (Las fechas mal cargadas con años viejos, como 0202, NO se tocan: hay que corregirlas a mano.)
update public.impuestos_periodos
set pagado = true,
    obs = case when coalesce(trim(obs), '') = '' then 'Marcado como pagado en forma masiva (hasta 31/10/2026)'
               else obs || ' · Marcado como pagado en forma masiva (hasta 31/10/2026)' end
where pagado is not true
  and (periodo <= date '2026-10-31' or vencimiento between date '2020-01-01' and date '2026-10-31');

-- 2) Alquileres: los meses ya cargados hasta octubre 2026 que no figuran como pagados
update public.alquiler_pagos
set pagado = true,
    obs = case when coalesce(trim(obs), '') = '' then 'Marcado como pagado en forma masiva (hasta 31/10/2026)'
               else obs || ' · Marcado como pagado en forma masiva (hasta 31/10/2026)' end
where pagado is not true
  and periodo <= date '2026-10-31';

-- 3) Alquileres: los meses SIN cargar (enero a octubre 2026, dentro de la vigencia de cada contrato activo) se agregan como pagados.
--    El importe queda vacío porque no se sabe cuánto se cobró ese mes; se puede completar después en la ficha.
insert into public.alquiler_pagos (contrato, periodo, importe, pagado, obs)
select c.id, m::date, null, true, 'Marcado como pagado en forma masiva (hasta 31/10/2026)'
from public.contratos c
cross join lateral generate_series(
       greatest(date '2026-01-01', date_trunc('month', coalesce(c.inicio, date '2026-01-01'))::date),
       least(date '2026-10-01', date_trunc('month', coalesce(c.fin, date '2026-10-01'))::date),
       interval '1 month') as m
where c.activo is not false
on conflict (contrato, periodo) do nothing;

-- Control: tiene que dar 0 en las dos primeras columnas
select
  (select count(*) from public.impuestos_periodos where pagado is not true and periodo <= date '2026-10-31') as impuestos_sin_pagar_hasta_oct,
  (select count(*) from public.alquiler_pagos     where pagado is not true and periodo <= date '2026-10-31') as alquileres_sin_pagar_hasta_oct,
  (select count(*) from public.impuestos_periodos where obs like '%forma masiva%')                          as impuestos_marcados,
  (select count(*) from public.alquiler_pagos     where obs like '%forma masiva%')                          as alquileres_marcados_o_agregados;

-- PARA VOLVER ATRÁS (solo si hiciera falta), ejecutar estas 4 líneas sacando los dos guiones del principio:
-- delete from public.alquiler_pagos where id not in (select id from respaldo.alquiler_pagos_antes_pagado_oct2026);
-- update public.alquiler_pagos a set pagado = r.pagado, obs = r.obs from respaldo.alquiler_pagos_antes_pagado_oct2026 r where a.id = r.id;
-- update public.impuestos_periodos i set pagado = r.pagado, obs = r.obs from respaldo.impuestos_periodos_antes_pagado_oct2026 r where i.id = r.id;
-- select 'restaurado' as resultado;
