-- Ejecutar UNA vez en Supabase → SQL Editor (agrega el proveedor elegido a cada reparación)
alter table reparaciones add column if not exists prov uuid references proveedores on delete set null;
notify pgrst, 'reload schema';
