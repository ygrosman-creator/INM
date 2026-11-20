// Supabase Edge Function "avisos" · INMUEBLES AMIA
// Arma y manda por mail (desde una cuenta de Gmail) dos avisos:
//   ?tipo=deuda     -> todos los lunes 7:30: impuestos y alquileres sin pagar (primero lo que vence esa semana)
//   ?tipo=aumentos  -> los días 20 a las 8:00: alquileres que ajustan el mes siguiente
//   ?tipo=respaldo  -> los viernes a las 16:00: copia de seguridad de toda la base en un .zip adjunto
//                      (va a RESPALDO_DESTINATARIOS; si ese secreto no está, a AVISOS_DESTINATARIOS)
//   ?tipo=comodatos -> todos los días a las 8:00: solo manda mail si a algún comodato le faltan exactamente 3 meses
//                      para vencer (va a COMODATOS_DESTINATARIOS; si ese secreto no está, a jsegal y ygrosman)
// Otros parámetros:  &ver=1 (muestra el mail en el navegador, NO lo manda; en el respaldo descarga el .zip)
//                    &prueba=1 (agrega [PRUEBA] al asunto)
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

// ---------- MAIL 3: comodatos que vencen dentro de 3 meses ----------
// Se ejecuta todos los días; manda mail SOLO el día en que a un comodato le faltan exactamente 3 meses para vencer.
export function armarComodatos(d, hoy, prueba = false) {
  const PER = new Map(d.per.map((x) => [x.id, x]));
  const quienes = (p) => d.vin.filter((v) => v.inmueble === p.id && /comodat/i.test(v.vinculo || '')).map((v) => (PER.get(v.persona) || {}).nombre).filter(Boolean).join(', ');
  const con = d.prop.filter((p) => p.comodato_vence && !p.comodato_sin_vencimiento && !(p.etiquetas || []).map(norm).includes('VENDIDO'));
  const hoyAviso = con.filter((p) => addM(s10(p.comodato_vence), -3) === hoy).sort((a, b) => String(a.direccion).localeCompare(String(b.direccion)));
  const prox = con.filter((p) => s10(p.comodato_vence) >= hoy && s10(p.comodato_vence) <= addM(hoy, 12)).sort((a, b) => s10(a.comodato_vence).localeCompare(s10(b.comodato_vence)));
  const fila = (p) => [`<b>${esc(p.direccion || '')}</b>`, esc(p.localidad || ''), `<b>${fd(p.comodato_vence)}</b>`, esc(quienes(p) || '—')];
  const cols = ['Inmueble', 'Localidad', 'Vence el comodato', 'Comodatario'];
  if (!hoyAviso.length && !prueba) return null;
  const cuerpo = (hoyAviso.length
    ? `<p style="margin:6px 0 0">Faltan <b>3 meses</b> para que venza${hoyAviso.length > 1 ? 'n estos comodatos' : ' este comodato'}:</p>` + tabla(cols, hoyAviso.map(fila))
    : `<p style="margin:6px 0 0">Hoy (${fd(hoy)}) no hay comodatos a los que les falten exactamente 3 meses para vencer, así que este aviso no se mandaría.</p>`)
    + (prueba ? h2('Próximos vencimientos de comodatos (12 meses)') + tabla(cols, prox.map(fila)) : '');
  const asunto = hoyAviso.length ? `Comodato por vencer en 3 meses: ${hoyAviso.map((p) => p.direccion).join(', ')}` : 'Comodatos por vencer (prueba)';
  return { asunto, html: marco('Comodatos que vencen en 3 meses', cuerpo), cantidad: hoyAviso.length };
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
// ---------- copia de seguridad ----------
// Todas las tablas de la app. Cada una va en JSON (para restaurar) y en CSV (para abrir con Excel).
const TABLAS_RESPALDO = ['propiedades', 'personas', 'vinculos', 'documentos', 'causas', 'novedades_legales', 'sepelios', 'llaves',
  'impuestos', 'impuestos_periodos', 'contratos', 'alquiler_pagos', 'contratos_ajustes', 'reparaciones', 'presupuestos', 'pagos',
  'proveedores', 'opciones', 'perfiles', 'auditoria'];
async function leerTabla(tabla) {
  try { return await leerTodo(tabla); } catch (e) {
    // tablas sin columna "id": se leen sin ordenar
    const url = ENV('SUPABASE_URL'), key = ENV('SUPABASE_SERVICE_ROLE_KEY');
    let out = [], off = 0;
    for (let n = 0; n < 200; n++) {
      const r = await fetch(`${url}/rest/v1/${tabla}?select=*&limit=1000&offset=${off}`, { headers: { apikey: key, Authorization: 'Bearer ' + key } });
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      const j = await r.json(); out = out.concat(j); off += j.length; if (j.length < 1000) break;
    }
    return out;
  }
}
function csv(filas) {
  if (!filas.length) return '﻿';
  const cols = [...new Set(filas.flatMap((f) => Object.keys(f)))];
  const cel = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  // separador ";" y BOM para que Excel en castellano lo abra bien con acentos
  return '﻿' + [cols.join(';'), ...filas.map((f) => cols.map((c) => cel(f[c])).join(';'))].join('\r\n');
}
// Usuarios de la app (correo + rol), para volver a darles el mismo rol en un proyecto nuevo
async function leerUsuarios() {
  const url = ENV('SUPABASE_URL'), key = ENV('SUPABASE_SERVICE_ROLE_KEY');
  let out = [];
  for (let page = 1; page < 20; page++) {
    const r = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=200`, { headers: { apikey: key, Authorization: 'Bearer ' + key } });
    if (!r.ok) throw new Error(`usuarios: ${r.status}`);
    const j = await r.json(), us = j.users || [];
    out = out.concat(us.map((u) => ({ id: u.id, email: u.email })));
    if (us.length < 200) break;
  }
  return out;
}
// Orden de carga (primero las tablas de las que dependen las demás). "perfiles" no se carga: se arma con los usuarios nuevos.
const ORDEN_RESTAURAR = ['opciones', 'proveedores', 'propiedades', 'personas', 'vinculos', 'documentos', 'causas', 'novedades_legales',
  'sepelios', 'llaves', 'impuestos', 'impuestos_periodos', 'contratos', 'alquiler_pagos', 'contratos_ajustes', 'reparaciones',
  'presupuestos', 'pagos', 'auditoria'];
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
// Arma restaurar-1.sql, restaurar-2.sql... (cada uno de menos de ~1,5 MB para que el SQL Editor de Supabase lo acepte).
function armarRestaurar(datos, usuarios, perfiles, hoy) {
  const LIM = 1500000, partes = [];
  const sentencias = [];
  if ((datos.opciones || []).length) sentencias.push('-- opciones: se reemplazan las que trae la estructura por las del respaldo\ndelete from public.opciones;');
  for (const t of ORDEN_RESTAURAR) {
    const filas = datos[t] || [];
    // lotes de hasta ~300 KB cada uno
    for (let i = 0; i < filas.length;) {
      let j = i, tam = 0;
      while (j < filas.length && (j === i || tam < 300000)) { tam += JSON.stringify(filas[j]).length + 1; j++; }
      const lote = JSON.stringify(filas.slice(i, j));
      let tag = 'RJ'; while (lote.includes('$' + tag + '$')) tag += 'X';
      sentencias.push(`-- ${t} (filas ${i + 1} a ${j} de ${filas.length})\n` +
        `insert into public.${t} overriding system value select * from json_populate_recordset(null::public.${t}, $${tag}$${lote}$${tag}$) on conflict do nothing;`);
      i = j;
    }
    if (t === 'auditoria' && filas.length) sentencias.push(`select setval(pg_get_serial_sequence('public.auditoria', 'id'), (select coalesce(max(id), 0) + 1 from public.auditoria), false);`);
  }
  // Roles: se asignan por correo a los usuarios que ya se hayan creado en el proyecto nuevo
  const mail = new Map(usuarios.map((u) => [u.id, u.email]));
  const roles = perfiles.map((p) => [mail.get(p.user_id), p.rol]).filter(([m, r]) => m && r);
  if (roles.length) sentencias.push('-- Roles de los usuarios (crear antes los usuarios en Authentication -> Users)\n' +
    `insert into public.perfiles(user_id) select id from auth.users on conflict do nothing;\n` +
    roles.map(([m, r]) => `update public.perfiles set rol = ${lit(r)} where user_id in (select id from auth.users where lower(email) = lower(${lit(m)}));`).join('\n'));
  let cur = [];
  const cerrar = () => { if (cur.length) { partes.push(cur); cur = []; } };
  let tam = 0;
  for (const s of sentencias) { if (tam + s.length > LIM && cur.length) { cerrar(); tam = 0; } cur.push(s); tam += s.length; }
  cerrar();
  return partes.map((ss, i) => [
    `-- RESTAURAR DATOS · INMUEBLES AMIA · respaldo del ${fd(hoy)} · parte ${i + 1} de ${partes.length}`,
    '-- Ejecutar en orden (parte 1, 2, 3...) en el SQL Editor de un proyecto que YA tenga la estructura (estructura.sql). Ver RESTAURAR.txt.',
    '-- No borra datos (salvo la lista de opciones en la parte 1): si un registro ya existe, lo deja como está.',
    'begin;',
    '-- durante la carga no se controlan relaciones entre tablas ni se registra auditoría',
    'set local session_replication_role = replica;',
    ...ss,
    'commit;',
    i === partes.length - 1 ? '\n-- Control: cantidad de registros cargados\n' + ORDEN_RESTAURAR.map((t) => `select ${lit(t)} as tabla, count(*) as filas from public.${t}`).join('\nunion all ') + ';' : '',
  ].join('\n'));
}
async function armarRespaldo(hoy) {
  const { zipSync, strToU8 } = await import('npm:fflate@0.8.2');
  const archivos = {}, resumen = [], errores = [], datos = {};
  for (const t of TABLAS_RESPALDO) {
    try {
      const filas = await leerTabla(t);
      datos[t] = filas;
      archivos[`json/${t}.json`] = strToU8(JSON.stringify(filas, null, 1));
      archivos[`csv/${t}.csv`] = strToU8(csv(filas));
      resumen.push([t, filas.length]);
    } catch (e) { errores.push([t, String((e && e.message) || e).slice(0, 200)]); }
  }
  if (!resumen.length) throw new Error('No se pudo leer ninguna tabla: ' + errores.map((x) => x.join(': ')).join(' | '));
  let usuarios = [];
  try { usuarios = await leerUsuarios(); } catch (e) { errores.push(['usuarios', String((e && e.message) || e).slice(0, 200)]); }
  const mailDe = new Map(usuarios.map((u) => [u.id, u.email]));
  const listaUsuarios = (datos.perfiles || []).map((p) => `  ${mailDe.get(p.user_id) || '(usuario sin correo)'} - ${p.rol}`);
  const partes = armarRestaurar(datos, usuarios, datos.perfiles || [], hoy);
  partes.forEach((sql, i) => { archivos[`restaurar-${i + 1}.sql`] = strToU8(sql); });
  archivos['estructura.sql'] = strToU8(ESTRUCTURA);
  archivos['RESTAURAR.txt'] = strToU8('﻿' + [
    'CÓMO VOLVER A ARMAR TODO DESDE ESTE RESPALDO (por ejemplo, si se pierde el proyecto de Supabase)',
    '',
    '1) Crear un proyecto nuevo en supabase.com (New project). Anotar la contraseña de la base.',
    '2) SQL Editor -> New query: pegar TODO estructura.sql -> Run.',
    '   Crea las tablas, los permisos por rol, la auditoría y el espacio para archivos adjuntos.',
    '3) Authentication -> Users -> Add user -> Create new user, uno por cada usuario de esta lista',
    '   (con la contraseña que quieran y tildando "Auto Confirm User"):',
    ...(listaUsuarios.length ? listaUsuarios : ['  (no se pudo leer la lista de usuarios)']),
    `4) SQL Editor -> New query: pegar restaurar-1.sql -> Run. Después restaurar-2.sql, y así hasta el último (son ${partes.length}).`,
    '   Carga todos los datos y, al final, les da a los usuarios el mismo rol que tenían.',
    '   La última parte muestra cuántos registros quedaron en cada tabla: comparar con LEEME.txt.',
    '5) Project Settings -> API: copiar "Project URL" y la clave "anon public".',
    '   Ponerlas en config.js de la app (url y key), subirlo a GitHub y esperar el despliegue de Vercel.',
    '6) Avisos por mail y este respaldo semanal: volver a crear la función "avisos" con sus secretos',
    '   y programarla (INSTRUCTIVO-AVISOS-MAIL.txt, migracion-11 y migracion-12, cambiando en esos SQL',
    '   la dirección https://....supabase.co por la del proyecto nuevo).',
    '',
    'LO QUE ESTE RESPALDO NO TRAE:',
    '  - Los archivos adjuntos (PDF y fotos). Los registros de documentos vuelven, pero el archivo hay que subirlo de nuevo.',
    '  - Las contraseñas de los usuarios (se crean de nuevo en el paso 3).',
    '',
    'Si el SQL Editor rechaza un archivo por grande, avisar: se puede partir en archivos más chicos.',
  ].join('\r\n'));
  const leeme = [
    'COPIA DE SEGURIDAD - INMUEBLES AMIA',
    'Fecha: ' + fd(hoy) + ' (hora del servidor: ' + new Date().toISOString() + ')',
    '',
    'RESTAURAR.txt   : cómo volver a armar todo en un proyecto nuevo de Supabase.',
    'estructura.sql  : crea las tablas, permisos y auditoría (paso 2).',
    'restaurar-N.sql : carga todos los datos y los roles de los usuarios (paso 4).',
    'Carpeta csv/    : una planilla por tabla, para abrir con Excel (separador ";").',
    'Carpeta json/   : los mismos datos completos en formato JSON.',
    'No incluye los archivos adjuntos (PDF y fotos), que quedan en Supabase Storage.',
    '',
    'Tabla - cantidad de filas:',
    ...resumen.map(([t, n]) => `  ${t}: ${n}`),
    ...(errores.length ? ['', 'NO SE PUDIERON LEER:', ...errores.map(([t, m]) => `  ${t}: ${m}`)] : []),
  ].join('\r\n');
  archivos['LEEME.txt'] = strToU8('﻿' + leeme);
  const fecha = new Date(Date.now() - 3 * 3600e3);
  const zip = zipSync(archivos, { level: 9, mtime: fecha });
  const nombre = `respaldo-inmuebles-${hoy}.zip`, mb = zip.length / 1048576;
  const html = marco('Copia de seguridad semanal · ' + fd(hoy),
    `<p>Va adjunta la copia de seguridad de toda la base de datos (<b>${esc(nombre)}</b>, ${nf.format(+mb.toFixed(2))} MB).</p>
     <p>Adentro hay una planilla por tabla (carpeta <b>csv</b>, se abre con Excel) y los datos completos para restaurar (carpeta <b>json</b>). Los archivos adjuntos (PDF y fotos) no están incluidos.</p>` +
    tabla(['Tabla', 'Filas'], resumen.map(([t, n]) => [esc(t), nf.format(n)])) +
    (errores.length ? h2('No se pudieron leer', '#B91C1C') + tabla(['Tabla', 'Error'], errores.map(([t, m]) => [esc(t), esc(m)])) : '') +
    '<p style="color:#71717A;font-size:12px">Guardá este mail o el .zip en una carpeta segura (Drive, disco externo).</p>');
  return { asunto: 'Copia de seguridad INMUEBLES AMIA ' + fd(hoy), html, adjuntos: [{ nombre, datos: zip }], zip, nombre, mb };
}

// Estructura completa de la base (schema.sql + migracion-2 a migracion-10), va dentro del respaldo como estructura.sql
// Si se agrega una migración nueva que cree tablas o columnas, sumarla también acá.
const ESTRUCTURA = String.raw`-- ESTRUCTURA COMPLETA DE LA BASE · INMUEBLES AMIA
-- Crea todas las tablas, permisos, auditoría y el espacio de archivos en un proyecto NUEVO y VACÍO de Supabase.
-- Es la unión, en orden, de schema.sql y migracion-2 a migracion-10. Ejecutar UNA vez: SQL Editor -> New query -> pegar -> Run.
-- No carga datos: los datos se cargan después con restaurar-1.sql, restaurar-2.sql... del respaldo semanal.

-- =================== schema.sql ===================
-- Inmuebles | Reparaciones y Mantenimiento — ejecutar completo en Supabase → SQL Editor
create extension if not exists pgcrypto;

-- Roles: admin (aprueba presupuestos y edita), editor (edita), lector (solo consulta)
create table perfiles(user_id uuid primary key references auth.users on delete cascade, rol text not null default 'lector' check (rol in ('admin','editor','lector')));
alter table perfiles enable row level security;
create policy "ver mi perfil" on perfiles for select to authenticated using (user_id = auth.uid());
create function public.rol_actual() returns text language sql stable security definer set search_path=public as $$ select rol from perfiles where user_id = auth.uid() $$;
create function public.puede_editar() returns boolean language sql stable security definer set search_path=public as $$ select coalesce(public.rol_actual() in ('admin','editor'), false) $$;
create function public.nuevo_perfil() returns trigger language plpgsql security definer set search_path=public as $$ begin insert into perfiles(user_id) values (new.id) on conflict do nothing; return new; end $$;
create trigger al_crear_usuario after insert on auth.users for each row execute function public.nuevo_perfil();
insert into perfiles(user_id) select id from auth.users on conflict do nothing;

create table propiedades(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  codigo text unique, direccion text, localidad text, estado text, responsable text, obs text);
create table proveedores(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  nombre text, cuit text, rubro text, tel text, email text, facturacion text, condiciones text, obs text);
create table reparaciones(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  numero text unique, titulo text, prop uuid references propiedades on delete set null, prov uuid references proveedores on delete set null,
  solicitante text, categoria text, prioridad text, estado text, responsable text, "desc" text,
  "fechaSol" date, "fechaIni" date, "fechaFinPrev" date, "fechaFinReal" date,
  docs jsonb default '[]', novedades jsonb default '[]');
create table presupuestos(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  rep uuid references reparaciones on delete cascade, prov uuid references proveedores on delete set null,
  fecha date, monto numeric default 0, estado text, validez date, plazo text, condiciones text, "desc" text,
  "aprobadoPor" text, "fechaAprob" date, "aprobadoOriginal" numeric, archivo jsonb);
create table pagos(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  rep uuid references reparaciones on delete cascade, prov uuid references proveedores on delete set null,
  numero text, fecha date, monto numeric default 0, medio text, operacion text, factura text, por text, obs text, archivo jsonb);
create unique index un_aprobado_por_rep on presupuestos(rep) where estado = 'Aprobado';

-- Solo un admin puede aprobar presupuestos
create function public.solo_admin_aprueba() returns trigger language plpgsql as $$
begin
  if new.estado = 'Aprobado' and (tg_op = 'INSERT' or old.estado is distinct from 'Aprobado') and coalesce(public.rol_actual(),'') <> 'admin' then
    raise exception 'Solo un administrador puede aprobar presupuestos';
  end if; return new;
end $$;
create trigger aprobar_solo_admin before insert or update on presupuestos for each row execute function public.solo_admin_aprueba();

-- Seguridad (RLS) y tiempo real
do $$ declare t text; begin
  foreach t in array array['propiedades','proveedores','reparaciones','presupuestos','pagos'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "leer" on %I for select to authenticated using (true)', t);
    execute format('create policy "escribir" on %I for all to authenticated using (public.puede_editar()) with check (public.puede_editar())', t);
    execute format('alter publication supabase_realtime add table %I', t);
  end loop;
end $$;

-- Archivos adjuntos (bucket privado)
insert into storage.buckets(id, name, public) values ('adjuntos','adjuntos',false) on conflict do nothing;
create policy "adjuntos leer" on storage.objects for select to authenticated using (bucket_id = 'adjuntos');
create policy "adjuntos subir" on storage.objects for insert to authenticated with check (bucket_id = 'adjuntos' and public.puede_editar());

-- Después de crear tu usuario (Authentication → Users), hacete admin:
-- update perfiles set rol = 'admin' where user_id = (select id from auth.users where email = 'tu@correo.com');

-- =================== migracion-2.sql ===================
-- Ejecutar UNA vez en Supabase → SQL Editor (agrega el proveedor elegido a cada reparación)
alter table reparaciones add column if not exists prov uuid references proveedores on delete set null;
notify pgrst, 'reload schema';

-- =================== migracion-3-inmuebles.sql ===================
-- Fase 1 · Sistema de inmuebles. Ejecutar UNA vez en Supabase → SQL Editor.
-- Amplía la tabla "propiedades" existente; no borra nada.

-- 1) Listas editables por el equipo (etiquetas, vínculos, tipos de documento)
create table opciones(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  lista text not null check (lista in ('vinculo','tipo_documento','etiqueta','forma_pago','tipo_impuesto')),
  valor text not null, orden int default 0, unique (lista, valor));
insert into opciones(lista, valor, orden) values
 ('vinculo','Donante',1),('vinculo','Donante con usufructo',2),('vinculo','Testador',3),('vinculo','Inquilino',4),
 ('vinculo','Garante',5),('vinculo','Beneficiario',6),('vinculo','Comodatario',7),('vinculo','Heredero',8),
 ('tipo_documento','Escritura',1),('tipo_documento','Contrato de alquiler',2),('tipo_documento','Garantía',3),
 ('tipo_documento','Documentación sucesoria',4),('tipo_documento','Donación',5),('tipo_documento','Testamento',6),
 ('tipo_documento','Plano',7),('tipo_documento','Foto',8),('tipo_documento','Otro',9),
 ('etiqueta','ALQUILADO',1),
 ('etiqueta','EN ALQUILER',2),
 ('etiqueta','A LA VENTA',3),
 ('etiqueta','VENDIDO',4),
 ('etiqueta','COMODATO',5),
 ('etiqueta','USUFRUCTO DONANTE',6),
 ('etiqueta','SEDE AMIA',7),
 ('etiqueta','POSIBLE DONACIÓN',8),
 ('etiqueta','TESTAMENTO',9),
 ('etiqueta','OTROS',10),
 ('etiqueta','USUCAPIÓN',11),
 ('etiqueta','JUDICIALIZADO',12),
 ('etiqueta','LEGADO',13),
 ('etiqueta','VACÍO',14),
 ('etiqueta','OCUPADO',15),
 ('etiqueta','USURPADO',16),
 ('etiqueta','SUCESIÓN EN TRÁMITE',17),
 ('etiqueta','TASACIÓN PENDIENTE',18),
 ('forma_pago','INQUILINOS - PROPIETARIOS',1),
 ('forma_pago','TESOMPTC',2),
 ('forma_pago','DEBITOS FRANCES',3),
 ('forma_pago','T.C.',4),
 ('forma_pago','EXENTO',5),
 ('forma_pago','NO PAGAR',6),
 ('tipo_impuesto','ABL',1),
 ('tipo_impuesto','AYSA',2),
 ('tipo_impuesto','ARBA',3),
 ('tipo_impuesto','LUZ',4),
 ('tipo_impuesto','GAS',5),
 ('tipo_impuesto','EXPENSAS',6),
 ('tipo_impuesto','TELÉFONO',7),
 ('tipo_impuesto','TASA MUNICIPAL',8),
 ('tipo_impuesto','SEGURO',9),
 ('tipo_impuesto','OTRO',10);

-- 2) Ficha del inmueble. Las etiquetas (varias por inmueble) reemplazan al estado único
alter table propiedades
  add column if not exists tipo text,                       -- departamento, local, lote, PH, cementerio…
  add column if not exists m2 numeric,
  add column if not exists nomenclatura text,               -- nomenclatura catastral
  add column if not exists etiquetas text[] default '{}',   -- permite filtrar varias a la vez
  add column if not exists situacion_legal text,
  add column if not exists legal_actualizado timestamptz,   -- fecha automática de última actualización legal
  add column if not exists de_amia boolean default false,   -- DE AMIA: tenemos el título
  add column if not exists anio_venta int,                  -- para los VENDIDOS
  add column if not exists valor_venta numeric,
  add column if not exists moneda_venta text default 'USD'; -- las notas van en la columna existente "obs"
create index if not exists propiedades_etiquetas on propiedades using gin (etiquetas);

-- Las etiquetas se guardan siempre en MAYÚSCULAS, y OTRO / OTRA / OTRAS / OTROS se unifican en OTROS
create function public.etiquetas_mayuscula() returns trigger language plpgsql as $$
declare f text := '';
begin
  if tg_table_name = 'propiedades' then
    new.etiquetas := coalesce((select array_agg(distinct case when upper(trim(e)) in ('OTRO','OTRA','OTRAS') then 'OTROS' else upper(trim(e)) end)
                               from unnest(new.etiquetas) e where trim(e) <> ''), '{}');
  elsif new.lista = 'etiqueta' then
    new.valor := case when upper(trim(new.valor)) in ('OTRO','OTRA','OTRAS') then 'OTROS' else upper(trim(new.valor)) end;
  end if;
  return new;
end $$;

create trigger mayuscula_etiquetas_prop before insert or update on propiedades for each row execute function public.etiquetas_mayuscula();
create trigger mayuscula_etiquetas_opc  before insert or update on opciones     for each row execute function public.etiquetas_mayuscula();

-- 3) Personas y su vínculo con cada inmueble (varias por inmueble, varios inmuebles por persona)
create table personas(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  nombre text, apellido text, dni text, cuit text, nacimiento date, fallecimiento date,
  mail text, telefono text, otros text);
