// Supabase Edge Function "avisos" · INMUEBLES AMIA
// Arma y manda por mail (desde una cuenta de Gmail) dos avisos:
//   ?tipo=deuda     -> todos los lunes 7:30: impuestos y alquileres sin pagar (primero lo que vence esa semana)
//   ?tipo=aumentos  -> los días 20 a las 8:00: alquileres que ajustan el mes siguiente
// Otros parámetros:  &ver=1 (muestra el mail en el navegador, NO lo manda) · &prueba=1 (agrega [PRUEBA] al asunto)
//                    &hoy=AAAA-MM-DD (simula otra fecha, para probar)
// Secretos (Edge Functions -> Secrets): GMAIL_USER, GMAIL_APP_PASSWORD, AVISOS_TOKEN, AVISOS_DESTINATARIOS,
//   DIA_VENCIMIENTO_ALQUILER (opcional, 10 si no está). SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los pone Supabase.

const ENV = (k, d = '') => {
  const v = typeof Deno !== 'undefined' ? Deno.env.get(k) : (globalThis.__ENV || {})[k];
  return v == null || v === '' ? d : v;
};
const DESDE_ALQ = '2026-01';                    // desde qué mes se controlan los pagos de alquiler (un mes sin carga es deuda)
const EXCLUIR_IMP = ['EXENTO', 'NO PAGAR'];     // formas de pago que no entran en el aviso de deuda
const FORMA_INQ = 'INQUILINOS - PROPIETARIOS';  // estos van en un bloque aparte, al final del mail (los paga el inquilino)
const IPC_LAG = 0;                              // IPC: meses del período (para un ajuste de abril: ene, feb y mar)
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const AJI = { IPC: 'IPC', ICL: 'ICL', PROMEDIO: 'Promedio IPC + ICL' };

