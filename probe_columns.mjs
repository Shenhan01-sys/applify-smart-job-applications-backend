#!/usr/bin/env node
// Applify - probe live DB: for each table, try select(*) limit 1 and print the
// actual column names (if any row exists) or the PGRST error (schema-cache miss).
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const tables = ["profiles", "work_experiences", "education", "user_skills", "user_automation_settings", "subscriptions"];
for (const t of tables) {
  const { data, error } = await admin.from(t).select("*").limit(1);
  if (error) { console.log(`[${t}] select error: ${error.message}`); continue; }
  const keys = data && data[0] ? Object.keys(data[0]).join(", ") : "(empty table)";
  console.log(`[${t}] cols: ${keys}`);
}