create table vinculos(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  inmueble uuid references propiedades on delete cascade, persona uuid references personas on delete cascade,
  vinculo text, desde date, hasta date, obs text);

-- 4) Documentos y fotos (el archivo vive en el bucket privado "adjuntos")
create table documentos(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  inmueble uuid references propiedades on delete cascade,
  tipo text, nombre text, fecha date, estado text default 'Disponible' check (estado in ('Disponible','Pendiente')),
  archivo jsonb, obs text);

-- 5) Legal: causas, bitácora y sepelios
create table causas(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  inmueble uuid references propiedades on delete cascade,
  tipo text default 'Usucapión', expediente text, caratula text, estado text, tasacion numeric, moneda text default 'USD');
create table novedades_legales(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  inmueble uuid references propiedades on delete cascade, causa uuid references causas on delete set null,
  fecha date default current_date, tipo text, texto text, por text);
create table sepelios(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  inmueble uuid references propiedades on delete cascade, persona uuid references personas on delete set null,
  origen text, servicio text, obs text);

-- La fecha de última actualización legal se completa sola
create function public.tocar_legal() returns trigger language plpgsql security definer set search_path=public as $$
begin
  update propiedades set legal_actualizado = now() where id = coalesce(new.inmueble, old.inmueble);
  return coalesce(new, old);
