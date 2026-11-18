-- Fecha de ingreso del inmueble y sus notas · ejecutar UNA vez.
alter table propiedades add column if not exists fecha_ingreso date;
alter table propiedades add column if not exists notas_ingreso text;
notify pgrst, 'reload schema';
select count(*) as columnas_nuevas from information_schema.columns where table_name = 'propiedades' and column_name in ('fecha_ingreso','notas_ingreso');   -- tiene que dar 2