// ---------- utilidades ----------
const s10 = (d) => String(d || '').slice(0, 10);
const pad = (n) => String(n).padStart(2, '0');
const hoyAR = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const addD = (d, n) => { const t = new Date(s10(d) + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const addM = (d, n) => {
  const [y, m, dd] = s10(d).split('-').map(Number), t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(Math.min(dd || 1, last))}`;
};
const fd = (d) => (d ? s10(d).split('-').reverse().join('/') : '');
const my = (d) => (d ? MESES[+String(d).slice(5, 7) - 1] + ' ' + String(d).slice(0, 4) : '');
const nf = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 });
const money = (v, mon) => (v == null || v === '' ? '—' : (mon === 'USD' ? 'USD ' : '$ ') + nf.format(+v));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s || '').trim().toUpperCase();

// ---------- armado de HTML ----------
const CSS_T = 'border-collapse:collapse;width:100%;font:13px Arial,sans-serif;margin:6px 0 18px';
const CSS_TH = 'text-align:left;background:#F4F4F5;color:#52525B;padding:6px 8px;border-bottom:1px solid #E4E4E7;font-size:11px;text-transform:uppercase';
const CSS_TD = 'padding:6px 8px;border-bottom:1px solid #F1F1F3;vertical-align:top';
function tabla(cols, filas) {
  if (!filas.length) return '<p style="font:13px Arial;color:#71717A;margin:4px 0 16px">Nada para mostrar.</p>';
  return `<table style="${CSS_T}"><tr>${cols.map((c) => `<th style="${CSS_TH}">${esc(c)}</th>`).join('')}</tr>` +
    filas.map((f, i) => `<tr style="background:${i % 2 ? '#FAFAF9' : '#fff'}">${f.map((v) => `<td style="${CSS_TD}">${v}</td>`).join('')}</tr>`).join('') + '</table>';
}
const h2 = (t, color = '#27272A') => `<h2 style="font:bold 16px Arial;color:${color};margin:22px 0 4px">${t}</h2>`;
const h3 = (t) => `<h3 style="font:bold 13px Arial;color:#3F3F46;margin:10px 0 2px;text-transform:uppercase">${t}</h3>`;
const marco = (titulo, cuerpo) => `<!doctype html><html><body style="margin:0;background:#F4F3EF"><div style="max-width:900px;margin:0 auto;padding:20px;background:#fff;font:14px Arial,sans-serif;color:#27272A">
<h1 style="font:bold 19px Arial;margin:0 0 4px">${titulo}</h1>${cuerpo}
<p style="font:11px Arial;color:#A1A1AA;margin-top:24px">Aviso automático del sistema INMUEBLES AMIA.</p></div></body></html>`;
const totales = (items) => {
  const t = { ARS: 0, USD: 0 };
  items.forEach((x) => { t[x.moneda === 'USD' ? 'USD' : 'ARS'] += +x.importe || 0; });
  return money(t.ARS, 'ARS') + (t.USD ? ' + ' + money(t.USD, 'USD') : '');
};

// ---------- MAIL 1: deuda de impuestos y alquileres ----------
export function armarDeuda(d, hoy, diaVto = 10) {
  const dow = (new Date(hoy + 'T00:00:00Z').getUTCDay() + 6) % 7, lunes = addD(hoy, -dow), domingo = addD(lunes, 6), mesAct = hoy.slice(0, 7);
  const P = new Map(d.prop.map((p) => [p.id, p])), PER = new Map(d.per.map((x) => [x.id, x]));
  const dir = (id) => (P.get(id) || {}).direccion || '(sin inmueble)';
  const items = [];
  // Impuestos (todos, menos EXENTO y NO PAGAR)
  const IMP = new Map(d.imp.filter((i) => !EXCLUIR_IMP.includes(norm(i.forma_pago))).map((i) => [i.id, i]));
  for (const z of d.ipe) {
    const i = IMP.get(z.impuesto); if (!i || z.pagado === true) continue;
    const v = s10(z.vencimiento), base = { tipo: 'imp', inq: norm(i.forma_pago) === FORMA_INQ, dir: dir(i.inmueble), concepto: i.concepto || i.tipo || '', forma: i.forma_pago || 'Sin forma de pago', cliente: i.nro_cliente || '', periodo: my(z.periodo), importe: z.importe, moneda: 'ARS' };
    if (v) { if (v <= domingo) items.push({ ...base, fecha: v, grupo: v >= lunes ? 'semana' : 'vencido' }); }
    else if (s10(z.periodo).slice(0, 7) <= mesAct) items.push({ ...base, fecha: '', grupo: 'sinfecha' });
  }
  // Alquileres (contratos activos; cada mes desde DESDE_ALQ sin pago confirmado es deuda)
  for (const c of d.con) {
    if (c.activo === false) continue;
    let m = s10(c.inicio).slice(0, 7); if (!m || m < DESDE_ALQ) m = DESDE_ALQ;
    const fin = s10(c.fin).slice(0, 7);
    for (; m <= mesAct; m = addM(m + '-01', 1).slice(0, 7)) {
      if (fin && m > fin) break;
      const due = addM(m + '-' + pad(diaVto), 0); if (due > domingo) continue;
      const pg = d.cpa.find((y) => y.contrato === c.id && s10(y.periodo).slice(0, 7) === m);
      if (pg && pg.pagado === true) continue;
      items.push({ tipo: 'alq', dir: dir(c.inmueble), inquilino: (PER.get(c.inquilino) || {}).nombre || '', periodo: my(m + '-01'), fecha: due, grupo: due >= lunes ? 'semana' : 'vencido',
        importe: pg && pg.importe != null ? pg.importe : c.monto, moneda: c.moneda || 'ARS', nota: pg ? 'No figura como pagado' : 'Mes sin cargar' });
    }
  }
  const inqItems = items.filter((x) => x.inq).sort((a, b) => ['semana', 'vencido', 'sinfecha'].indexOf(a.grupo) - ['semana', 'vencido', 'sinfecha'].indexOf(b.grupo) || (a.fecha || '').localeCompare(b.fecha || '') || a.dir.localeCompare(b.dir));
  const principales = items.filter((x) => !x.inq);
  items.length = 0; items.push(...principales);
  const by = (g, t) => items.filter((x) => x.grupo === g && x.tipo === t).sort((a, b) => (a.fecha || '').localeCompare(b.fecha || '') || a.dir.localeCompare(b.dir));
  const fImp = (l) => tabla(['Vence', 'Inmueble', 'Impuesto / servicio', 'Período', 'Importe', 'Forma de pago', 'N° cliente'],
    l.map((x) => [fd(x.fecha) || '—', `<b>${esc(x.dir)}</b>`, esc(x.concepto), esc(x.periodo), money(x.importe, 'ARS'), esc(x.forma), esc(x.cliente)]));
  const fAlq = (l) => tabla(['Vence', 'Inmueble', 'Inquilino', 'Mes', 'Importe', 'Situación'],
    l.map((x) => [fd(x.fecha), `<b>${esc(x.dir)}</b>`, esc(x.inquilino), esc(x.periodo), money(x.importe, x.moneda), esc(x.nota)]));
  const sem = items.filter((x) => x.grupo === 'semana'), ven = items.filter((x) => x.grupo === 'vencido'), sf = items.filter((x) => x.grupo === 'sinfecha');
  const resumen = `<p style="margin:6px 0 0">Vence esta semana (${fd(lunes)} al ${fd(domingo)}): <b>${sem.length}</b> · ${totales(sem)}<br>
Vencido sin pagar: <b>${ven.length}</b> · ${totales(ven)}${sf.length ? `<br>Impuestos sin pagar y sin vencimiento cargado: <b>${sf.length}</b> · ${totales(sf)}` : ''}${inqItems.length ? `<br>Aparte, impuestos a cargo de inquilinos (INQUILINOS - PROPIETARIOS) sin marcar como pagados: <b>${inqItems.length}</b> · ${totales(inqItems)}` : ''}</p>
<p style="font-size:12px;color:#71717A;margin:4px 0 0">Alquileres: vencen el día ${diaVto} de cada mes; se controla desde ${my(DESDE_ALQ + '-01').toLowerCase()} y un mes sin cargar cuenta como deuda. Impuestos: no incluye EXENTO ni NO PAGAR.</p>`;
  const EST = { semana: 'Vence esta semana', vencido: 'Vencido', sinfecha: 'Sin vencimiento cargado' };
  const bloqueInq = inqItems.length ? h2('4. Impuestos a cargo de inquilinos (INQUILINOS - PROPIETARIOS) sin marcar como pagados', '#6D28D9') +
    '<p style="font-size:12px;color:#71717A;margin:2px 0 4px">Los paga el inquilino. Si ya están pagos, marcalos como pagados en la app para que no vuelvan a aparecer.</p>' +
    tabla(['Situación', 'Vence', 'Inmueble', 'Impuesto / servicio', 'Período', 'Importe', 'N° cliente'],
      inqItems.map((x) => [x.grupo === 'semana' ? `<b style="color:#B45309">${EST[x.grupo]}</b>` : esc(EST[x.grupo]), fd(x.fecha) || '—', `<b>${esc(x.dir)}</b>`, esc(x.concepto), esc(x.periodo), money(x.importe, 'ARS'), esc(x.cliente)])) : '';
  const hay = items.length || inqItems.length;
  const cuerpo = hay ? resumen +
    h2('1. Vence esta semana', '#B45309') + h3('Alquileres') + fAlq(by('semana', 'alq')) + h3('Impuestos') + fImp(by('semana', 'imp')) +
    h2('2. Vencido sin pagar', '#B91C1C') + h3('Alquileres') + fAlq(by('vencido', 'alq')) + h3('Impuestos') + fImp(by('vencido', 'imp')) +
    (sf.length ? h2('3. Impuestos sin pagar y sin fecha de vencimiento cargada') + fImp(by('sinfecha', 'imp')) : '') + bloqueInq
    : '<p>No hay impuestos ni alquileres pendientes. 🎉</p>';
  const asunto = `Deuda de impuestos y alquileres · semana del ${fd(lunes)} al ${fd(domingo)}` + (hay ? ` (${sem.length} vencen esta semana, ${ven.length} vencidos${inqItems.length ? ', ' + inqItems.length + ' de inquilinos' : ''})` : ' · sin deuda');
  return { asunto, html: marco('Deuda de impuestos y alquileres', cuerpo), cantidad: items.length, semana: sem.length, vencidos: ven.length, sinFecha: sf.length, inquilinos: inqItems.length };
}

// ---------- MAIL 2: alquileres que aumentan el mes siguiente ----------
async function bcra(id, desde, hasta) {
  let out = [], off = 0;
  for (let n = 0; n < 20; n++) {
    const r = await fetch(`https://api.bcra.gob.ar/estadisticas/v4.0/monetarias/${id}?desde=${desde}&hasta=${hasta}&limit=1000&offset=${off}`);
    if (!r.ok) throw new Error('el Banco Central respondió ' + r.status);
    const j = await r.json(), det = ((j.results || [])[0] || {}).detalle || [], cnt = ((j.metadata || {}).resultset || {}).count || 0;
    out = out.concat(det); off += det.length; if (!det.length || off >= cnt) break;
  }
  return out;
}
export async function cargarIndices(hoy) {
  const [icl, ipc] = await Promise.all([bcra(40, '2020-06-01', hoy), bcra(27, '2019-01-01', hoy)]);
  const I = new Map(icl.map((x) => [s10(x.fecha), +x.valor]));
  return { icl: I, iclD: [...I.keys()].sort(), ipc: new Map(ipc.map((x) => [String(x.fecha).slice(0, 7), +x.valor])) };
}
export function armarAumentos(d, idx, hoy) {
  const nm = addM(hoy.slice(0, 7) + '-01', 1).slice(0, 7);
  const P = new Map(d.prop.map((p) => [p.id, p])), PER = new Map(d.per.map((x) => [x.id, x]));
  const iclAt = (f) => { if (!idx) return null; let r = null; for (const k of idx.iclD) { if (k <= f) r = k; else break; } return r == null ? null : { f: r, v: idx.icl.get(r) }; };
  const vig = d.con.filter((c) => c.activo !== false && (!c.fin || s10(c.fin) >= hoy));
  const sinDatos = vig.filter((c) => c.ajuste_indice !== 'MANUAL' && (!c.ajuste_indice || !c.ajuste_meses || !c.base_fecha || c.monto == null));
  const filas = [];
  for (const c of vig) {
    if (!AJI[c.ajuste_indice] || !c.ajuste_meses || !c.base_fecha || c.monto == null) continue;
    const prox = addM(c.base_fecha, +c.ajuste_meses); if (prox.slice(0, 7) !== nm) continue;
    let ci = null, cp = null; const notas = [];
    if (!idx) notas.push('No se pudieron consultar los índices del Banco Central');
    else {
      if (c.ajuste_indice !== 'IPC') {
        const a = iclAt(s10(c.base_fecha)), b = iclAt(prox);
        if (a && b) { ci = b.v / a.v; if (b.f < prox) notas.push(`ICL estimado con el último publicado (${fd(b.f)})`); }
        else notas.push('Falta el ICL');
      }
      if (c.ajuste_indice !== 'ICL') {
        const ms = [...Array(+c.ajuste_meses)].map((_, i) => addM(s10(c.base_fecha).slice(0, 7) + '-01', i - IPC_LAG).slice(0, 7));
        // Los meses que todavía no se publicaron se estiman con el último IPC publicado
        const miss = ms.filter((m) => !idx.ipc.has(m)), ult = [...idx.ipc.keys()].sort().pop(), uv = ult ? idx.ipc.get(ult) : null;
        if (uv != null) cp = ms.reduce((t, m) => t * (1 + (idx.ipc.has(m) ? idx.ipc.get(m) : uv) / 100), 1);
        if (miss.length) notas.push('IPC de ' + miss.map((m) => my(m + '-01').toLowerCase()).join(' y ') + ' estimado con el último publicado (' + my(ult + '-01').toLowerCase() + ': ' + nf.format(uv) + '%)');
      }
    }
    const coef = ci != null && cp != null ? (ci + cp) / 2 : (ci != null ? ci : cp);
    filas.push({ c, prox, coef, nuevo: coef ? Math.round(+c.monto * coef) : null, notas });
  }
  filas.sort((a, b) => a.prox.localeCompare(b.prox) || String((P.get(a.c.inmueble) || {}).direccion).localeCompare(String((P.get(b.c.inmueble) || {}).direccion)));
  const mesTxt = my(nm + '-01');
  const t = tabla(['Ajusta el', 'Inmueble', 'Inquilino', 'Índice', 'Monto actual', 'Aumento estimado', 'Monto estimado', 'Nota'],
    filas.map(({ c, prox, coef, nuevo, notas }) => [fd(prox), `<b>${esc((P.get(c.inmueble) || {}).direccion || '')}</b>`, esc((PER.get(c.inquilino) || {}).nombre || ''),
      esc(AJI[c.ajuste_indice]) + `<br><span style="color:#71717A">cada ${c.ajuste_meses} meses</span>`, money(c.monto, c.moneda),
      coef ? `<b>+${nf.format((coef - 1) * 100)}%</b>` : '—', nuevo ? `<b>${money(nuevo, c.moneda)}</b>` : '—', esc(notas.join(' · '))]));
  const cuerpo = `<p style="margin:6px 0 0">Contratos que ajustan en <b>${mesTxt.toLowerCase()}</b>: <b>${filas.length}</b>.</p>
<p style="font-size:12px;color:#71717A;margin:4px 0 0">Los montos son estimados: el IPC de los últimos meses del período todavía no está publicado. El monto definitivo se aplica desde la app (Alquileres → Ajustes de alquiler) cuando estén todos los índices.</p>`
    + h2('Aumentos de ' + mesTxt.toLowerCase()) + t
    + (sinDatos.length ? h2('Contratos vigentes sin datos de ajuste', '#B45309') + `<p style="font-size:13px;margin:4px 0">Estos no se pueden calcular hasta completar índice, meses y "rige desde" en la ficha:</p>` +
      tabla(['Inmueble', 'Forma de incremento (planilla)'], sinDatos.map((c) => [`<b>${esc((P.get(c.inmueble) || {}).direccion || '')}</b>`, esc(c.forma_incremento || '—')])) : '');
  return { asunto: `Aumentos de alquiler de ${mesTxt.toLowerCase()} · ${filas.length} contratos`, html: marco('Alquileres que aumentan en ' + mesTxt.toLowerCase(), cuerpo), cantidad: filas.length, sinDatos: sinDatos.length };
}

