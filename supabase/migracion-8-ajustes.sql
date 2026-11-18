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