end $$;
create trigger legal_novedades after insert or update or delete on novedades_legales for each row execute function public.tocar_legal();
create trigger legal_causas    after insert or update or delete on causas            for each row execute function public.tocar_legal();
create trigger legal_sepelios  after insert or update or delete on sepelios          for each row execute function public.tocar_legal();

-- 6) Trazabilidad: cada alta, cambio o baja queda con fecha, hora y usuario
create table auditoria(
  id bigint generated always as identity primary key, cuando timestamptz default now(),
  usuario uuid, tabla text, registro uuid, accion text, antes jsonb, despues jsonb);
create function public.auditar() returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into auditoria(usuario, tabla, registro, accion, antes, despues)
  values (auth.uid(), tg_table_name, (coalesce(to_jsonb(new), to_jsonb(old))->>'id')::uuid, tg_op,
          case when tg_op <> 'INSERT' then to_jsonb(old) end, case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end $$;
do $$ declare t text; begin
  foreach t in array array['propiedades','personas','vinculos','documentos','causas','novedades_legales','sepelios'] loop
    execute format('create trigger auditar_%1$s after insert or update or delete on %1$I for each row execute function public.auditar()', t);
  end loop;
end $$;
alter table auditoria enable row level security;
create policy "solo admin ve auditoria" on auditoria for select to authenticated using (public.rol_actual() = 'admin');

-- 7) Seguridad y tiempo real (mismo esquema que el resto: leer todos, escribir editor/admin)
do $$ declare t text; begin
  foreach t in array array['opciones','personas','vinculos','documentos','causas','novedades_legales','sepelios'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "leer" on %I for select to authenticated using (true)', t);
    execute format('create policy "escribir" on %I for all to authenticated using (public.puede_editar()) with check (public.puede_editar())', t);
    execute format('alter publication supabase_realtime add table %I', t);
  end loop;
end $$;
notify pgrst, 'reload schema';

-- =================== migracion-4-impuestos.sql ===================
-- Impuestos de cada inmueble · ejecutar UNA vez, DESPUÉS de migracion-3-inmuebles.sql
-- Un impuesto (o servicio) pertenece a un inmueble y se actualiza mes a mes en impuestos_periodos.

create table impuestos(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  inmueble uuid references propiedades on delete cascade,
  concepto text,        -- impuesto o servicio tal como figura (EDESUR, AYSA, ABL exento nov 22…)
  tipo text,            -- ABL, AYSA, ARBA, LUZ, GAS, EXPENSAS, TELÉFONO… (lista editable en "opciones")
  nro_cliente text,     -- número de cliente o referencia; puede quedar vacío (por ejemplo, exentos)
  forma_pago text,      -- INQUILINOS - PROPIETARIOS, TESOMPTC, DEBITOS FRANCES, T.C., EXENTO, NO PAGAR…
  notas text);
create index impuestos_inmueble on impuestos(inmueble);

create table impuestos_periodos(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  impuesto uuid not null references impuestos on delete cascade,
  periodo date not null,      -- primer día del mes (2026-01-01 = enero 2026)
  importe numeric,
  vencimiento date,           -- con esto se arma el aviso semanal de vencimientos
  pagado boolean default false, fecha_pago date, obs text,
  unique (impuesto, periodo));
create index periodos_vencimiento on impuestos_periodos(vencimiento);

do $$ declare t text; begin
  foreach t in array array['impuestos','impuestos_periodos'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "leer" on %I for select to authenticated using (true)', t);
    execute format('create policy "escribir" on %I for all to authenticated using (public.puede_editar()) with check (public.puede_editar())', t);
    execute format('create trigger auditar_%1$s after insert or update or delete on %1$I for each row execute function public.auditar()', t);
    execute format('alter publication supabase_realtime add table %I', t);
  end loop;
end $$;
notify pgrst, 'reload schema';

-- =================== migracion-5-alquileres.sql ===================
-- Alquileres: contratos y pagos mensuales · ejecutar UNA vez, DESPUÉS de migracion-3 y migracion-4.
-- Un inquilino es una persona (tabla personas) vinculada al inmueble; el contrato guarda fechas, monto e incremento.

create table contratos(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  inmueble uuid references propiedades on delete cascade,
  inquilino uuid references personas on delete set null,
  descripcion text,            -- m², ambientes, etc.
  duracion_texto text,         -- tal como figuraba en la planilla
  inicio date, fin date, meses int,
  monto numeric, moneda text default 'ARS', fuente_monto text,
  forma_incremento text,       -- IPC, ICL, promedio IPC + ICL, etc.
  deposito text, inmobiliaria text,
  servicios_inquilino jsonb default '{}',   -- {"LUZ":true,"GAS":false,"ABL":true,...}
  activo boolean default true, obs text);
create index contratos_inmueble on contratos(inmueble);
create index contratos_fin on contratos(fin);

create table alquiler_pagos(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  contrato uuid not null references contratos on delete cascade,
  periodo date not null,       -- primer día del mes
  importe numeric,
  pagado boolean,              -- vacío = todavía sin confirmar
  fecha_pago date, obs text,
  unique (contrato, periodo));

do $$ declare t text; begin
  foreach t in array array['contratos','alquiler_pagos'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "leer" on %I for select to authenticated using (true)', t);
    execute format('create policy "escribir" on %I for all to authenticated using (public.puede_editar()) with check (public.puede_editar())', t);
    execute format('create trigger auditar_%1$s after insert or update or delete on %1$I for each row execute function public.auditar()', t);
    execute format('alter publication supabase_realtime add table %I', t);
  end loop;
end $$;
notify pgrst, 'reload schema';

-- =================== migracion-6-ajustes.sql ===================
-- Ajustes del lote 2 · ejecutar UNA vez, después de migracion-5.
-- 1) Llaves de cada inmueble, 2) fecha exacta de venta, 3) la situación legal cargada pasa a una nota con fecha.

