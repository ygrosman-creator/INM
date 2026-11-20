-- Notas legales con fecha fija + nuevos tipos de documento · ejecutar UNA vez en el SQL Editor.
-- 1) La fecha de una nota legal ya guardada no se puede cambiar, y la nota no se puede eliminar,
--    salvo que lo haga ygrosman@amia.org.ar. El texto de la nota se sigue pudiendo corregir.
--    (Desde el SQL Editor de Supabase sí se puede, para arreglos puntuales.)
-- 2) Agrega los tipos de documento: Acta, Boleto, Comodato, Informes y Reglamento.

create or replace function public.proteger_nota_legal() returns trigger
language plpgsql security definer set search_path = public as $$
declare quien text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  -- SQL Editor / tareas internas (sin usuario de la app): se permite
  if auth.uid() is null then return coalesce(new, old); end if;
  -- Al eliminar un inmueble entero, sus notas se borran con él
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  if quien = 'ygrosman@amia.org.ar' then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then
    raise exception 'Las notas legales no se pueden eliminar. Solo lo puede hacer ygrosman@amia.org.ar.';
  end if;
  if new.fecha is distinct from old.fecha then
    raise exception 'La fecha de la nota legal no se puede cambiar. Solo lo puede hacer ygrosman@amia.org.ar.';
  end if;
  return new;
end $$;

drop trigger if exists proteger_nota_legal on novedades_legales;
create trigger proteger_nota_legal before update or delete on novedades_legales
  for each row execute function public.proteger_nota_legal();

insert into opciones(lista, valor, orden) values
 ('tipo_documento','Acta',10),('tipo_documento','Boleto',11),('tipo_documento','Comodato',12),
 ('tipo_documento','Informes',13),('tipo_documento','Reglamento',14)
on conflict (lista, valor) do nothing;
-- "Otro" queda al final de la lista
update opciones set orden = 99 where lista = 'tipo_documento' and valor = 'Otro';

-- Control: tienen que aparecer los 5 tipos nuevos y el trigger "proteger_nota_legal"
select valor, orden from opciones where lista = 'tipo_documento' order by orden;
select tgname from pg_trigger where tgname = 'proteger_nota_legal';

-- Para quitar la protección (solo si hiciera falta):
-- drop trigger if exists proteger_nota_legal on novedades_legales;
