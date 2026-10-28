-- Limpia los presupuestos y pagos VACÍOS que quedaron duplicados por clics repetidos.
-- PASO 1: ejecutá solo estas dos consultas y mirá cuántos aparecen.
select 'presupuesto vacío' as tipo, count(*) from presupuestos
 where coalesce(monto,0) = 0 and estado = 'Recibido' and prov is null and archivo is null
   and coalesce(plazo,'') = '' and coalesce(condiciones,'') = '' and coalesce("desc",'') = '' and coalesce("aprobadoPor",'') = ''
union all
select 'pago vacío', count(*) from pagos
 where coalesce(monto,0) = 0 and archivo is null and coalesce(operacion,'') = '' and coalesce(factura,'') = '' and coalesce(obs,'') = '';

-- PASO 2 (solo si los números tienen sentido): borrá sacando los dos guiones del principio de cada línea.
-- delete from presupuestos
--  where coalesce(monto,0) = 0 and estado = 'Recibido' and prov is null and archivo is null
--    and coalesce(plazo,'') = '' and coalesce(condiciones,'') = '' and coalesce("desc",'') = '' and coalesce("aprobadoPor",'') = '';
-- delete from pagos
--  where coalesce(monto,0) = 0 and archivo is null and coalesce(operacion,'') = '' and coalesce(factura,'') = '' and coalesce(obs,'') = '';