create table llaves(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  inmueble uuid references propiedades on delete cascade,
  numero int, notas text);
create index llaves_inmueble on llaves(inmueble);

do $$ declare t text; begin
  foreach t in array array['llaves'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "leer" on %I for select to authenticated using (true)', t);
    execute format('create policy "escribir" on %I for all to authenticated using (public.puede_editar()) with check (public.puede_editar())', t);
    execute format('create trigger auditar_%1$s after insert or update or delete on %1$I for each row execute function public.auditar()', t);
    execute format('alter publication supabase_realtime add table %I', t);
  end loop;
end $$;

alter table propiedades add column if not exists fecha_venta date;

-- El texto legal que vino de las planillas pasa a UNA nota con la fecha de hoy (después la ordenás por fechas).
insert into novedades_legales(inmueble, fecha, tipo, texto, por)
select p.id, current_date, 'Carga inicial', p.situacion_legal, 'Carga inicial'
from propiedades p
where nullif(trim(p.situacion_legal), '') is not null
  and not exists (select 1 from novedades_legales n where n.inmueble = p.id and n.tipo = 'Carga inicial');

update propiedades set situacion_legal = null
where situacion_legal is not null
  and exists (select 1 from novedades_legales n where n.inmueble = propiedades.id and n.tipo = 'Carga inicial');

notify pgrst, 'reload schema';
select (select count(*) from llaves) as llaves, (select count(*) from novedades_legales where tipo = 'Carga inicial') as notas_legales_iniciales;

-- =================== migracion-7-ingreso.sql ===================
-- Fecha de ingreso del inmueble y sus notas · ejecutar UNA vez.
alter table propiedades add column if not exists fecha_ingreso date;
alter table propiedades add column if not exists notas_ingreso text;
notify pgrst, 'reload schema';
select count(*) as columnas_nuevas from information_schema.columns where table_name = 'propiedades' and column_name in ('fecha_ingreso','notas_ingreso');   -- tiene que dar 2

-- =================== migracion-8-ajustes.sql ===================
-- Ajustes de etiquetas, usucapión y comodato · ejecutar UNA vez (después de migracion-7).

-- 1) Campos nuevos
alter table propiedades add column if not exists usucapion_anios int;     -- años de usucapión (o directamente el año)
alter table propiedades add column if not exists comodato_vence date;    -- vencimiento del comodato

