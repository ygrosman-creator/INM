-- Copia de seguridad semanal por mail · ejecutar UNA vez, DESPUÉS de actualizar la función "avisos"
-- (ver INSTRUCTIVO-RESPALDO-SEMANAL.txt).
-- No hace falta pegar ninguna clave: se toma la misma que ya usa el aviso de deuda de los lunes.
-- Horario: viernes 16:00 hora de Argentina = 19:00 UTC (Supabase programa en UTC).

do $$
declare clave text;
begin
  select substring(command from 'x-avisos-token'', ''([^'']+)''') into clave
  from cron.job where jobname = 'avisos-deuda-lunes';
  if clave is null or clave = 'PEGAR-ACA-LA-CLAVE' then
    raise exception 'No se encontró la clave del aviso de los lunes (avisos-deuda-lunes). Revisar que esté programado.';
  end if;

  -- Si se vuelve a ejecutar, primero se borra el programado anterior
  perform cron.unschedule(jobname) from cron.job where jobname = 'respaldo-viernes';

  perform cron.schedule('respaldo-viernes', '0 19 * * 5', format($f$
    select net.http_post(
      url := 'https://qtcdrnpwvetaekmbhrcf.supabase.co/functions/v1/avisos?tipo=respaldo',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-avisos-token', %L),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000);
  $f$, clave));
end $$;

-- Control: tiene que aparecer "respaldo-viernes" con schedule 0 19 * * 5 y active = true
select jobname, schedule, active from cron.job where jobname in ('avisos-deuda-lunes', 'avisos-aumentos-dia-20', 'respaldo-viernes') order by jobname;

-- Para ver después si se ejecutó:
-- select j.jobname, d.start_time, d.status, d.return_message from cron.job_run_details d join cron.job j using (jobid)
--  where j.jobname = 'respaldo-viernes' order by d.start_time desc limit 5;
-- select created, status_code, content from net._http_response order by created desc limit 5;

-- Para dar de baja el respaldo semanal (solo si hiciera falta):
-- select cron.unschedule('respaldo-viernes');
