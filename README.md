# Inmuebles | Reparaciones y Mantenimiento — Vercel + Supabase

## 1. Supabase
1. Creá un proyecto en supabase.com.
2. SQL Editor → pegá y ejecutá todo `supabase/schema.sql`.
3. Authentication → Users → **Add user** (correo + contraseña) para cada persona del equipo.
   Authentication → Sign In / Providers → desactivá “Allow new users to sign up”.
4. Hacé admin a quien apruebe presupuestos (SQL Editor): ver la última línea de `schema.sql`.
   Roles: `admin` (edita y aprueba), `editor` (edita), `lector` (solo consulta; es el rol por defecto).
5. Project Settings → API: copiá **Project URL** y la **anon public key**.

## 2. Configuración
Editá `config.js` con esa URL y esa key.

## 3. Vercel
- Subí esta carpeta a un repositorio de GitHub → Vercel → Add New Project → importalo.
  Framework Preset: **Other**, sin comando de build, directorio raíz = esta carpeta.
- O con la CLI: `npm i -g vercel` y `vercel --prod` dentro de la carpeta.

## Notas
- Los adjuntos van a un bucket privado (`adjuntos`); los enlaces se firman por 2 minutos al hacer clic.
- Las vistas previas de imágenes no se muestran (el bucket es privado); se abren desde el enlace.
- Backup: Supabase → Database → Backups, o exportá cada tabla a CSV desde Table Editor.