-- 2) Etiquetas: OCUPADO pasa a USURPADO; se sacan OTROS y SUCESIÓN EN TRÁMITE
update propiedades
set etiquetas = (
  select coalesce(array_agg(distinct case when e = 'OCUPADO' then 'USURPADO' else e end), '{}')
  from unnest(etiquetas) e
  where e not in ('OTROS', 'SUCESIÓN EN TRÁMITE'))
where etiquetas && array['OCUPADO', 'OTROS', 'SUCESIÓN EN TRÁMITE'];

delete from opciones where lista = 'etiqueta' and valor in ('OCUPADO', 'OTROS', 'SUCESIÓN EN TRÁMITE');

notify pgrst, 'reload schema';
select
  (select count(*) from information_schema.columns where table_name = 'propiedades' and column_name in ('usucapion_anios','comodato_vence')) as columnas_nuevas,   -- tiene que dar 2
  (select count(*) from propiedades where etiquetas && array['OCUPADO','OTROS','SUCESIÓN EN TRÁMITE']) as con_etiquetas_viejas;                                              -- tiene que dar 0

-- =================== migracion-9-comodato.sql ===================
-- Comodato sin fecha de vencimiento · ejecutar UNA vez (después de migracion-8).
-- Si está tildado, el comodato se considera VIGENTE en los informes aunque no tenga fecha.
alter table propiedades add column if not exists comodato_sin_vencimiento boolean default false;
notify pgrst, 'reload schema';
select count(*) as columnas_nuevas from information_schema.columns where table_name = 'propiedades' and column_name = 'comodato_sin_vencimiento';   -- tiene que dar 1

