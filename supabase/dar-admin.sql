-- Dar rol de administrador (puede aprobar presupuestos, editar y borrar). Cambiá el correo si hace falta.
update perfiles set rol = 'admin'
where user_id = (select id from auth.users where email = 'ygrosman@amia.org.ar');

-- Control: tiene que figurar 'admin' al lado de cada correo
select u.email, p.rol from perfiles p join auth.users u on u.id = p.user_id order by p.rol, u.email;
