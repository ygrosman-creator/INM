// Supabase Edge Function "usuarios" · INMUEBLES AMIA
// Deja que un ADMIN cree y administre usuarios desde la página (pantalla "Usuarios").
// Acciones (POST, cuerpo JSON {accion, ...}):
//   listar                       -> usuarios con su rol, último ingreso y si están dados de baja
//   crear  {email, rol, clave}   -> crea el usuario (ya confirmado) con una contraseña provisoria
//   clave  {id, clave}           -> le pone una contraseña provisoria nueva
//   baja   {id} / alta {id}      -> no puede entrar más / vuelve a poder entrar
// Con contraseña provisoria, al entrar la página le pide elegir una propia.
// Publicar: Edge Functions -> Deploy a new function -> nombre "usuarios" -> pegar este archivo -> Deploy.
// Después, en Details de la función, apagar "Verify JWT" (la función revisa sola que quien llama sea admin).
// No necesita secretos: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los pone Supabase.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { ...CORS, 'Content-Type': 'application/json' } });
const ROLES = ['admin', 'editor', 'lector', 'solicitante', 'lector_solicitante'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const URL = Deno.env.get('SUPABASE_URL')!, KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
    const api = async (path: string, init: RequestInit = {}) => {
      const r = await fetch(URL + path, { ...init, headers: { ...H, ...(init.headers || {}) } });
      const t = await r.text();
      let d: any = null; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
      if (!r.ok) throw new Error((d && (d.msg || d.message || d.error_description || d.error)) || ('Error ' + r.status));
      return d;
    };

    // ¿Quién llama? Tiene que ser un usuario con rol admin
    const tok = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const me = await fetch(URL + '/auth/v1/user', { headers: { apikey: KEY, Authorization: 'Bearer ' + tok } });
    if (!me.ok) return json({ error: 'Tenés que haber ingresado a la página.' });
    const yo = await me.json();
    const pr = await api(`/rest/v1/perfiles?user_id=eq.${yo.id}&select=rol`);
    if (!pr || !pr[0] || pr[0].rol !== 'admin') return json({ error: 'Solo un administrador puede administrar usuarios.' });

    const b = await req.json().catch(() => ({}));
    const acc = String(b.accion || '');
    const clave = String(b.clave || '');
    const id = String(b.id || '');

    if (acc === 'listar') {
      const us: any[] = [];
      for (let page = 1; page < 50; page++) {
        const d = await api(`/auth/v1/admin/users?page=${page}&per_page=200`);
        const l = (d && d.users) || [];
        us.push(...l);
        if (l.length < 200) break;
      }
      const perf = await api('/rest/v1/perfiles?select=user_id,rol');
      const rol = new Map((perf || []).map((p: any) => [p.user_id, p.rol]));
      return json({ ok: true, usuarios: us.map((u) => ({
        id: u.id, email: u.email, rol: rol.get(u.id) || '', ultimo: u.last_sign_in_at || null, creado: u.created_at,
        baja: !!(u.banned_until && new Date(u.banned_until) > new Date()),
        provisoria: !!(u.user_metadata && u.user_metadata.debe_cambiar_clave),
      })) });
    }

    if (acc === 'crear') {
      const email = String(b.email || '').trim().toLowerCase();
      const r = ROLES.includes(b.rol) ? b.rol : 'solicitante';
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'El mail no es válido.' });
      if (clave.length < 8) return json({ error: 'La contraseña provisoria tiene que tener al menos 8 caracteres.' });
      let u: any;
      try {
        u = await api('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, password: clave, email_confirm: true, user_metadata: { debe_cambiar_clave: true } }) });
      } catch (e) {
        const m = String((e as Error).message || '');
        return json({ error: /already|registered|exists/i.test(m) ? 'Ya existe un usuario con ese mail.' : m });
      }
      const uid = u.id || (u.user && u.user.id);
      // El perfil lo crea la base sola (como solicitante); acá se le pone el rol elegido
      await api('/rest/v1/perfiles?on_conflict=user_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ user_id: uid, rol: r, email }) });
      return json({ ok: true, id: uid });
    }

    if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: 'Falta el usuario.' });

    if (acc === 'clave') {
      if (clave.length < 8) return json({ error: 'La contraseña provisoria tiene que tener al menos 8 caracteres.' });
      await api('/auth/v1/admin/users/' + id, { method: 'PUT', body: JSON.stringify({ password: clave, user_metadata: { debe_cambiar_clave: true } }) });
      return json({ ok: true });
    }

    if (acc === 'baja' || acc === 'alta') {
      if (id === yo.id) return json({ error: 'No podés darte de baja a vos mismo.' });
      await api('/auth/v1/admin/users/' + id, { method: 'PUT', body: JSON.stringify({ ban_duration: acc === 'baja' ? '876000h' : 'none' }) });
      return json({ ok: true });
    }

    return json({ error: 'Acción desconocida.' });
  } catch (e) {
    return json({ error: String((e as Error).message || e) });
  }
});
