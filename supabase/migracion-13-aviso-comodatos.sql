-- Aviso por mail de comodatos que vencen en 3 meses · ejecutar UNA vez, DESPUÉS de actualizar la función "avisos".
-- Corre todos los días a las 8:00 de Argentina (11:00 UTC) y solo manda mail el día en que a un comodato
-- le faltan exactamente 3 meses para vencer (según "vencimiento del comodato" en la ficha del inmueble).
-- No hace falta pegar ninguna clave: se toma la misma que ya usa el aviso de deuda de los lunes.

do $$
declare clave text;
begin
  select substring(command from 'x-avisos-token'', ''([^'']+)''') into clave
  from cron.job where jobname = 'avisos-deuda-lunes';
  if clave is null or clave = 'PEGAR-ACA-LA-CLAVE' then
    raise exception 'No se encontró la clave del aviso de los lunes (avisos-deuda-lunes). Revisar que esté programado.';
  end if;

  -- Si se vuelve a ejecutar, primero se borra el programado anterior
  perform cron.unschedule(jobname) from cron.job where jobname = 'avisos-comodatos-diario';

  perform cron.schedule('avisos-comodatos-diario', '0 11 * * *', format($f$
    select net.http_post(
      url := 'https://qtcdrnpwvetaekmbhrcf.supabase.co/functions/v1/avisos?tipo=comodatos',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-avisos-token', %L),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000);
  $f$, clave));
end $$;

-- Control: tiene que aparecer "avisos-comodatos-diario" con schedule 0 11 * * * y active = true
select jobname, schedule, active from cron.job order by jobname;

-- Para dar de baja este aviso (solo si hiciera falta):
-- select cron.unschedule('avisos-comodatos-diario');