// ---------- datos, envío y servidor ----------
async function leerTodo(tabla) {
  const url = ENV('SUPABASE_URL'), key = ENV('SUPABASE_SERVICE_ROLE_KEY');
  let out = [], off = 0;
  for (let n = 0; n < 100; n++) {
    const r = await fetch(`${url}/rest/v1/${tabla}?select=*&order=id&limit=1000&offset=${off}`, { headers: { apikey: key, Authorization: 'Bearer ' + key } });
    if (!r.ok) throw new Error(`No se pudo leer ${tabla}: ${r.status} ${await r.text()}`);
    const j = await r.json(); out = out.concat(j); off += j.length; if (j.length < 1000) break;
  }
  return out;
}
// El asunto va sin acentos ni símbolos: algunos programas de envío lo arman mal y el mail llega "desarmado".
const asciiAsunto = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[·–—]/g, '-').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim().slice(0, 150);
async function enviar(mail, destinatarios) {
  const user = ENV('GMAIL_USER'), pass = ENV('GMAIL_APP_PASSWORD').replace(/\s+/g, '');
  if (!user || !pass) throw new Error('Faltan los secretos GMAIL_USER o GMAIL_APP_PASSWORD');
  const subject = asciiAsunto(mail.asunto), texto = 'Este aviso se ve mejor en un programa de correo que muestre HTML.';
  try {
    // nodemailer: arma el mail (asunto, acentos y HTML) de forma estándar
    const nodemailer = (await import('npm:nodemailer@6.9.16')).default;
    const t = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } });
    await t.sendMail({ from: `"INMUEBLES AMIA" <${user}>`, to: destinatarios.join(', '), subject, text: texto, html: mail.html, textEncoding: 'base64' });
    return 'nodemailer';
  } catch (e) {
    if (/auth|535|534|Username and Password/i.test(String(e && e.message))) throw e; // clave de Gmail mal: no tiene sentido reintentar
    console.error('nodemailer falló, se usa denomailer', e);
    const { SMTPClient } = await import('https://deno.land/x/denomailer@1.6.0/mod.ts');
    const client = new SMTPClient({ connection: { hostname: 'smtp.gmail.com', port: 465, tls: true, auth: { username: user, password: pass } } });
    try { await client.send({ from: `INMUEBLES AMIA <${user}>`, to: destinatarios, subject, content: texto, html: mail.html }); }
    finally { await client.close(); }
    return 'denomailer';
  }
}
async function atender(req) {
  const u = new URL(req.url), q = (k) => u.searchParams.get(k);
  const token = req.headers.get('x-avisos-token') || q('token');
  if (!ENV('AVISOS_TOKEN') || token !== ENV('AVISOS_TOKEN')) return new Response('No autorizado', { status: 401 });
  try {
    const tipo = q('tipo') === 'aumentos' ? 'aumentos' : 'deuda', hoy = /^\d{4}-\d{2}-\d{2}$/.test(q('hoy') || '') ? q('hoy') : hoyAR();
    const [prop, per, con] = await Promise.all(['propiedades', 'personas', 'contratos'].map(leerTodo));
    let mail;
    if (tipo === 'deuda') {
      const [imp, ipe, cpa] = await Promise.all(['impuestos', 'impuestos_periodos', 'alquiler_pagos'].map(leerTodo));
      mail = armarDeuda({ prop, per, con, imp, ipe, cpa }, hoy, +ENV('DIA_VENCIMIENTO_ALQUILER', '10') || 10);
    } else {
      let idx = null; try { idx = await cargarIndices(hoy); } catch (e) { console.error('BCRA', e); }
      mail = armarAumentos({ prop, per, con }, idx, hoy);
    }
    if (q('prueba')) mail.asunto = '[PRUEBA] ' + mail.asunto;
    if (q('ver')) return new Response(mail.html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const dest = ENV('AVISOS_DESTINATARIOS').split(/[,;\s]+/).filter(Boolean);
    if (!dest.length) throw new Error('Falta el secreto AVISOS_DESTINATARIOS');
    const via = await enviar(mail, dest);
    return Response.json({ ok: true, tipo, hoy, asunto: asciiAsunto(mail.asunto), destinatarios: dest, via });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false, error: String((e && e.message) || e) }, { status: 500 });
  }
}
if (typeof Deno !== 'undefined') Deno.serve(atender);