-- =================== migracion-10-ajustes-alquiler.sql ===================
-- Ajuste automático de alquileres (sugerir y confirmar) · ejecutar UNA vez, después de migracion-9.
-- 1) Cada contrato guarda con qué índice ajusta, cada cuántos meses y desde cuándo rige el monto actual.
-- 2) Cada ajuste aprobado queda registrado en contratos_ajustes (quién, cuándo, índice, monto anterior y nuevo).
-- 3) Se completan los datos a partir del texto de "forma de incremento" que ya estaba cargado. Revisar los que queden vacíos.

alter table contratos add column if not exists ajuste_indice text check (ajuste_indice in ('IPC','ICL','PROMEDIO','MANUAL'));
alter table contratos add column if not exists ajuste_meses int check (ajuste_meses between 1 and 24);
alter table contratos add column if not exists base_fecha date;   -- desde cuándo rige el monto actual (último ajuste o inicio)

create table if not exists contratos_ajustes(
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  contrato uuid not null references contratos on delete cascade,
  fecha date,              -- fecha desde la que rige el monto nuevo
  indice text, detalle text,
  coef numeric, monto_anterior numeric, monto_nuevo numeric,
  por text);
create index if not exists contratos_ajustes_contrato on contratos_ajustes(contrato);

do $$ declare t text; begin
  foreach t in array array['contratos_ajustes'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "leer" on %I for select to authenticated using (true)', t);
    execute format('create policy "escribir" on %I for all to authenticated using (public.puede_editar()) with check (public.puede_editar())', t);
    execute format('create trigger auditar_%1$s after insert or update or delete on %1$I for each row execute function public.auditar()', t);
    execute format('alter publication supabase_realtime add table %I', t);
  end loop;
end $$;

-- Completar índice y frecuencia a partir del texto (solo donde todavía están vacíos)
update contratos set
  ajuste_indice = case
    when upper(forma_incremento) like '%IPC%' and upper(forma_incremento) like '%ICL%' then 'PROMEDIO'
    when upper(forma_incremento) like '%IPC%' then 'IPC'
    when upper(forma_incremento) like '%ICL%' then 'ICL' end,
  ajuste_meses = case
    when upper(forma_incremento) like '%CUATRIMESTRAL%' then 4
    when upper(forma_incremento) like '%TRIMESTRAL%' then 3
    when upper(forma_incremento) like '%SEMESTRAL%' then 6
    when upper(forma_incremento) like '%ANUAL O CADA%' then null   -- ambiguo: completar a mano
    when upper(forma_incremento) like '%ANUAL%' then 12 end
where ajuste_indice is null and ajuste_meses is null;

-- Se supone que el "alquiler actual" cargado rige desde el último ajuste que correspondía según el inicio.
update contratos set base_fecha = (inicio + make_interval(months => (
    ((extract(year from age(current_date, inicio))*12 + extract(month from age(current_date, inicio)))::int / ajuste_meses) * ajuste_meses)))::date
where base_fecha is null and inicio is not null and ajuste_meses is not null and inicio <= current_date;

notify pgrst, 'reload schema';

-- Control: cómo quedó cada contrato (los que tengan índice o meses vacíos hay que completarlos en la ficha)
select p.direccion, c.forma_incremento, c.ajuste_indice, c.ajuste_meses, c.inicio, c.base_fecha, c.monto
from contratos c left join propiedades p on p.id = c.inmueble
order by (c.ajuste_indice is null or c.ajuste_meses is null) desc, p.direccion;
`;

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
    let attachments;
    if (mail.adjuntos && mail.adjuntos.length) {
      const { Buffer } = await import('node:buffer');
      attachments = mail.adjuntos.map((a) => ({ filename: a.nombre, content: Buffer.from(a.datos), contentType: 'application/zip' }));
    }
    await t.sendMail({ from: `"INMUEBLES AMIA" <${user}>`, to: destinatarios.join(', '), subject, text: texto, html: mail.html, textEncoding: 'base64', attachments });
    return 'nodemailer';
  } catch (e) {
    if (/auth|535|534|Username and Password/i.test(String(e && e.message))) throw e; // clave de Gmail mal: no tiene sentido reintentar
    console.error('nodemailer falló, se usa denomailer', e);
    const { SMTPClient } = await import('https://deno.land/x/denomailer@1.6.0/mod.ts');
    const client = new SMTPClient({ connection: { hostname: 'smtp.gmail.com', port: 465, tls: true, auth: { username: user, password: pass } } });
    const attachments = (mail.adjuntos || []).map((a) => ({ filename: a.nombre, content: a.datos, encoding: 'binary', contentType: 'application/zip' }));
    try { await client.send({ from: `INMUEBLES AMIA <${user}>`, to: destinatarios, subject, content: texto, html: mail.html, attachments }); }
    finally { await client.close(); }
    return 'denomailer';
  }
}
async function atender(req) {
  const u = new URL(req.url), q = (k) => u.searchParams.get(k);
  const token = req.headers.get('x-avisos-token') || q('token');
  if (!ENV('AVISOS_TOKEN') || token !== ENV('AVISOS_TOKEN')) return new Response('No autorizado', { status: 401 });
  try {
    const tipo = ['aumentos', 'respaldo', 'comodatos'].includes(q('tipo')) ? q('tipo') : 'deuda', hoy = /^\d{4}-\d{2}-\d{2}$/.test(q('hoy') || '') ? q('hoy') : hoyAR();
    if (tipo === 'respaldo') {
      const r = await armarRespaldo(hoy);
      // &ver=1: descarga el .zip directamente, sin mandar mail
      if (q('ver')) return new Response(r.zip, { headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${r.nombre}"` } });
      if (r.mb > 24) throw new Error(`El respaldo pesa ${r.mb.toFixed(1)} MB y Gmail no acepta adjuntos de más de 25 MB`);
      if (q('prueba')) r.asunto = '[PRUEBA] ' + r.asunto;
      const dest = (ENV('RESPALDO_DESTINATARIOS') || ENV('AVISOS_DESTINATARIOS')).split(/[,;\s]+/).filter(Boolean);
      if (!dest.length) throw new Error('Falta el secreto RESPALDO_DESTINATARIOS');
      const via = await enviar(r, dest);
      return Response.json({ ok: true, tipo, hoy, asunto: asciiAsunto(r.asunto), destinatarios: dest, mb: +r.mb.toFixed(2), via });
    }
    if (tipo === 'comodatos') {
      const [prop, per, vin] = await Promise.all(['propiedades', 'personas', 'vinculos'].map(leerTodo));
      const m = armarComodatos({ prop, per, vin }, hoy, !!(q('prueba') || q('ver')));
      if (!m) return Response.json({ ok: true, tipo, hoy, enviado: false, motivo: 'Hoy no hay comodatos a 3 meses de vencer' });
      if (q('prueba')) m.asunto = '[PRUEBA] ' + m.asunto;
      if (q('ver')) return new Response(m.html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      const dest = ENV('COMODATOS_DESTINATARIOS', 'jsegal@amia.org.ar, ygrosman@amia.org.ar').split(/[,;\s]+/).filter(Boolean);
      const via = await enviar(m, dest);
      return Response.json({ ok: true, tipo, hoy, enviado: true, cantidad: m.cantidad, asunto: asciiAsunto(m.asunto), destinatarios: dest, via });
    }
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
