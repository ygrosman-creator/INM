-- Marca como PAGADOS todos los meses de ALQUILER hasta octubre 2026 inclusive. Los impuestos NO se tocan.
-- Se puede ejecutar más de una vez sin problema (lo que ya está pagado queda igual).
-- Antes de cambiar nada guarda una copia de la tabla en el esquema "respaldo" para poder volver atrás.
-- Cada cambio queda además registrado en la auditoría del sistema.

-- 0) Copia de seguridad (se hace solo la primera vez; si se vuelve a ejecutar, se conserva la copia original)
create schema if not exists respaldo;
create table if not exists respaldo.alquiler_pagos_antes_alq_oct2026 as select * from public.alquiler_pagos;

-- 1) Meses ya cargados hasta octubre 2026 que no figuran como pagados
update public.alquiler_pagos
set pagado = true,
    obs = case when coalesce(trim(obs), '') = '' then 'Marcado como pagado en forma masiva (hasta octubre 2026)'
               else obs || ' · Marcado como pagado en forma masiva (hasta octubre 2026)' end
where pagado is not true
  and periodo <= date '2026-10-01';

-- 2) Meses SIN cargar de enero a octubre 2026 (dentro de la vigencia de cada contrato activo): se agregan como pagados.
--    Desde enero 2026 es desde cuando el programa controla la deuda de alquileres.
--    El importe queda vacío porque no se sabe cuánto se cobró; el programa toma el alquiler del contrato.
insert into public.alquiler_pagos (contrato, periodo, importe, pagado, obs)
select c.id, m::date, null, true, 'Marcado como pagado en forma masiva (hasta octubre 2026)'
from public.contratos c
cross join lateral generate_series(
       greatest(date '2026-01-01', date_trunc('month', coalesce(c.inicio, date '2026-01-01'))::date),
       least(date '2026-10-01', date_trunc('month', coalesce(c.fin, date '2026-10-01'))::date),
       interval '1 month') as m
where c.activo is not false
on conflict (contrato, periodo) do nothing;

-- Control: la primera columna tiene que dar 0
select
  (select count(*) from public.alquiler_pagos where pagado is not true and periodo <= date '2026-10-01') as alquileres_sin_pagar_hasta_oct,
  (select count(*) from public.alquiler_pagos where obs like '%forma masiva (hasta octubre 2026)%')       as meses_marcados_o_agregados;

-- PARA VOLVER ATRÁS (solo si hiciera falta): seleccionar estas 3 líneas, sacarles los dos guiones del principio y ejecutar.
-- delete from public.alquiler_pagos where id not in (select id from respaldo.alquiler_pagos_antes_alq_oct2026);
-- update public.alquiler_pagos a set pagado = r.pagado, obs = r.obs from respaldo.alquiler_pagos_antes_alq_oct2026 r where a.id = r.id;
-- select 'restaurado' as resultado;
