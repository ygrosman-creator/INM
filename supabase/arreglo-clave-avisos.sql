-- Arreglo: los envíos programados llegaban a la función con una clave distinta de AVISOS_TOKEN (respuesta 401 "No autorizado").
-- ANTES DE EJECUTAR: en la línea 6 (la que empieza con "declare clave"), reemplazar el texto en mayúsculas por el valor EXACTO
-- del secreto AVISOS_TOKEN (el mismo que se cargó en Edge Functions -> Secrets). Sin espacios. Dejar las comillas simples.

do $$
declare clave text := trim('PEGAR-ACA-LA-CLAVE');
        base  text := 'https://qtcdrnpwvetaekmbhrcf.supabase.co/functions/v1/avisos?tipo=';
        cmd   text := $c$ select net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'x-avisos-token', %L), body := '{}'::jsonb, timeout_milliseconds := %s); $c$;
begin
  if clave like 'PEGAR-ACA%' or clave = '' then raise exception 'Falta poner la clave en la linea 6 (entre las comillas simples)'; end if;
  perform cron.unschedule(jobname) from cron.job where jobname in ('avisos-deuda-lunes', 'avisos-aumentos-dia-20', 'respaldo-viernes');
  perform cron.schedule('avisos-deuda-lunes',     '30 10 * * 1', format(cmd, base || 'deuda',    clave, 60000));
  perform cron.schedule('avisos-aumentos-dia-20', '0 11 20 * *', format(cmd, base || 'aumentos', clave, 60000));
  perform cron.schedule('respaldo-viernes',       '0 19 * * 5',  format(cmd, base || 'respaldo', clave, 120000));
  -- Prueba inmediata: manda AHORA el mail de deuda con [PRUEBA] en el asunto
  perform net.http_post(url := base || 'deuda&prueba=1',
                        headers := jsonb_build_object('Content-Type', 'application/json', 'x-avisos-token', clave),
                        body := '{}'::jsonb, timeout_milliseconds := 60000);
end $$;

select jobname, schedule, active from cron.job where jobname in ('avisos-deuda-lunes', 'avisos-aumentos-dia-20', 'respaldo-viernes') order by jobname;

-- DESPUÉS DE 20 SEGUNDOS, ejecutar SOLO esta línea (seleccionarla y Run) para ver el resultado de la prueba:
-- select created, status_code, left(content, 300) from net._http_response order by created desc limit 3;
--   200 y {"ok":true...}  -> listo, llega el mail [PRUEBA] y los programados van a funcionar.
--   401 No autorizado     -> la clave no coincide con AVISOS_TOKEN.
--   500 con error         -> mandar captura.
