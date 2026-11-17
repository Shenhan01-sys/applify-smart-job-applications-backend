#!/usr/bin/env node
// Applify - delete one demo auth user by email (read config from env). Usage: node delete_demo_user.mjs user001@example.com
import { createClient } from "@supabase/supabase-js";

const email = process.argv[2] || "user001@example.com";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (error) { console.error("listUsers error:", error.message); process.exit(1); }
const u = (data.users || []).find((x) => x.email === email);
if (!u) { console.log("not found:", email); process.exit(0); }
const { error: de } = await admin.auth.admin.deleteUser(u.id);
console.log(de ? "delete error: " + de.message : "deleted " + email + " (id " + u.id + ")");
