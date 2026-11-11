-- COPIA DE SEGURIDAD dentro de la misma base (esquema "respaldo"). Ejecutar ANTES de cada cambio grande.
-- No toca tus datos: solo hace una copia de cada tabla con la fecha de hoy en el nombre.
create schema if not exists respaldo;
do $$ declare t text; begin
  foreach t in array array['propiedades','personas','vinculos','documentos','novedades_legales','sepelios','causas','llaves','impuestos','impuestos_periodos','contratos','alquiler_pagos','reparaciones','presupuestos','pagos','proveedores','opciones','perfiles','contratos_ajustes'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop table if exists respaldo.%I', t || '_' || to_char(now(), 'YYYYMMDD'));
      execute format('create table respaldo.%I as select * from public.%I', t || '_' || to_char(now(), 'YYYYMMDD'), t);
    end if;
  end loop;
end $$;
-- Control: lista cada copia con su cantidad de filas
select table_name as copia,
       (xpath('/row/c/text()', query_to_xml('select count(*) as c from respaldo.' || quote_ident(table_name), false, true, '')))[1]::text as filas
from information_schema.tables where table_schema = 'respaldo' order by 1;
