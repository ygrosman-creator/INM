-- Comodato sin fecha de vencimiento · ejecutar UNA vez (después de migracion-8).
-- Si está tildado, el comodato se considera VIGENTE en los informes aunque no tenga fecha.
alter table propiedades add column if not exists comodato_sin_vencimiento boolean default false;
notify pgrst, 'reload schema';
select count(*) as columnas_nuevas from information_schema.columns where table_name = 'propiedades' and column_name = 'comodato_sin_vencimiento';   -- tiene que dar 1
