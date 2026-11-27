-- Necesidades y Donaciones: el solicitante VE todo (igual que el administrador), pero no asigna,
-- no entrega ni borra. Sigue pudiendo cargar y corregir solo lo que cargó él mientras esté pendiente.
-- Ejecutar UNA vez en el SQL Editor, DESPUÉS de migracion-15-donaciones.sql.

alter policy "leer" on public.necesidades using (public.es_admin_inm() or public.es_solicitante());
alter policy "leer" on public.donaciones  using (public.es_admin_inm() or public.es_solicitante());
alter policy "leer" on public.equipo      using (public.es_admin_inm() or public.es_solicitante());

-- Control: las tres reglas de lectura tienen que nombrar es_solicitante()
select tablename, qual from pg_policies where schemaname = 'public' and policyname = 'leer'
  and tablename in ('necesidades','donaciones','equipo') order by tablename;
