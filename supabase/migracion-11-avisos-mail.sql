-- Avisos automáticos por mail · ejecutar UNA vez, DESPUÉS de crear la función "avisos" y sus secretos
-- (ver INSTRUCTIVO-AVISOS-MAIL.txt).
-- ANTES DE EJECUTAR: reemplazar las dos apariciones de PEGAR-ACA-LA-CLAVE por el mismo valor del secreto AVISOS_TOKEN.
-- Horarios en hora de Argentina (UTC-3). Supabase programa en UTC: 7:30 AR = 10:30 UTC · 8:00 AR = 11:00 UTC.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Si se vuelve a ejecutar, primero se borran los programados anteriores (no da error si no existen)
select cron.unschedule(jobname) from cron.job where jobname in ('avisos-deuda-lunes', 'avisos-aumentos-dia-20');

-- 1) Todos los lunes a las 7:30: deuda de impuestos y alquileres
select cron.schedule('avisos-deuda-lunes', '30 10 * * 1', $$
  select net.http_post(
    url := 'https://qtcdrnpwvetaekmbhrcf.supabase.co/functions/v1/avisos?tipo=deuda',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-avisos-token', 'PEGAR-ACA-LA-CLAVE'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
$$);

-- 2) Los días 20 a las 8:00: alquileres que aumentan el mes siguiente
select cron.schedule('avisos-aumentos-dia-20', '0 11 20 * *', $$
  select net.http_post(
    url := 'https://qtcdrnpwvetaekmbhrcf.supabase.co/functions/v1/avisos?tipo=aumentos',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-avisos-token', 'PEGAR-ACA-LA-CLAVE'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
$$);

-- Control: tienen que aparecer los dos avisos programados
select jobname, schedule, active from cron.job where jobname like 'avisos-%' order by jobname;

-- Para ver después si se ejecutaron (fecha, estado y mensaje):
-- select j.jobname, d.start_time, d.status, d.return_message from cron.job_run_details d join cron.job j using (jobid)
--  where j.jobname like 'avisos-%' order by d.start_time desc limit 10;
-- Y la respuesta de la función (ok / error):
-- select created, status_code, content from net._http_response order by created desc limit 5;
