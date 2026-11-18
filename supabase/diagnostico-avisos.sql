-- Diagnóstico de los mails automáticos (deuda, aumentos y respaldo). Solo consulta, no cambia nada.
-- SQL Editor -> New query -> pegar -> Run. Mandar captura del resultado.

select 'PROGRAMADOS' as que, jobname as detalle, schedule || '  activo=' || active as estado, null::timestamptz as cuando
from cron.job where jobname like 'avisos-%' or jobname like 'respaldo-%'
union all
select 'EJECUCION', j.jobname, d.status || ' ' || coalesce(left(d.return_message, 120), ''), d.start_time
from cron.job_run_details d join cron.job j using (jobid)
where (j.jobname like 'avisos-%' or j.jobname like 'respaldo-%') and d.start_time > now() - interval '10 days'
union all
select 'RESPUESTA', coalesce(status_code::text, 'sin respuesta'), left(coalesce(content, error_msg, ''), 200), created
from net._http_response where created > now() - interval '10 days'
order by 1 desc, 4 desc nulls last;
