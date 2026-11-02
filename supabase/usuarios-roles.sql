-- Roles de usuarios. ANTES hay que crear los usuarios que falten en Supabase:
--   Authentication -> Users -> Add user -> Create new user (correo + contraseña, tildar "Auto Confirm User")
--   Hacelo para nalgaze@amia.org.ar y valfie@amia.org.ar. Los usuarios nuevos arrancan como "lector".
-- Roles: admin = edita, borra y aprueba presupuestos · editor = edita y borra, no aprueba · lector = solo consulta.

update perfiles set rol = 'admin'  where user_id in (select id from auth.users where email in ('ygrosman@amia.org.ar','jsegal@amia.org.ar'));
update perfiles set rol = 'editor' where user_id in (select id from auth.users where email = 'nalgaze@amia.org.ar');
update perfiles set rol = 'lector' where user_id in (select id from auth.users where email = 'valfie@amia.org.ar');

-- Control: tiene que figurar cada correo con el rol que corresponde
select u.email, p.rol from perfiles p join auth.users u on u.id = p.user_id order by p.rol, u.email;
