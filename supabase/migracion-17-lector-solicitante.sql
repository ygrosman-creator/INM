-- Rol nuevo "lector_solicitante" (Lector + Solicitante):
--   * Inmuebles: solo consulta, igual que un Lector (no edita nada).
--   * Necesidades y donaciones: igual que un Solicitante (ve todo, carga nuevas,
--     corrige lo suyo pendiente; no asigna, no entrega ni borra).
-- Ejecutar UNA vez en el SQL Editor, DESPUÉS de migracion-16.

alter table perfiles drop constraint if exists perfiles_rol_check;
alter table perfiles add constraint perfiles_rol_check
  check (rol in ('admin','editor','lector','solicitante','lector_solicitante'));

-- Puede leer inmuebles (como lector). puede_editar() no cambia: sigue sin poder modificar.
create or replace function public.es_personal() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.rol_actual() in ('admin','editor','lector','lector_solicitante'), false) $$;

-- Puede cargar y ver necesidades y donaciones (como solicitante).
create or replace function public.es_solicitante() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.rol_actual() in ('solicitante','lector_solicitante'), false) $$;

-- valfie pasa a Lector + Solicitante
update perfiles set rol = 'lector_solicitante' where lower(email) like 'valfie@%';

-- Control
select email, rol from perfiles where lower(email) like 'valfie@%';
