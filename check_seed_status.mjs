#!/usr/bin/env node
// Applify — Check seed status (read-only). Loads env from backend/.env via caller,
// connects to Supabase Admin API, counts auth users + demo users.
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }

const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (error) { console.error("listUsers error:", error.message); process.exit(1); }

const users = data.users || [];
const demo = users.filter((u) => u.email && /^\d{3}@example\.com$/.test(u.email.split("@")[0])) ;
const demoMail = users.filter((u) => u.email && u.email.endsWith("@example.com"));

console.log("total auth users:", users.length);
console.log("users with @example.com domain:", demoMail.length);
if (demoMail.length > 0) {
  const emails = demoMail.map((u) => u.email).slice(0, 8);
  console.log("sample:", emails.join(", "));
}
